/**
 * fetch for Control Plane calls from workers and verifiers. The Control Plane runs on Fargate Spot and is
 * replaced on deploys and Spot interruptions; for about a minute its name points at no task or at a task
 * that is shutting down. A worker that gave up on the first failed connection lost its whole run.
 *
 * Only failures before the request reached the server are retried (connection refused, unreachable host,
 * name lookup, connect timeout), so a POST is never applied twice. HTTP error responses are returned as-is.
 */
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export function isConnectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createControlFetch(options: {
  fetch?: typeof fetch;
  /** Total time to keep retrying. Default: 5 minutes, longer than a Control Plane replacement. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
} = {}): typeof fetch {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxWaitMs = options.maxWaitMs ?? 300_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const started = now();
    let delay = 2_000;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetcher(input, init);
      } catch (error) {
        if (init?.signal?.aborted || !isConnectFailure(error) || now() - started + delay > maxWaitMs) throw error;
        log(`Control Plane connection failed (attempt ${attempt}); retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    }
  }) as typeof fetch;
}

export const controlFetch = createControlFetch();
