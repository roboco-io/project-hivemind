import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface ModelFactoryMcpOptions {
  apiUrl: string;
  operatorToken: string;
  fetchImpl?: typeof fetch;
  redact?: (value: string) => string;
}

const TOOL_ERROR = 'HIVEMIND 모델 팩토리 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
const jobId = z.string().regex(/^mf-[0-9a-f-]{36}$/);
const hex40 = z.string().regex(/^[a-f0-9]{40}$/i);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/i);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerModelFactoryOperatorTools(server: McpServer, options: ModelFactoryMcpOptions): void {
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
    'hivemind_mf_list',
    {
      title: 'HIVEMIND 모델 팩토리 작업 목록',
      description: 'GPU 스팟 학습·평가·공개 작업 목록과 대기 사유(waitReason)를 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async (_args, extra) => run(() => api('/api/model-factory/jobs', extra.signal)),
  );

  server.registerTool(
    'hivemind_mf_get',
    {
      title: 'HIVEMIND 모델 팩토리 작업 상세',
      description: '작업의 EC2 스팟 상태, TTL 만료 시각, 비용 예약/정산, S3 영수증 및 공개 상태를 조회합니다.',
      inputSchema: z.strictObject({ jobId }),
      annotations: readOnly,
    },
    async ({ jobId: id }, extra) => run(() => api(`/api/model-factory/jobs/${encodeURIComponent(id)}`, extra.signal)),
  );

  server.registerTool(
    'hivemind_mf_ledger',
    {
      title: 'HIVEMIND 모델 팩토리 비용 원장',
      description: '전역 예산 상한, 예약 중 비용, 정산 완료 비용 및 잔여 예산을 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async (_args, extra) => run(() => api('/api/model-factory/ledger', extra.signal)),
  );

  server.registerTool(
    'hivemind_mf_create',
    {
      title: 'HIVEMIND 모델 팩토리 학습 작업 초안 등록',
      description: '동적 AMI·인스턴스 타입·최대 수명·비용 상한과 공개 정책으로 학습 초안만 등록합니다. 스팟 용량이 없을 때를 대비해 compute.candidateRegions에 다른 리전을 적을 수 있고, AMI는 리전마다 다르므로 그 리전의 AMI를 compute.regionOverrides에 적습니다.',
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(160),
        modelId: z.string().trim().min(1).max(120),
        repository: z.string().trim().min(3).max(200),
        baseCommit: hex40,
        compute: z.strictObject({
          region: z.string().min(4).max(32),
          // Other regions the Control Plane may try, in Spot placement score order, when `region` has no capacity.
          candidateRegions: z.array(z.string().min(4).max(32)).min(1).max(8).optional(),
          // Per-region AMI, subnets and security groups. An AMI ID is valid in one region only.
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
        }),
      }),
      annotations: mutation,
    },
    async (args, extra) =>
      run(async () => ({
        job: await api('/api/model-factory/jobs', extra.signal, args),
        trainingApproved: false,
      })),
  );

  server.registerTool(
    'hivemind_mf_approve_training',
    {
      title: 'HIVEMIND 모델 팩토리 학습 승인 및 스팟 기동',
      description: '사용자의 명시적 지시에 따라 approvalFingerprint로 예산을 예약하고 EC2 스팟을 기동합니다.',
      inputSchema: z.strictObject({
        jobId,
        approvalFingerprint: hex64,
        reason: z.string().trim().min(1).max(1000),
      }),
      annotations: mutation,
    },
    async ({ jobId: id, approvalFingerprint, reason }, extra) =>
      run(() =>
        api(`/api/model-factory/jobs/${encodeURIComponent(id)}/approve-training`, extra.signal, {
          approvalFingerprint,
          reason,
        }),
      ),
  );

  server.registerTool(
    'hivemind_mf_dispatch_verifier',
    {
      title: 'HIVEMIND 모델 팩토리 독립 검증기 실행',
      description:
        'S3 영수증이 확인된 작업에 독립 검증기 작업(Fargate Spot)을 기동합니다. 검증기는 산출물과 고정 입력의 해시를 확인하고 승인된 releaseCheckCommand를 실행한 뒤 결과를 직접 보고합니다. 이 결과는 independent_verifier로 기록됩니다. 과금 자원을 만들므로 사용자의 명시적 지시가 있을 때만 호출하세요.',
      inputSchema: z.strictObject({ jobId }),
      annotations: { ...mutation, openWorldHint: true },
    },
    async ({ jobId: id }, extra) =>
      run(() => api(`/api/model-factory/jobs/${encodeURIComponent(id)}/dispatch-verifier`, extra.signal, {})),
  );

  server.registerTool(
    'hivemind_mf_approve_release',
    {
      title: 'HIVEMIND 모델 팩토리 공개 승인/반려',
      description: '검증을 통과한 모델의 Hugging Face 또는 S3 공개를 승인하거나 반려합니다.',
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
      run(() => api(`/api/model-factory/jobs/${encodeURIComponent(id)}/approve-release`, extra.signal, body)),
  );

  server.registerTool(
    'hivemind_mf_cancel',
    {
      title: 'HIVEMIND 모델 팩토리 작업 중단',
      description: '사용자의 명시적 지시에 따라 학습 작업을 중단하고 실행 중인 EC2 스팟 인스턴스를 종료합니다.',
      inputSchema: z.strictObject({
        jobId,
        reason: z.string().trim().min(1).max(1000),
      }),
      annotations: { ...mutation, destructiveHint: true },
    },
    async ({ jobId: id, reason }, extra) =>
      run(() => api(`/api/model-factory/jobs/${encodeURIComponent(id)}/cancel`, extra.signal, { reason })),
  );
}
