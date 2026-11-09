export type ProbeKind = 'runtime' | 'sandbox' | 'codex' | 'claude' | 'claude-boundary' | 'codex-boundary' | 'landlock' | 'claude-layer' | 'compute-stdio' | 'claude-concurrency';

export async function handleProbe(request: Request, token: string | undefined, run: (kind: ProbeKind) => Promise<unknown>): Promise<Response> {
  if (!token) return new Response('Probe authentication is not configured', { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 });
  const path = new URL(request.url).pathname;
  if (!['/phase0', '/phase0/sandbox', '/phase0/codex', '/phase0/claude', '/phase0/claude-boundary', '/phase0/codex-boundary', '/phase0/landlock', '/phase0/claude-layer', '/phase0/compute-stdio', '/phase0/claude-concurrency'].includes(path)) return new Response('Not found', { status: 404 });
  const method = ['/phase0/codex', '/phase0/claude'].includes(path) ? 'POST' : 'GET';
  if (request.method !== method) return new Response('Method not allowed', { status: 405, headers: { Allow: method } });
  try {
    const kind = path === '/phase0/claude-concurrency' ? 'claude-concurrency' : path === '/phase0/compute-stdio' ? 'compute-stdio' : path === '/phase0/claude-layer' ? 'claude-layer' : path === '/phase0/landlock' ? 'landlock' : path === '/phase0/codex-boundary' ? 'codex-boundary' : path === '/phase0/claude-boundary' ? 'claude-boundary' : path === '/phase0/claude' ? 'claude' : path === '/phase0/codex' ? 'codex' : path === '/phase0/sandbox' ? 'sandbox' : 'runtime';
    return Response.json(await run(kind), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new Response('Probe failed', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
