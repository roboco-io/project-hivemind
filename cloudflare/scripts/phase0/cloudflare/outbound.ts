export async function codexOutbound(request: Request, forward: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set(['chatgpt.com', 'auth.openai.com', 'api.openai.com']);
  if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    return new Response('Denied', { status: 403 });
  }
  return forward(request);
}

export async function claudeOutbound(request: Request, forward: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const allowed = new Set(['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com']);
  if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) return new Response('Denied', { status: 403 });
  return forward(request);
}
