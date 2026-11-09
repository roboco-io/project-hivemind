import { setTimeout as delay } from 'node:timers/promises';
import type { AgentAdapter, Lease } from '../../../packages/contracts/src/index.js';
import { getAdapter } from '../../../packages/adapters/src/index.js';

export interface WorkerConfig {
  apiUrl: string;
  workerId: string;
  workerToken: string;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  adapter?: AgentAdapter;
}

export async function runOnce(config: WorkerConfig, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = new URL(config.apiUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('API URL must use HTTP or HTTPS');
  const post = async <T>(path: string, body: unknown, requestSignal: AbortSignal = workSignal): Promise<T> => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error(`Worker request ${path} failed (${response.status})`);
    return await response.json() as T;
  };

  await post('/api/workers/register', { workerId: config.workerId, provider: 'mock', runtime: 'local' });
  const lease = await post<Lease | null>('/api/workers/claim', { workerId: config.workerId });
  if (!lease) return false;
  const credentials = { workerId: config.workerId, leaseToken: lease.leaseToken };
  const path = `/api/tasks/${encodeURIComponent(lease.task.id)}`;
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([workSignal, heartbeatStop.signal]);
  const heartbeats = (async () => {
    try {
      while (!heartbeatSignal.aborted) {
        await delay(config.heartbeatMs ?? 5000, undefined, { signal: heartbeatSignal });
        await post(`${path}/heartbeat`, credentials, heartbeatSignal);
      }
    } catch (error) {
      if (!heartbeatStop.signal.aborted && !workSignal.aborted) {
        controller.abort(new Error(`Worker heartbeat rejected or unavailable: ${error instanceof Error ? error.message : 'unknown error'}`));
      }
    }
  })();

  try {
    const adapter = config.adapter ?? getAdapter(lease.task.provider);
    if (adapter.provider !== lease.task.provider) throw new Error('Adapter provider does not match the assigned task');
    const result = await adapter.execute(lease.task, workSignal);
    heartbeatStop.abort();
    await heartbeats;
    workSignal.throwIfAborted();
    await post(`${path}/result`, { ...credentials, ...result });
    return true;
  } catch (error) {
    if (!workSignal.aborted) {
      // Failure reporting is best effort: a cancelled or expired lease may reject it.
      await post(`${path}/fail`, {
        ...credentials,
        message: (error instanceof Error ? error.message : 'Unknown adapter error').slice(0, 2000),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    heartbeatStop.abort();
    await heartbeats;
  }
}
