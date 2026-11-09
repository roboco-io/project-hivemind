import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

type Options = { cwd: string; env: Record<string, string | undefined>; timeoutMs: number; maxBytes: number };

export async function runBounded(command: string, args: string[], options: Options) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error('Invalid execution limits');
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [], err: Buffer[] = [];
  const timeline: { observedAt: string; line: string }[] = [];
  const decoder = new StringDecoder('utf8');
  let bytes = 0, pending = '', timedOut = false, captureLimit = false, terminating = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (terminating || !child.pid) return;
    terminating = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    forceTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 1500);
    forceTimer.unref();
  };
  const collect = (chunk: Buffer, destination: Buffer[], stdout: boolean) => {
    const part = chunk.subarray(0, Math.max(0, options.maxBytes - bytes));
    bytes += part.length;
    if (part.length) destination.push(part);
    if (stdout) {
      pending += decoder.write(part);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop()!;
      for (const line of lines) if (line) timeline.push({ observedAt: new Date().toISOString(), line });
    }
    if (part.length < chunk.length) { captureLimit = true; terminate(); }
  };
  child.stdout.on('data', chunk => collect(chunk, out, true));
  child.stderr.on('data', chunk => collect(chunk, err, false));
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  const exitCode = await new Promise<number>(resolve => {
    child.on('error', () => resolve(127));
    child.on('close', code => resolve(code ?? 1));
  });
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  pending += decoder.end();
  if (pending) timeline.push({ observedAt: new Date().toISOString(), line: pending });
  return { exitCode, timedOut, captureLimit, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), timeline };
}
