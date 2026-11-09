// Local operator helper for the one-shot phase-0 fixture. Never prints authReturn.
import { constants, createDecipheriv, privateDecrypt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { redactKnownTokens } from './auth-envelope.ts';
import { assessCodexFixture } from './assess-codex.ts';

const secretsPath = '.hivemind/cloudflare-secrets.json';
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const originalAuth = JSON.parse(await readFile('.hivemind/codex-remote-auth.json', 'utf8'));
const deployment = JSON.parse(await readFile('.hivemind/phase0-deployment.json', 'utf8'));
await writeFile('.hivemind/codex-probe-headers', '', { mode: 0o600 });
// Headers arrive over stdin, not command-line arguments or shell interpolation.
const child = execFile('curl', [
  '--silent', '--show-error', '--max-time', '150', '--request', 'POST',
  '--dump-header', '.hivemind/codex-probe-headers',
  '--header', '@-', '--write-out', '\n%{http_code}',
  'https://hivemind-phase0.roboco.workers.dev/phase0/codex',
], { timeout: 160_000, maxBuffer: 2 * 1024 * 1024 });
child.stdin!.end(`Authorization: Bearer ${secrets.PROBE_TOKEN}\n`);
const output = await new Promise<string>((resolve, reject) => {
  let text = '';
  child.stdout!.on('data', data => { text += data.toString(); });
  child.on('error', () => reject(new Error('Probe request could not start')));
  child.on('close', code => code === 0 ? resolve(text) : reject(new Error('Probe transport failed')));
});
const split = output.lastIndexOf('\n');
const status = Number(output.slice(split + 1));
const body = output.slice(0, split);
await writeFile('.hivemind/codex-probe-response.json', body, { mode: 0o600 });
if (status !== 200) throw new Error(`Subscription probe HTTP status ${status}; private response preserved`);
const response = JSON.parse(body);
const envelope = response.authReturn;
if (envelope?.version !== 1) throw new Error('Missing encrypted authentication return');
const privateKey = await readFile('.hivemind/auth-return-private.pem');
const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
decipher.setAAD(Buffer.from('hivemind-phase0-auth-return-v1'));
decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
const refreshedText = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString();
let refreshedAuth: Record<string, unknown>;
try { refreshedAuth = JSON.parse(refreshedText); } catch { throw new Error('Invalid returned authentication format'); }
if (refreshedAuth.auth_mode !== 'chatgpt') throw new Error('Unexpected returned authentication mode');
await writeFile('.hivemind/codex-remote-auth.json', refreshedText, { mode: 0o600 });
secrets.CODEX_AUTH_JSON = refreshedText;
await writeFile(secretsPath, JSON.stringify(secrets)+'\n', { mode: 0o600 });
delete response.authReturn;
const record = {
  platform: 'cloudflare-remote', recordedAt: new Date().toISOString(),
  ...deployment,
  requestRay: (await readFile('.hivemind/codex-probe-headers', 'utf8')).split(/\r?\n/).find(line => line.toLowerCase().startsWith('cf-ray:'))?.slice(7).trim() ?? null,
  scope: 'one-shot-codex-subscription-fixture', authRecovered: true,
  assessment: assessCodexFixture(response),
  httpStatus: status, diagnostics: response,
};
const safeRecord = redactKnownTokens(JSON.stringify(record, null, 2), originalAuth, refreshedAuth);
await writeFile('docs/phase0/cloudflare-codex-subscription-20261109.json', safeRecord+'\n');
console.log(JSON.stringify({
  assessment: record.assessment,
  httpStatus: status, exitCode: response.exitCode, timedOut: response.timedOut,
  containerStopped: response.containerStopped, authRecovered: true,
  alpha: response.alpha, beta: response.beta, eventCount: response.events?.length,
}));
