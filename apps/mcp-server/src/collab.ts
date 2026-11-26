import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface CollabMcpOptions {
  apiUrl: string;
  operatorToken: string;
  /**
   * Path of a local file that holds the operator's Claude/Codex auth secret. Only the embedded-orchestrator
   * tool reads it, at call time. The secret is never a tool input, so it never enters the model context.
   */
  localAuthFile?: string;
  fetchImpl?: typeof fetch;
  redact?: (value: string) => string;
}

const TOOL_ERROR = 'HIVEMIND 협업 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 세션 상태를 확인하세요.';
const AUTH_FILE_ERROR =
  'HIVEMIND 내장 오케스트레이터를 실행하지 못했습니다. MCP 서버 환경 변수 HIVEMIND_COLLAB_LOCAL_AUTH_FILE에 로컬 모델 인증 파일 경로를 설정했는지 확인하세요.';
const MAX_AUTH_FILE_BYTES = 60_000;

const sessionId = z.string().regex(/^ses-[0-9a-f-]{36}$/);
const subtaskId = z.string().regex(/^sub-[0-9a-f-]{36}$/);
const provider = z.enum(['claude', 'codex']);
const region = z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/);
const participant = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Starts billable ECS Fargate Spot tasks or a model run, so clients should confirm with the user first. */
const launches = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function readLocalAuthSecret(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUTH_FILE_BYTES) throw new Error(AUTH_FILE_ERROR);
    const secret = readFileSync(descriptor, 'utf8').trim();
    if (!secret) throw new Error(AUTH_FILE_ERROR);
    return secret;
  } finally {
    closeSync(descriptor);
  }
}

export function registerCollabOperatorTools(server: McpServer, options: CollabMcpOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseRedact =
    options.redact ??
    ((text: string) =>
      text.replaceAll(options.operatorToken, '[REDACTED]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]'));

  const scrubWith = (redact: (text: string) => string) => {
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') return redact(value);
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
      }
      return value;
    };
    return scrub;
  };

  async function api(
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 64_000) throw new Error(TOOL_ERROR);
    const response = await fetchImpl(new URL(path, options.apiUrl), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.operatorToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(encoded === undefined ? {} : { body: encoded }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error(TOOL_ERROR);
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(TOOL_ERROR);
    return parsed as Record<string, unknown>;
  }

  async function run(
    work: () => Promise<Record<string, unknown>>,
    extraSecrets: () => string[] = () => [],
  ): Promise<CallToolResult> {
    try {
      const result = await work();
      const secrets = extraSecrets().filter((s) => s.length > 0);
      const redact = (text: string) => secrets.reduce((acc, secret) => acc.replaceAll(secret, '[REDACTED]'), baseRedact(text));
      const output = scrubWith(redact)(result) as Record<string, unknown>;
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch {
      return { isError: true, content: [{ type: 'text', text: TOOL_ERROR }] };
    }
  }

  const sessionPath = (id: string, suffix = '') => `/api/collab/sessions/${encodeURIComponent(id)}${suffix}`;

  server.registerTool(
    'hivemind_collab_list',
    {
      title: 'HIVEMIND 협업 세션 목록',
      description: '병렬 에이전트 협업 세션 목록과 저장소 종류(Aurora DSQL 또는 SQLite)를 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async (_args, extra) => run(() => api('/api/collab/sessions', extra.signal)),
  );

  server.registerTool(
    'hivemind_collab_get',
    {
      title: 'HIVEMIND 협업 세션 상세',
      description: '세션의 하위 작업, 게시판 메시지, 작업 로그와 마지막 내장 오케스트레이터 실행 상태를 조회합니다.',
      inputSchema: z.strictObject({ sessionId }),
      annotations: readOnly,
    },
    async ({ sessionId: id }, extra) => run(() => api(sessionPath(id), extra.signal)),
  );

  server.registerTool(
    'hivemind_collab_create',
    {
      title: 'HIVEMIND 협업 세션 등록',
      description:
        '목표, 모델 제공자, 병렬 워커 상한과 허용 리전으로 협업 세션을 등록합니다. 등록만으로는 워커를 기동하지 않습니다.',
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(160),
        goal: z.string().trim().min(1).max(8000),
        provider,
        maxParallelWorkers: z.number().int().min(1).max(16).optional(),
        allowedRegions: z.array(region).min(1).max(5).optional(),
        repository: z.string().trim().min(3).max(200).optional(),
        baseCommit: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
      }),
      annotations: mutation,
    },
    async (args, extra) => run(() => api('/api/collab/sessions', extra.signal, args)),
  );

  server.registerTool(
    'hivemind_collab_add_subtask',
    {
      title: 'HIVEMIND 협업 하위 작업 추가',
      description: '세션에 하위 작업을 추가합니다. dependsOn에 적은 하위 작업이 모두 완료되어야 이 작업이 실행 대상이 됩니다.',
      inputSchema: z.strictObject({
        sessionId,
        title: z.string().trim().min(1).max(160),
        instructions: z.string().trim().min(1).max(16000),
        provider: provider.optional(),
        dependsOn: z.array(subtaskId).max(32).optional(),
        artifactS3Prefix: z.string().trim().min(1).max(512).optional(),
      }),
      annotations: mutation,
    },
    async ({ sessionId: id, ...body }, extra) => run(() => api(sessionPath(id, '/subtasks'), extra.signal, body)),
  );

  server.registerTool(
    'hivemind_collab_fan_out',
    {
      title: 'HIVEMIND 협업 병렬 워커 기동',
      description:
        '실행 준비가 된 하위 작업마다 ECS Fargate Spot 워커를 기동합니다. 과금되는 자원을 만들므로 사용자의 명시적 지시가 있을 때만 호출하세요.',
      inputSchema: z.strictObject({
        sessionId,
        workloadClass: z.string().trim().min(2).max(41).regex(/^[a-z0-9][a-z0-9.-]+$/).optional(),
      }),
      annotations: launches,
    },
    async ({ sessionId: id, workloadClass }, extra) =>
      run(() => api(sessionPath(id, '/fan-out'), extra.signal, workloadClass ? { workloadClass } : {}, 45_000)),
  );

  server.registerTool(
    'hivemind_collab_post_message',
    {
      title: 'HIVEMIND 협업 게시판 메시지 작성',
      description: '세션 게시판에 메시지를 남깁니다. recipient를 생략하면 세션 전체에 보이는 메시지입니다.',
      inputSchema: z.strictObject({
        sessionId,
        sender: participant,
        recipient: participant.optional(),
        threadId: z.string().trim().min(1).max(120).optional(),
        kind: z.enum(['chat', 'handoff', 'question', 'blocker', 'decision', 'artifact']).optional(),
        body: z.string().trim().min(1).max(16000),
        artifactRefs: z.array(z.string().trim().min(1).max(1024)).max(32).optional(),
      }),
      annotations: mutation,
    },
    async ({ sessionId: id, ...body }, extra) => run(() => api(sessionPath(id, '/messages'), extra.signal, body)),
  );

  server.registerTool(
    'hivemind_collab_list_messages',
    {
      title: 'HIVEMIND 협업 게시판 메시지 조회',
      description: '세션 게시판 메시지를 순번 순서로 조회합니다. afterSeq 이후의 메시지만 받을 수 있습니다.',
      inputSchema: z.strictObject({
        sessionId,
        afterSeq: z.number().int().min(0).optional(),
        recipient: participant.optional(),
        threadId: z.string().trim().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: readOnly,
    },
    async ({ sessionId: id, afterSeq, recipient, threadId, limit }, extra) => {
      const query = new URLSearchParams();
      if (afterSeq !== undefined) query.set('afterSeq', String(afterSeq));
      if (recipient) query.set('recipient', recipient);
      if (threadId) query.set('threadId', threadId);
      if (limit !== undefined) query.set('limit', String(limit));
      const suffix = query.size > 0 ? `/messages?${query.toString()}` : '/messages';
      return run(() => api(sessionPath(id, suffix), extra.signal));
    },
  );

  server.registerTool(
    'hivemind_collab_run_orchestrator',
    {
      title: 'HIVEMIND 내장 오케스트레이터 실행',
      description:
        'Control Plane 안에서 Claude 또는 Codex 오케스트레이터를 실행해 세션 목표를 하위 작업으로 나눕니다. 로컬 모델 인증은 MCP 서버가 설정된 파일에서 직접 읽어 전달하며 도구 입력으로 받지 않습니다. 실제 모델 호출이 발생하므로 사용자의 명시적 지시가 있을 때만 호출하세요.',
      inputSchema: z.strictObject({
        sessionId,
        provider: provider.optional(),
        model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
        prompt: z.string().trim().min(1).max(16000).optional(),
        timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
      }),
      annotations: launches,
    },
    async ({ sessionId: id, ...body }, extra) => {
      let secret = '';
      try {
        if (!options.localAuthFile) throw new Error(AUTH_FILE_ERROR);
        secret = readLocalAuthSecret(options.localAuthFile);
      } catch {
        // The server replaces every error result with one generic text, so a missing local configuration
        // is reported as a normal result. The text is fixed and holds no file content or path.
        const output = { started: false, reason: 'local_auth_file_unavailable', hint: AUTH_FILE_ERROR };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      }
      return run(
        async () => {
          const timeoutMs = body.timeoutMs ?? 600_000;
          return api(
            sessionPath(id, '/run-orchestrator'),
            extra.signal,
            { ...body, timeoutMs, localAuthSecret: secret },
            timeoutMs + 30_000,
          );
        },
        () => [secret],
      );
    },
  );
}
