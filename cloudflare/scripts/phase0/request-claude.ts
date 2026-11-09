// Local operator for the fixed Claude fixture; never prints subscription credentials.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { redactKnownTokens } from './auth-envelope.ts';
import { assessClaudeFixture } from './assess-claude.ts';

const secrets = JSON.parse(await readFile('.hivemind/cloudflare-secrets.json', 'utf8'));
const token = (await readFile('.hivemind/claude-remote-token', 'utf8')).trim();
const deployment = JSON.parse(await readFile('.hivemind/phase0-deployment.json', 'utf8'));
await writeFile('.hivemind/claude-probe-headers', '', { mode: 0o600 });
const probeUrl=process.env.HIVEMIND_PROBE_URL??'https://hivemind-boundary-check.roboco.workers.dev';
if(!['https://hivemind-boundary-check.roboco.workers.dev'].includes(probeUrl))throw new Error('Use the verified diagnostic Worker');
const child = execFile('curl', ['--silent', '--show-error', '--max-time', '150', '--request', 'POST',
  '--dump-header', '.hivemind/claude-probe-headers', '--header', '@-', '--write-out', '\n%{http_code}',
  probeUrl+'/phase0/claude',
], { timeout: 160_000, maxBuffer: 2 * 1024 * 1024 });
child.stdin!.end(`Authorization: Bearer ${secrets.PROBE_TOKEN}\n`);
const output = await new Promise<string>((resolve, reject) => {
  let text = '';
  child.stdout!.on('data', data => { text += data.toString(); });
  child.on('error', () => reject(new Error('Claude probe could not start')));
  child.on('close', code => code === 0 ? resolve(text) : reject(new Error('Claude probe transport failed')));
});
const split = output.lastIndexOf('\n');
const status = Number(output.slice(split + 1)), body = output.slice(0, split);
await writeFile('.hivemind/claude-probe-response.json', body, { mode: 0o600 });
if (status !== 200) throw new Error(`Claude probe HTTP ${status}; private response preserved`);
const response = JSON.parse(body);
const assessment = assessClaudeFixture(response);
const record = { platform: 'cloudflare-remote', recordedAt: new Date().toISOString(), ...deployment,
  requestRay: (await readFile('.hivemind/claude-probe-headers', 'utf8')).split(/\r?\n/).find(line => line.toLowerCase().startsWith('cf-ray:'))?.slice(7).trim() ?? null,
  workerVersion:response.workerVersion??deployment.workerVersion, assessment, httpStatus: status, diagnostics: response };
await writeFile('docs/phase0/cloudflare-claude-subscription-20261110.json', redactKnownTokens(JSON.stringify(record, null, 2), { tokens: { access_token: token } })+'\n');
console.log(JSON.stringify({ assessment, httpStatus: status, exitCode: response.exitCode, timedOut: response.timedOut,
  alpha: response.alpha, beta: response.beta, containerStopped: response.containerStopped, eventCount: response.events?.length, agentReceiptCount: response.agents?.length }));
