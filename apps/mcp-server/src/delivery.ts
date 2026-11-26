import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface DeliveryMcpOptions {
  apiUrl: string;
  operatorToken: string;
  fetchImpl?: typeof fetch;
  redact?: (value: string) => string;
}

const TOOL_ERROR = 'HIVEMIND 전달 작업 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
const taskId = z.string().regex(/^dlv-[0-9a-f-]{36}$/);
const hex40 = z.string().regex(/^[a-f0-9]{40}$/i);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/i);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerDeliveryOperatorTools(server: McpServer, options: DeliveryMcpOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const redact =
    options.redact ??
    ((text: string) =>
      text
        .replaceAll(options.operatorToken, '[REDACTED]')
        .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]'));

  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };

  async function api(path: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 131_072) throw new Error(TOOL_ERROR);
    const response = await fetchImpl(new URL(path, options.apiUrl), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.operatorToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(encoded === undefined ? {} : { body: encoded }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error(TOOL_ERROR);
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(TOOL_ERROR);
    return parsed as Record<string, unknown>;
  }

  async function run(work: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
    try {
      const output = scrub(await work()) as Record<string, unknown>;
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch {
      return { isError: true, content: [{ type: 'text', text: TOOL_ERROR }] };
    }
  }

  server.registerTool(
    'hivemind_delivery_list',
    {
      title: 'HIVEMIND SW 전달 작업 목록',
      description: 'AWS 단일 경로의 SW 개발 전달 작업 목록과 상태를 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async (_args, extra) => run(() => api('/api/delivery/tasks', extra.signal)),
  );

  server.registerTool(
    'hivemind_delivery_get',
    {
      title: 'HIVEMIND SW 전달 작업 상세',
      description: '작업의 고정 수용 테스트, 독립 검증 해시, Draft PR 링크 및 사람 판단 기록을 조회합니다.',
      inputSchema: z.strictObject({ taskId }),
      annotations: readOnly,
    },
    async ({ taskId: id }, extra) => run(() => api(`/api/delivery/tasks/${encodeURIComponent(id)}`, extra.signal)),
  );

  server.registerTool(
    'hivemind_delivery_create',
    {
      title: 'HIVEMIND SW 전달 작업 초안 등록',
      description: '불변 수용 테스트와 Draft PR 전달 정책으로 초안만 등록합니다. 자동 실행하거나 승인하지 않습니다.',
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(160),
        instructions: z.string().trim().min(1).max(12_000),
        provider: z.enum(['codex', 'claude']),
        maxIterations: z.number().int().min(1).max(10).default(3),
        budgetMicros: z.number().int().min(0).max(1_000_000_000),
        acceptance: z.strictObject({
          baseCommit: hex40,
          files: z.array(z.strictObject({ path: z.string().min(1).max(512), sha256: hex64 })).min(1).max(256),
          testCommand: z.array(z.string().min(1).max(1000)).min(1).max(32),
          digest: hex64.optional(),
        }),
        delivery: z.strictObject({
          mode: z.literal('draft_pr'),
          repository: z.string().min(3).max(200),
          baseBranch: z.string().min(1).max(120),
          branchPrefix: z.string().min(2).max(120),
          autoMerge: z.literal(false),
        }),
        bundle: z
          .strictObject({
            baseCommit: hex40,
            bundleSha256: hex64,
            sizeBytes: z.number().int().min(1).max(2_000_000_000),
            fileCount: z.number().int().min(1).max(500_000),
            s3Key: z.string().min(1).max(512).optional(),
          })
          .optional(),
        spot: z
          .strictObject({
            maxSpotRetries: z.number().int().min(0).max(5),
            checkpointFlushTimeoutMs: z.number().int().min(5_000).max(115_000),
          })
          .optional(),
        routing: z
          .strictObject({
            primaryRegion: z.string().min(4).max(32),
            allowedRegions: z.array(z.string().min(4).max(32)).min(1).max(16),
            workloadClass: z.string().min(1).max(64),
            minPlacementScore: z.number().int().min(1).max(10).optional(),
            maxHourlyPriceUsd: z.number().positive().max(1000).optional(),
            trendWindowHours: z.number().int().min(6).max(168).optional(),
          })
          .optional(),
        executionPolicy: z
          .strictObject({
            allowedWebHosts: z.array(z.string().min(3).max(253)).max(32).optional(),
            allowSubagents: z.boolean().optional(),
            maxIterationDurationMs: z.number().int().min(60_000).max(7_200_000).optional(),
            preserveWorkspaceOnRetry: z.boolean().optional(),
            verificationKind: z.enum(['code', 'document_format']).optional(),
          })
          .optional(),
      }),
      annotations: mutation,
    },
    async (args, extra) =>
      run(async () => ({
        task: await api('/api/delivery/tasks', extra.signal, args),
        executionApproved: false,
      })),
  );

  server.registerTool(
    'hivemind_delivery_approve',
    {
      title: 'HIVEMIND SW 전달 작업 승인',
      description: '사용자의 명시적 지시에 따라 표시된 approvalFingerprint로 전달 작업 실행을 승인합니다.',
      inputSchema: z.strictObject({
        taskId,
        approvalFingerprint: hex64,
        reason: z.string().trim().min(1).max(1000),
      }),
      annotations: mutation,
    },
    async ({ taskId: id, approvalFingerprint, reason }, extra) =>
      run(() =>
        api(`/api/delivery/tasks/${encodeURIComponent(id)}/approve`, extra.signal, {
          approvalFingerprint,
          reason,
        }),
      ),
  );

  server.registerTool(
    'hivemind_delivery_human_decision',
    {
      title: 'HIVEMIND 무검토 판단 기록',
      description: 'Draft PR에 대한 운영자의 승인/반려 결정과 diff 열람 여부(openedDiff), 판단 소요 시간(durationMinutes)을 기록합니다.',
      inputSchema: z.strictObject({
        taskId,
        decision: z.enum(['approve', 'reject']),
        openedDiff: z.boolean(),
        durationMinutes: z.number().min(0).max(10_080),
        reason: z.string().trim().min(1).max(2000),
        missingEvidence: z.string().trim().min(1).max(2000).optional(),
      }),
      annotations: mutation,
    },
    async ({ taskId: id, ...body }, extra) =>
      run(() => api(`/api/delivery/tasks/${encodeURIComponent(id)}/human-decision`, extra.signal, body)),
  );

  server.registerTool(
    'hivemind_delivery_cancel',
    {
      title: 'HIVEMIND SW 전달 작업 중단',
      description: '사용자의 명시적 지시에 따라 SW 전달 작업을 중단합니다.',
      inputSchema: z.strictObject({
        taskId,
        reason: z.string().trim().min(1).max(1000),
      }),
      annotations: { ...mutation, destructiveHint: true },
    },
    async ({ taskId: id, reason }, extra) =>
      run(() => api(`/api/delivery/tasks/${encodeURIComponent(id)}/cancel`, extra.signal, { reason })),
  );
}
