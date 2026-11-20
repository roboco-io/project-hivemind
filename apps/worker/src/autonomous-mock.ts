import { pathToFileURL } from 'node:url';
import { createAutonomousHttpClient, MemorySessionStore, runAutonomousIteration } from '../../../packages/adapters/src/autonomous-runner.js';
import type { AutonomousExecutor } from '../../../packages/adapters/src/autonomous-runner.js';
import type { AutonomousTask, AutonomousSpec } from '../../../packages/contracts/src/autonomous.js';

/** Explicit synthetic executor. Never launches a provider CLI or creates resources. */
export const mockAutonomousExecutor: AutonomousExecutor = async context => {
  context.signal.throwIfAborted();
  if (context.spec.provider !== 'mock') throw new Error('Synthetic mock executor only supports mock');
  return {
    outcome: context.session.sequence >= 1 ? 'complete' : 'continue', costMicros: 1,
    usage: {inputTokens: 1, cacheReadTokens: context.session.sequence ? 1 : 0, cacheWriteTokens: 0, outputTokens: 1},
    message: 'SYNTHETIC mock evidence; no provider call, real billing or external resource.',
    session: {...context.session, sequence: context.session.sequence + 1, data: {transcript: 'private transcript', previous: context.session.data}},
  };
};

/** Opt-in demo: operator token remains in this trust adapter, outside executor context. */
export async function runAutonomousMockDemo(options: {apiUrl: string; operatorToken: string; workerToken: string; fetchImpl?: typeof fetch}): Promise<{synthetic: true; taskId: string; iterations: number}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiUrl.replace(/\/$/, '');
  const now = Date.now();
  const spec: AutonomousSpec = {requestId: `synthetic-${now}`, goal: 'Synthetic local autonomous session demonstration', provider: 'mock', model: 'mock-fixed', endsAt: now + 60000,
    budgetMicros: 100, tools: [], systems: [], credentialIds: [], maxRunMs: 1000, maxIterations: 2};
  async function operator<T>(path: string, body: unknown): Promise<T> {
    const response = await fetchImpl(`${base}/v1/autonomous-tasks${path}`, {method: 'POST', headers: {authorization: `Bearer ${options.operatorToken}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    if (!response.ok) throw new Error(`Synthetic demo operator request rejected (${response.status})`);
    return await response.json() as T;
  }
  const task = await operator<AutonomousTask>('', spec);
  await operator(`/${encodeURIComponent(task.id)}/approve`, {revision: task.revision, reason: 'Explicit synthetic demo approval; no real execution'});
  const client = createAutonomousHttpClient(options);
  const sessions = new MemorySessionStore();
  let iterations = 0;
  for (let i = 0; i < 2; i++) {
    if (await runAutonomousIteration({client, taskId: task.id, workerId: `synthetic-worker-${i}`, sessions, executor: mockAutonomousExecutor})) iterations++;
  }
  return {synthetic: true, taskId: task.id, iterations};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiUrl = process.env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4310';
  const operatorToken = process.env.HIVEMIND_OPERATOR_TOKEN;
  const workerToken = process.env.HIVEMIND_WORKER_TOKEN;
  if (!operatorToken || !workerToken) throw new Error('Synthetic demo requires explicit operator and worker tokens');
  console.log(JSON.stringify(await runAutonomousMockDemo({apiUrl, operatorToken, workerToken})));
}
