import { evaluateGate, requiredChecksFor, type Backend, type Check } from './gate.ts';

export type CommandResult = { ok: boolean; stdout: string; stderr?: string };
export type Runner = (bin: string, args: string[]) => Promise<CommandResult>;
export type Options = { backend?: Backend; profile?: string; region?: string; account?: string };

export async function collectLocal(options: Options, run: Runner) {
  const backend = options.backend ?? 'cloudflare';
  const required = requiredChecksFor(backend);
  const tools = await Promise.all(['node', 'npm', backend === 'aws' ? 'aws' : 'wrangler', 'docker', 'codex', 'claude'].map(async name => {
    const result = await run(name, ['--version']).catch(() => ({ ok: false, stdout: '' }));
    // Store a version only, never raw command output or diagnostic text.
    const version = result.stdout.match(/\bv?(\d+\.\d+\.\d+(?:\.\d+)?)\b/)?.[1] ?? null;
    return { name, available: result.ok && version !== null, version };
  }));
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'])
    .catch(() => ({ ok: false, stdout: '' }));
  let awsStatus: Check['status'] = 'BLOCKED';
  if (backend === 'aws' && options.profile && options.region) {
    const identity = await run('aws', [
      'sts', 'get-caller-identity', '--profile', options.profile,
      '--region', options.region, '--output', 'json', '--no-cli-pager',
    ]).catch(() => ({ ok: false, stdout: '' }));
    if (identity.ok) {
      try {
        const parsed = JSON.parse(identity.stdout);
        const accountValid = typeof parsed.Account === 'string' && /^\d{12}$/.test(parsed.Account);
        const arnValid = typeof parsed.Arn === 'string' &&
          /^arn:(aws|aws-cn|aws-us-gov):(iam|sts)::\d{12}:.+$/.test(parsed.Arn) &&
          parsed.Arn.split(':')[4] === parsed.Account;
        awsStatus = accountValid && arnValid ? 'PASS' : 'FAIL';
      } catch { awsStatus = 'FAIL'; }
    }
  }
  let cloudflareStatus: Check['status'] = 'BLOCKED';
  if (backend === 'cloudflare') {
    const identity = await run('wrangler', ['whoami', '--json']).catch(() => ({ ok: false, stdout: '' }));
    if (identity.ok) {
      try {
        const parsed = JSON.parse(identity.stdout);
        const selected = options.account && Array.isArray(parsed.accounts) && parsed.accounts.some(
          (account: { id?: string; name?: string }) => account.id === options.account || account.name === options.account,
        );
        cloudflareStatus = parsed.loggedIn === true && selected ? 'PASS' : 'BLOCKED';
      } catch { cloudflareStatus = 'FAIL'; }
    }
  }
  const checks: Check[] = required.map(id => ({ id, status: 'NOT_RUN' }));
  const nodeVersion = tools.find(tool => tool.name === 'node')?.version?.split('.').map(Number);
  const supportedNode = nodeVersion?.[0] === 24 && nodeVersion[1] >= 14;
  checks.find(check => check.id === 'local-tools')!.status =
    supportedNode && tools.every(tool => tool.available) && docker.ok && /^\d+\.\d+\.\d+/.test(docker.stdout.trim()) ? 'PASS' : 'FAIL';
  checks.find(check => check.id === (backend === 'aws' ? 'aws-identity' : 'cloudflare-identity'))!.status =
    backend === 'aws' ? awsStatus : cloudflareStatus;
  return {
    schemaVersion: 1,
    scope: 'local-prerequisites-only',
    backend,
    awsTarget: { profile: options.profile ?? null, region: options.region ?? null },
    cloudflareTarget: { account: options.account ?? null },
    tools,
    dockerEngineAvailable: docker.ok && /^\d+\.\d+\.\d+/.test(docker.stdout.trim()),
    checks,
    gate: evaluateGate(checks, backend),
  };
}
