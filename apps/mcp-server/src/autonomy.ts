import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const TOOL_ERROR = 'HIVEMIND 자율 트리거 요청을 처리하지 못했습니다. 연결·권한과 입력을 확인하세요.';
const triggerId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

/** MCP tools for the periodic autonomy triggers (issue #20). The agent profile gets the read tool only. */
export function registerAutonomyTools(server: McpServer, options: { apiUrl: string; operatorToken: string; fetchImpl?: typeof fetch; readOnly?: boolean }): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, signal: AbortSignal, body?: unknown): Promise<CallToolResult> {
    try {
      const response = await fetchImpl(new URL(path, options.apiUrl), {
        method,
        redirect: 'error',
        headers: { authorization: `Bearer ${options.operatorToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(250_000)]),
      });
      const parsed = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const refusal = { ok: false, httpStatus: response.status, error: typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : TOOL_ERROR };
        return { content: [{ type: 'text', text: JSON.stringify(refusal) }], structuredContent: refusal };
      }
      return { content: [{ type: 'text', text: JSON.stringify(parsed) }], structuredContent: parsed };
    } catch {
      return { isError: true, content: [{ type: 'text', text: TOOL_ERROR }] };
    }
  }

  server.registerTool(
    'hivemind_autonomy_triggers',
    {
      title: 'HIVEMIND 자율 트리거 조회',
      description: '저장소별 주기 트리거(다음 단계 작업을 정해진 간격으로 클라우드 워커에 보내는 설정)의 설정, 켜짐 여부, 마지막 발송 작업, 건너뛴 이유와 최근 이벤트를 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args, extra) => call('GET', '/api/autonomy/triggers', extra.signal),
  );
  if (options.readOnly) return;

  server.registerTool(
    'hivemind_autonomy_trigger_configure',
    {
      title: 'HIVEMIND 자율 트리거 설정',
      description: '주기 트리거를 만들거나 설정을 바꿉니다. 새 트리거는 꺼진 상태로 만들어집니다. 트리거가 보내는 작업은 자동 병합(보호 경로 제외)과 에이전트 토큰 접근을 갖습니다.',
      inputSchema: z.strictObject({
        triggerId,
        repository: z.string().min(3).max(200),
        baseBranch: z.string().min(1).max(100),
        branchPrefix: z.string().min(2).max(100),
        title: z.string().trim().min(1).max(160),
        instructions: z.string().trim().min(1).max(12_000),
        provider: z.enum(['codex', 'claude']),
        intervalMinutes: z.number().int().min(5).max(10_080),
        maxIterations: z.number().int().min(1).max(5).optional(),
        maxIterationDurationMs: z.number().int().min(60_000).max(7_200_000).optional(),
        budgetMicros: z.number().int().min(0).max(1_000_000_000).optional(),
        protectedPaths: z.array(z.string().min(1).max(300)).min(1).max(64),
        testCommand: z.array(z.string().min(1).max(500)).min(1).max(16),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ triggerId: id, ...config }, extra) => call('PUT', `/api/autonomy/triggers/${id}`, extra.signal, config),
  );
  server.registerTool(
    'hivemind_autonomy_trigger_enable',
    {
      title: 'HIVEMIND 자율 트리거 켜기',
      description: '주기 트리거를 켭니다. 켜진 트리거는 사람 확인 없이 클라우드 워커를 띄우고, 워커는 학습 작업과 자동 병합을 일으킬 수 있으므로 사용자가 명시적으로 지시했을 때만 호출합니다.',
      inputSchema: z.strictObject({ triggerId, reason: z.string().trim().min(1).max(1000) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ triggerId: id, reason }, extra) => call('POST', `/api/autonomy/triggers/${id}/enable`, extra.signal, { reason }),
  );
  server.registerTool(
    'hivemind_autonomy_trigger_disable',
    {
      title: 'HIVEMIND 자율 트리거 끄기',
      description: '주기 트리거를 끕니다. 이미 실행 중인 작업은 끝까지 진행되고, 새 작업은 보내지 않습니다.',
      inputSchema: z.strictObject({ triggerId, reason: z.string().trim().min(1).max(1000) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ triggerId: id, reason }, extra) => call('POST', `/api/autonomy/triggers/${id}/disable`, extra.signal, { reason }),
  );
}
