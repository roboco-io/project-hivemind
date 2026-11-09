// Phase-0 fixed fixture, not the product's general-purpose job runner.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { redactKnownTokens, sealAuth } from './auth-envelope.ts';
import { summarizeRollout, type RolloutReceipt } from './rollout-receipts.ts';
import { readNativeThreads, type NativeThreadReceipt } from './native-thread-receipts.ts';

const authText = process.env.HIVEMIND_CODEX_AUTH_JSON;
const publicKey = process.env.HIVEMIND_AUTH_RETURN_PUBLIC_KEY;
delete process.env.HIVEMIND_CODEX_AUTH_JSON;
delete process.env.HIVEMIND_AUTH_RETURN_PUBLIC_KEY;
if (!authText || !publicKey) throw new Error('Probe authentication is not configured');
let originalAuth: Record<string, unknown>;
try { originalAuth = JSON.parse(authText); } catch { throw new Error('Invalid probe authentication format'); }
if (originalAuth.auth_mode !== 'chatgpt') throw new Error('Probe requires ChatGPT authentication');
await mkdir('/home/node/.codex', { recursive: true, mode: 0o700 });
await writeFile('/home/node/.codex/auth.json', authText, { mode: 0o600 });

const nonce = randomBytes(16).toString('hex');
const prompt = `This is a fixed Hivemind feasibility fixture. Work only in /workspace. Do not read authentication files or environment secrets.
Spawn exactly two subagents in parallel before waiting for either:
1. First agent: wait 5 seconds using a Node.js timer, then write alpha.txt containing exactly ALPHA_HIVEMIND followed by a newline.
2. Second agent: wait 5 seconds using a Node.js timer, then write beta.txt containing exactly BETA_HIVEMIND followed by a newline.
Wait for both subagents. Invoke the phase0 MCP tool phase0_probe with nonce ${nonce} and check its response.
Run a Node.js command to verify both file contents. Return HIVE_PROBE_COMPLETE only after the actual tool call, both agents, and file verification succeed.`;
const env = { ...process.env };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
const child = spawn('codex', [
  '-a', 'never', '-c', 'cli_auth_credentials_store="file"',
  '-c', 'agents.enabled=true', '-c', 'agents.max_concurrent_threads_per_session=2',
  '-c', 'model_reasoning_effort="low"',
  '-c', 'mcp_servers.phase0.command="node"',
  '-c', 'mcp_servers.phase0.args=["/opt/hivemind/scripts/phase0/mcp-server.ts"]',
  '-c', 'mcp_servers.phase0.required=true',
  'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt,
], { cwd: '/workspace', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false, captureLimit = false;
const timeline: { observedAt: string; line: string }[] = [];
const terminate = () => {
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* Already stopped. */ }
  setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 1500).unref();
};
const timer = setTimeout(() => { timedOut = true; terminate(); }, 85_000);
let partial = '';
child.stdout.on('data', data => {
  stdout += data.toString();
  partial += data.toString();
  const lines = partial.split(/\r?\n/);
  partial = lines.pop()!;
  for (const line of lines) if (line) timeline.push({ observedAt: new Date().toISOString(), line });
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { captureLimit = true; terminate(); }
});
child.stderr.on('data', data => {
  stderr += data.toString();
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { captureLimit = true; terminate(); }
});
const exitCode = await new Promise<number>(resolve => {
  child.on('error', () => resolve(127));
  child.on('close', code => resolve(code ?? 1));
});
clearTimeout(timer);
const refreshedText = await readFile('/home/node/.codex/auth.json', 'utf8');
let refreshedAuth: unknown;
try { refreshedAuth = JSON.parse(refreshedText); } catch { throw new Error('Invalid refreshed authentication format'); }
const clean = (text: string) => redactKnownTokens(text, originalAuth, refreshedAuth);
const events = timeline.map(item => {
  try { return { observedAt: item.observedAt, event: JSON.parse(clean(item.line)) }; }
  catch { return { observedAt: item.observedAt, unparsed: clean(item.line) }; }
});
const optionalFile = async (path: string) => {
  try { return (await readFile(path, 'utf8')).slice(0, 1024); } catch { return null; }
};
const rolloutReceipts: RolloutReceipt[] = [];
let nativeThreads: NativeThreadReceipt[] = [];
try {
  const databases = (await readdir('/home/node/.codex')).filter(name => /^state_\d+\.sqlite$/.test(name)).sort();
  if (databases.length) nativeThreads = readNativeThreads(join('/home/node/.codex', databases.at(-1)!));
} catch { /* File identities and spawn receipts remain independent evidence. */ }
try {
  const root = '/home/node/.codex/sessions';
  const paths = await readdir(root, { recursive: true });
  for (const path of paths.filter(path => path.endsWith('.jsonl')).slice(0, 16)) {
    const text = await readFile(join(root, path), 'utf8');
    const receipt = summarizeRollout(clean(text));
    const file = basename(path);
    const thread = nativeThreads.find(item => item.rolloutFile === file);
    receipt.rolloutFile = file;
    receipt.fileThreadId = file.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
    receipt.storageThreadId = thread?.threadId ?? null;
    receipt.storageSource = thread?.source ?? null;
    rolloutReceipts.push(receipt);
  }
} catch { /* Missing native receipts keep parallel execution unverified. */ }
process.stdout.write(JSON.stringify({
  scope: 'codex-subscription-fixed-fixture', exitCode, timedOut, captureLimit, nonce,
  events, rolloutReceipts, nativeThreads, stderr: clean(stderr).slice(-16_384),
  alpha: clean(await optionalFile('/workspace/alpha.txt') ?? ''),
  beta: clean(await optionalFile('/workspace/beta.txt') ?? ''),
  authReturn: sealAuth(refreshedText, publicKey),
}));
