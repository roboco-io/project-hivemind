import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface AwsStatusMcpOptions {
  apiUrl: string;
  operatorToken: string;
  fetchImpl?: typeof fetch;
  redact?: (value: string) => string;
}

const TOOL_ERROR = 'HIVEMIND 상태를 조회하지 못했습니다. 연결·권한과 Control Plane 기동 여부를 확인하세요.';

function countByStatus(items: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(items)) return counts;
  for (const item of items) {
    const status = (item as { status?: unknown } | null)?.status;
    if (typeof status === 'string' && status.length <= 64) counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/**
 * `hivemind_status` for the AWS single path: one read-only call that shows whether the Control Plane is
 * reachable with this operator token and what each store currently holds. It returns counts only, never
 * task instructions, model output or logs.
 */
export function registerAwsStatusTool(server: McpServer, options: AwsStatusMcpOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetchImpl(new URL(path, options.apiUrl), {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${options.operatorToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(TOOL_ERROR);
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(TOOL_ERROR);
    return parsed as Record<string, unknown>;
  }

  const backend = (value: unknown): string | null => (value === 'sqlite' || value === 'aurora-dsql' ? value : null);
  const micros = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  server.registerTool(
    'hivemind_status',
    {
      title: 'HIVEMIND AWS 관제 상태',
      description:
        'AWS Control Plane 연결과 운영자 인증을 확인하고, SW 전달 작업·Model Factory 작업·협업 세션의 저장소 종류와 상태별 건수, 남은 중앙 예산을 조회합니다.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args, extra): Promise<CallToolResult> => {
      try {
        const [delivery, jobs, ledger, collab] = await Promise.all([
          get('/api/delivery/tasks', extra.signal),
          get('/api/model-factory/jobs', extra.signal),
          get('/api/model-factory/ledger', extra.signal),
          get('/api/collab/sessions', extra.signal),
        ]);
        const output = {
          runtime: 'aws',
          connected: true,
          delivery: {
            storageBackend: backend(delivery.storageBackend),
            total: Array.isArray(delivery.tasks) ? delivery.tasks.length : 0,
            byStatus: countByStatus(delivery.tasks),
          },
          modelFactory: {
            storageBackend: backend(jobs.storageBackend),
            total: Array.isArray(jobs.jobs) ? jobs.jobs.length : 0,
            byStatus: countByStatus(jobs.jobs),
            globalBudgetCapMicros: micros(ledger.globalBudgetCapMicros),
            reservedMicros: micros(ledger.totalReservedMicros),
            settledMicros: micros(ledger.totalSettledMicros),
            remainingBudgetMicros: micros(ledger.remainingBudgetMicros),
          },
          collab: {
            storageBackend: backend(collab.storageBackend),
            total: Array.isArray(collab.sessions) ? collab.sessions.length : 0,
            byStatus: countByStatus(collab.sessions),
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch {
        return { isError: true, content: [{ type: 'text', text: TOOL_ERROR }] };
      }
    },
  );
}
