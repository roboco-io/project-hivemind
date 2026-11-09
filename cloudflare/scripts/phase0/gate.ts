export type Backend = 'cloudflare' | 'aws';

const awsChecks = [
  'local-tools', 'aws-identity', 'fargate-network', 'codex-fargate',
  'claude-fargate', 'codex-subagents', 'claude-subagents',
  'mcp-fargate', 'credential-isolation', 'sandbox-fargate',
] as const;

const cloudflareChecks = [
  'local-tools', 'cloudflare-identity', 'cloudflare-network', 'codex-cloudflare',
  'claude-cloudflare', 'codex-subagents', 'claude-subagents',
  'mcp-cloudflare', 'credential-isolation', 'sandbox-cloudflare',
] as const;

export function requiredChecksFor(backend: Backend): readonly string[] {
  if (backend === 'cloudflare') return cloudflareChecks;
  if (backend === 'aws') return awsChecks;
  throw new Error('Unsupported backend');
}

export const requiredChecks = cloudflareChecks;

export type Check = { id: string; status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' };

export function evaluateGate(checks: Check[], backend: Backend = 'cloudflare') {
  const blockers = requiredChecksFor(backend).filter(id =>
    checks.filter(check => check.id === id).length !== 1 ||
    checks.find(check => check.id === id)?.status !== 'PASS',
  );
  return { status: blockers.length ? 'BLOCKED' : 'PASS', blockers };
}
