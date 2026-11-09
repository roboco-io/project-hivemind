import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessEvidence } from '../../contracts/src/index.js';

export interface ProcessOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  onStdout?: (chunk: Buffer) => void;
}

export function processEnvironment(home: string, mode: boolean | 'claude' = false): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, CI: '1', TERM: 'dumb' };
  for (const key of ['PATH','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','LANG','LC_ALL']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  // Each inference process receives only its own authentication environment.
  if (mode === true) for (const key of ['CODEX_HOME','CODEX_API_KEY','CODEX_ACCESS_TOKEN','CODEX_CA_CERTIFICATE','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  // Native macOS Claude account selection needs the non-secret user name.
  if (mode === 'claude') for (const key of ['USER','CLAUDE_CONFIG_DIR','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.GIT_CONFIG_GLOBAL = '/dev/null';
  environment.GIT_CONFIG_SYSTEM = '/dev/null';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  return environment;
}

export async function runProcess(command: string[], options: ProcessOptions): Promise<ProcessEvidence> {
  options.signal.throwIfAborted();
  if (!command.length || command.some(part => typeof part !== 'string' || part.includes('\0')) || !command[0]) throw new Error('Invalid process command');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error('Invalid process timeout');
  const maximum = options.maxOutputBytes ?? 16000;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid output limit');
  const started = Date.now();
  return new Promise<ProcessEvidence>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd, env: options.env ?? processEnvironment(options.cwd),
      shell: false, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'],
    });
    let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let processError: Error | null = null, timedOut = false;
    let stopping: Promise<void> | null = null;
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid,0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const sendSignal = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid,signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processError ??= error as Error; }
    };
    const stop = () => stopping ??= (async () => {
      if (!groupAlive()) return;
      sendSignal('SIGTERM');
      const deadline = Date.now()+2000;
      while (groupAlive() && Date.now() < deadline) await delay(25);
      if (groupAlive()) { sendSignal('SIGKILL'); await delay(25); }
    })();
    const abort = () => { void stop(); };
    options.signal.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(() => { timedOut = true; void stop(); },options.timeoutMs);
    const capture = (current: Buffer, chunk: Buffer): Buffer => {
      const available = maximum-current.length;
      if (chunk.length > available) truncated = true;
      return available > 0 ? Buffer.concat([current,chunk.subarray(0,available)]) : current;
    };
    child.stdout.on('data',(chunk: Buffer) => {
      stdout = capture(stdout,chunk);
      try { options.onStdout?.(chunk); }
      catch (error) { processError = error instanceof Error ? error : new Error(String(error)); void stop(); }
    });
    child.stderr.on('data',(chunk: Buffer) => { stderr = capture(stderr,chunk); });
    child.on('error',error => { processError = error; });
    child.stdin.on('error',() => undefined);
    child.stdin.end(options.input ?? '');
    child.on('close',(exitCode,terminationSignal) => {
      clearTimeout(timer);
      void (async () => {
        // A command may leave descendants with closed pipes. Stop the remaining
        // process group as well, before considering its execution finished.
        await stop();
        options.signal.removeEventListener('abort',abort);
        if (options.signal.aborted) return reject(options.signal.reason ?? new Error('Execution aborted'));
        let errorOutput = stderr.toString('utf8');
        if (processError) errorOutput += `\n${processError.message}`;
        else if (terminationSignal && !timedOut) errorOutput += `\nProcess terminated by ${terminationSignal}`;
        resolve({command:[...command],status:timedOut ? 'timed_out' : processError || terminationSignal ? 'error' : exitCode === 0 ? 'passed' : 'failed',exitCode,durationMs:Date.now()-started,stdout:stdout.toString('utf8'),stderr:errorOutput.slice(0,maximum),truncated:truncated || errorOutput.length > maximum});
      })().catch(reject);
    });
  });
}
