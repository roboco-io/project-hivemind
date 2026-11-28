import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  PROJECT_CAPABILITIES,
  PROJECT_CREDENTIAL_PURPOSES,
  PROJECT_STATUSES,
  PROJECT_TEMPLATES,
} from '../../../packages/contracts/src/projects.js';

export interface ProjectsMcpOptions {
  apiUrl: string;
  operatorToken: string;
  fetchImpl?: typeof fetch;
  redact?: (value: string) => string;
  /** Project-agent mode: exposes only self-inspection (hivemind_project_me). */
  agent?: boolean;
}

const TOOL_ERROR = 'HIVEMIND 프로젝트 요청을 처리하지 못했습니다. 연결·권한·입력과 프로젝트 상태를 확인하세요.';
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerProjectOperatorTools(server: McpServer, options: ProjectsMcpOptions): void {
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

  async function api(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 65_536) throw new Error(TOOL_ERROR);
    const response = await fetchImpl(new URL(path, options.apiUrl), {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.operatorToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(encoded === undefined ? {} : { body: encoded }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
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

  if (options.agent) {
    server.registerTool(
      'hivemind_project_me',
      {
        title: 'HIVEMIND 현재 프로젝트 정보 조회',
        description: '현재 에이전트 토큰이 소속된 호스트 프로젝트의 정책, 허용 저장소·리전·S3 접두사 및 잔여 예산을 조회합니다.',
        inputSchema: z.strictObject({}),
        annotations: readOnly,
      },
      async (_args, extra) => run(() => api('GET', '/api/projects/me', extra.signal)),
    );
    return;
  }

  server.registerTool(
    'hivemind_project_list',
    {
      title: 'HIVEMIND 호스트 프로젝트 목록',
      description: 'HIVEMIND 인프라 호스트 위에 등록된 모든 프로젝트의 상태, 기능 권한, 예산 상한과 저장소 목록을 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async (_args, extra) => run(() => api('GET', '/api/projects', extra.signal)),
  );

  server.registerTool(
    'hivemind_project_get',
    {
      title: 'HIVEMIND 호스트 프로젝트 상세',
      description: '프로젝트 매니페스트, 발급된 토큰 메타데이터(비밀 미포함), 컴퓨팅 예산 원장 및 서브시스템 작업 건수를 조회합니다.',
      inputSchema: z.strictObject({ projectId: projectIdSchema }),
      annotations: readOnly,
    },
    async ({ projectId }, extra) => run(() => api('GET', `/api/projects/${encodeURIComponent(projectId)}`, extra.signal)),
  );

  server.registerTool(
    'hivemind_project_register',
    {
      title: 'HIVEMIND 호스트 프로젝트 등록',
      description: 'HIVEMIND 호스트에 새 프로젝트를 등록합니다. 템플릿(generic, model-factory, sw-delivery, research-collab)으로 기본 정책을 채울 수 있습니다.',
      inputSchema: z.strictObject({
        id: projectIdSchema,
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000).optional(),
        template: z.enum(PROJECT_TEMPLATES).optional(),
        capabilities: z.array(z.enum(PROJECT_CAPABILITIES)).optional(),
        budget: z
          .strictObject({
            computeBudgetCapMicros: z.number().int().min(0).max(10_000_000_000).optional(),
            maxSingleJobCostMicros: z.number().int().min(1).max(10_000_000_000).nullable().optional(),
            maxDeliveryTaskBudgetMicros: z.number().int().min(0).max(1_000_000_000).optional(),
          })
          .optional(),
        delivery: z
          .strictObject({
            repositories: z.array(z.string().min(3).max(200)).max(32).optional(),
            autoMergeRepositories: z.array(z.string().min(3).max(200)).max(32).optional(),
            defaultBranchPrefix: z.string().min(1).max(64).optional(),
            defaultProtectedPaths: z.array(z.string().min(1).max(256)).max(64).optional(),
            allowAgentAccess: z.boolean().optional(),
            allowedWebHosts: z.array(z.string().min(3).max(253)).max(32).optional(),
          })
          .optional(),
        compute: z
          .strictObject({
            allowedRegions: z.array(z.string().min(4).max(32)).min(1).max(12).optional(),
            s3ArtifactPrefixes: z.array(z.string().min(2).max(256)).min(1).max(16).optional(),
            autoPublishHfRepoPrefixes: z.array(z.string().min(2).max(120)).max(16).optional(),
            credentialPurposes: z.array(z.enum(PROJECT_CREDENTIAL_PURPOSES)).optional(),
            maxLifetimeMs: z.number().int().min(60_000).max(604_800_000).optional(),
          })
          .optional(),
        notificationChannel: z.string().max(256).nullable().optional(),
      }),
      annotations: mutation,
    },
    async (args, extra) => run(() => api('POST', '/api/projects', extra.signal, args)),
  );

  server.registerTool(
    'hivemind_project_set_status',
    {
      title: 'HIVEMIND 프로젝트 상태 전환',
      description: '프로젝트를 active, paused(실행·토큰 인증 일시 정지), 또는 archived 상태로 변경합니다.',
      inputSchema: z.strictObject({
        projectId: projectIdSchema,
        status: z.enum(PROJECT_STATUSES),
      }),
      annotations: mutation,
    },
    async ({ projectId, status }, extra) =>
      run(() => api('PATCH', `/api/projects/${encodeURIComponent(projectId)}`, extra.signal, { status })),
  );
}
