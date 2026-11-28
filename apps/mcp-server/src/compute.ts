import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { COMPUTE_WORKLOAD_KINDS } from '../../../packages/contracts/src/compute.js';

export interface ComputeMcpOptions {
  apiUrl: string;
  operatorToken: string;
  fetchImpl?: typeof fetch;
  redact?: (value: string) => string;
  /** Agent profile: release approval and publication tools are not registered. */
  agent?: boolean;
}

const TOOL_ERROR = 'HIVEMIND 컴퓨팅 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
const jobId = z.string().regex(/^(?:cmp|mf)-[0-9a-f-]{36}$/);
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
const hex40 = z.string().regex(/^[a-f0-9]{40}$/i);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/i);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerComputeOperatorTools(server: McpServer, options: ComputeMcpOptions): void {
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

  server.registerTool(
    'hivemind_compute_list',
    {
      title: 'HIVEMIND Spot 컴퓨팅 작업 목록',
      description: 'EC2 Spot CPU/GPU 컴퓨팅·학습·데이터 구축·평가 작업 목록과 대기 사유(waitReason)를 조회합니다.',
      inputSchema: z.strictObject({ projectId: projectIdSchema.optional() }),
      annotations: readOnly,
    },
    async ({ projectId }, extra) =>
      run(() => api(projectId ? `/api/compute/jobs?projectId=${encodeURIComponent(projectId)}` : '/api/compute/jobs', extra.signal)),
  );

  server.registerTool(
    'hivemind_compute_get',
    {
      title: 'HIVEMIND Spot 컴퓨팅 작업 상세',
      description: '작업의 소속 프로젝트, EC2 스팟 상태, TTL 만료 시각, 비용 예약/정산, S3 영수증 및 공개 상태를 조회합니다.',
      inputSchema: z.strictObject({ jobId }),
      annotations: readOnly,
    },
    async ({ jobId: id }, extra) => run(() => api(`/api/compute/jobs/${encodeURIComponent(id)}`, extra.signal)),
  );

  server.registerTool(
    'hivemind_compute_ledger',
    {
      title: 'HIVEMIND 컴퓨팅 비용 원장',
      description: '호스트 전역 및 프로젝트별 예산 상한, 예약 중 비용, 정산 완료 비용 및 잔여 예산을 조회합니다.',
      inputSchema: z.strictObject({ projectId: projectIdSchema.optional() }),
      annotations: readOnly,
    },
    async ({ projectId }, extra) =>
      run(() => api(projectId ? `/api/compute/ledger?projectId=${encodeURIComponent(projectId)}` : '/api/compute/ledger', extra.signal)),
  );

  server.registerTool(
    'hivemind_compute_wake',
    {
      title: 'HIVEMIND Spot 컴퓨팅 작업 점검',
      description:
        '실행 인스턴스의 현재 상태를 즉시 확인합니다. 인스턴스가 종료되었으면 비용을 정산하고 S3 영수증을 확인해 다음 단계로 넘깁니다.',
      inputSchema: z.strictObject({ jobId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ jobId: id }, extra) => run(() => api(`/api/compute/jobs/${encodeURIComponent(id)}/wake`, extra.signal, {})),
  );

  server.registerTool(
    'hivemind_compute_create',
    {
      title: 'HIVEMIND Spot 컴퓨팅 작업 초안 등록',
      description: '프로젝트별 S3 접두사, 동적 AMI·인스턴스 타입·최대 수명·비용 상한과 공개 정책으로 Spot 컴퓨팅 작업 초안만 등록합니다.',
      inputSchema: z.strictObject({
        projectId: projectIdSchema.optional(),
        title: z.string().trim().min(1).max(160),
        workloadId: z.string().trim().min(1).max(120),
        workloadKind: z.enum(COMPUTE_WORKLOAD_KINDS).optional(),
        repository: z.string().trim().min(3).max(200),
        baseCommit: hex40,
        compute: z.strictObject({
          region: z.string().min(4).max(32),
          candidateRegions: z.array(z.string().min(4).max(32)).min(1).max(8).optional(),
          regionOverrides: z
            .record(
              z.string().min(4).max(32),
              z.strictObject({
                amiId: z.string().regex(/^ami-[a-f0-9]{8,17}$/i).optional(),
                subnetIds: z.array(z.string().regex(/^subnet-[a-f0-9]{8,17}$/i)).min(1).max(8).optional(),
                securityGroupIds: z.array(z.string().regex(/^sg-[a-f0-9]{8,17}$/i)).min(1).max(5).optional(),
              }),
            )
            .optional(),
          availabilityZoneId: z.string().min(4).max(24).optional(),
          instanceType: z.string().min(3).max(40),
          amiId: z.string().regex(/^ami-[a-f0-9]{8,17}$/i),
          maxLifetimeMs: z.number().int().min(60_000).max(604_800_000),
          maxHourlyPriceUsd: z.number().positive().max(200),
          maxTotalCostMicros: z.number().int().min(1).max(10_000_000_000),
          workloadClass: z.string().min(1).max(64).optional(),
          subnetId: z.string().regex(/^subnet-[a-f0-9]{8,17}$/i).optional(),
          securityGroupIds: z.array(z.string().regex(/^sg-[a-f0-9]{8,17}$/i)).min(1).max(5).optional(),
          instanceProfileArn: z.string().min(20).max(256).optional(),
          userDataScript: z.string().max(16_384).optional(),
          rootVolumeGb: z.number().int().min(8).max(2000).optional(),
          s3ArtifactPrefix: z.string().min(1).max(512),
          inputs: z
            .strictObject({
              s3Prefix: z.string().min(1).max(512),
              digest: hex64.optional(),
              files: z
                .array(
                  z.strictObject({
                    path: z.string().min(1).max(512),
                    sha256: hex64,
                    sizeBytes: z.number().int().min(1).max(50_000_000_000),
                  }),
                )
                .min(1)
                .max(1000),
            })
            .optional(),
        }),
        releasePolicy: z.strictObject({
          mode: z.enum(['hf_release', 's3_artifact_only']),
          hfRepository: z.string().min(3).max(200).optional(),
          hfRevision: z.string().min(1).max(120).optional(),
          visibility: z.enum(['private', 'public']),
          releaseCheckCommand: z.array(z.string().min(1).max(1000)).min(1).max(32),
          autoPublish: z.literal(true).optional(),
        }),
      }),
      annotations: mutation,
    },
    async (args, extra) =>
      run(async () => ({
        job: await api('/api/compute/jobs', extra.signal, args),
        launchApproved: false,
      })),
  );

  server.registerTool(
    'hivemind_compute_request_approval',
    {
      title: 'HIVEMIND 컴퓨팅 정책 기반 승인 요청 (자동/수동 판단)',
      description:
        '프로젝트의 승인 정책(approvalPolicy)에 따라 중앙 Control Plane이 자동 승인 또는 수동 승인 요청을 판단하고 건별 근거를 기록합니다. 자동 승인 기준을 모두 충족하고 에이전트가 수동 검토를 요청하지 않으면 즉시 기동합니다.',
      inputSchema: z.strictObject({
        jobId,
        approvalFingerprint: hex64,
        recommendedOutcome: z.enum(['auto_approved', 'manual_approval_required']).optional(),
        rationale: z.string().trim().min(1).max(1000).optional(),
      }),
      annotations: mutation,
    },
    async ({ jobId: id, approvalFingerprint, recommendedOutcome, rationale }, extra) =>
      run(() =>
        api(`/api/compute/jobs/${encodeURIComponent(id)}/request-approval`, extra.signal, {
          approvalFingerprint,
          ...(recommendedOutcome ? { recommendedOutcome } : {}),
          ...(rationale ? { rationale } : {}),
        }),
      ),
  );

  server.registerTool(
    'hivemind_compute_approve',
    {
      title: 'HIVEMIND Spot 컴퓨팅 실행 승인 및 기동',
      description: '사용자의 명시적 지시에 따라 approvalFingerprint로 예산을 예약하고 EC2 스팟 인스턴스를 기동합니다.',
      inputSchema: z.strictObject({
        jobId,
        approvalFingerprint: hex64,
        reason: z.string().trim().min(1).max(1000),
      }),
      annotations: mutation,
    },
    async ({ jobId: id, approvalFingerprint, reason }, extra) =>
      run(() =>
        api(`/api/compute/jobs/${encodeURIComponent(id)}/approve`, extra.signal, {
          approvalFingerprint,
          reason,
        }),
      ),
  );

  server.registerTool(
    'hivemind_compute_dispatch_verifier',
    {
      title: 'HIVEMIND Spot 컴퓨팅 독립 검증기 실행',
      description: 'S3 영수증이 확인된 작업에 독립 검증기(Fargate Spot)를 기동합니다. 과금 자원을 만들므로 명시적 지시가 있을 때만 호출하세요.',
      inputSchema: z.strictObject({ jobId }),
      annotations: { ...mutation, openWorldHint: true },
    },
    async ({ jobId: id }, extra) =>
      run(() => api(`/api/compute/jobs/${encodeURIComponent(id)}/dispatch-verifier`, extra.signal, {})),
  );

  if (!options.agent) server.registerTool(
    'hivemind_compute_approve_release',
    {
      title: 'HIVEMIND 컴퓨팅 산출물 공개 승인/반려',
      description: '검증을 통과한 산출물의 Hugging Face 또는 S3 공개를 승인하거나 반려합니다.',
      inputSchema: z.strictObject({
        jobId,
        decision: z.enum(['approve', 'reject']),
        openedRawArtifacts: z.boolean(),
        durationMinutes: z.number().min(0).max(10_080),
        reason: z.string().trim().min(1).max(2000),
      }),
      annotations: mutation,
    },
    async ({ jobId: id, ...body }, extra) =>
      run(() => api(`/api/compute/jobs/${encodeURIComponent(id)}/approve-release`, extra.signal, body)),
  );

  if (!options.agent) server.registerTool(
    'hivemind_compute_publish_release',
    {
      title: 'HIVEMIND 컴퓨팅 산출물 공개 다시 시도',
      description: '승인되었지만(release_approved) 게시에 실패한 작업을 다시 게시합니다.',
      inputSchema: z.strictObject({ jobId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ jobId: id }, extra) => run(() => api(`/api/compute/jobs/${encodeURIComponent(id)}/publish-release`, extra.signal, {})),
  );

  server.registerTool(
    'hivemind_compute_cancel',
    {
      title: 'HIVEMIND Spot 컴퓨팅 작업 중단',
      description: '사용자의 명시적 지시에 따라 컴퓨팅 작업을 중단하고 실행 중인 EC2 스팟 인스턴스를 종료합니다.',
      inputSchema: z.strictObject({
        jobId,
        reason: z.string().trim().min(1).max(1000),
      }),
      annotations: { ...mutation, destructiveHint: true },
    },
    async ({ jobId: id, reason }, extra) =>
      run(() => api(`/api/compute/jobs/${encodeURIComponent(id)}/cancel`, extra.signal, { reason })),
  );
}
