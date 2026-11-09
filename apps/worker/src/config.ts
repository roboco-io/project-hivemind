import { resolve } from 'node:path';

export interface LocalWorkerSettings {
  repositoryPath: string;
  worktreeRoot: string;
  repositoryId: string;
  codexCommand?: string;
  claudeCommand?: string;
  model?: string;
  testCommand: string[];
  setupCommand?: string[];
  timeoutMs: number;
  testTimeoutMs: number;
}
export interface WorkerSettings {
  apiUrl: string;
  workerId: string;
  workerToken: string;
  provider: 'mock' | 'codex' | 'claude';
  repositoryId?: string;
  codex?: LocalWorkerSettings;
  claude?: LocalWorkerSettings;
}
function command(value: string | undefined, name: string, fallback?: string[]): string[] | undefined {
  if (value === undefined || value === '') return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} must be a JSON argv array`); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 32 || parsed.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000 || item.includes('\0'))) throw new Error(`${name} must be a nonempty JSON argv array`);
  return parsed as string[];
}
function timeout(value: string | undefined, fallback: number, name: string): number {
  const ms = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(ms) || ms < 1000 || ms > 3600000) throw new Error(`${name} must be 1000..3600000 milliseconds`);
  return ms;
}
export function loadWorkerSettings(env: NodeJS.ProcessEnv): WorkerSettings {
  const provider = env.HIVEMIND_PROVIDER ?? 'mock';
  if (provider !== 'mock' && provider !== 'codex' && provider !== 'claude') throw new Error('HIVEMIND_PROVIDER must be mock, codex or claude');
  const config: WorkerSettings = {
    apiUrl: env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4310',
    workerId: env.HIVEMIND_WORKER_ID ?? (provider === 'mock' ? 'worker-local-1' : `worker-${provider}-1`),
    workerToken: env.HIVEMIND_WORKER_TOKEN ?? 'local-worker-only', provider,
  };
  if (provider === 'mock') return config;
  if (!env.HIVEMIND_REPO_PATH?.trim()) throw new Error(`HIVEMIND_REPO_PATH is required for a ${provider} worker`);
  config.repositoryId = 'local';
  const prefix = provider === 'codex' ? 'HIVEMIND_CODEX' : 'HIVEMIND_CLAUDE';
  const local: LocalWorkerSettings = {
    repositoryPath: resolve(env.HIVEMIND_REPO_PATH),
    worktreeRoot: resolve(env.HIVEMIND_WORKTREE_ROOT ?? 'data/worktrees'),
    repositoryId: 'local',
    ...(provider === 'codex' ? {codexCommand:env.HIVEMIND_CODEX_BIN ?? 'codex'} : {claudeCommand:env.HIVEMIND_CLAUDE_BIN ?? 'claude'}),
    ...(env[`${prefix}_MODEL`] ? {model:env[`${prefix}_MODEL`]} : {}),
    testCommand: command(env.HIVEMIND_TEST_COMMAND,'HIVEMIND_TEST_COMMAND',['npm','run','check'])!,
    ...(env.HIVEMIND_SETUP_COMMAND ? {setupCommand:command(env.HIVEMIND_SETUP_COMMAND,'HIVEMIND_SETUP_COMMAND')} : {}),
    timeoutMs: timeout(env[`${prefix}_TIMEOUT_MS`],600000,`${prefix}_TIMEOUT_MS`),
    testTimeoutMs: timeout(env.HIVEMIND_TEST_TIMEOUT_MS,120000,'HIVEMIND_TEST_TIMEOUT_MS'),
  };
  config[provider] = local;
  return config;
}
