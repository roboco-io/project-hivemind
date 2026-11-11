import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type {WorkflowChecks} from '../../../packages/adapters/src/cloud-workflow.js';
import type { CloudPortOptions } from '../../../packages/adapters/src/cloudflare.js';

const prefix = 'HIVEMIND_CLOUDFLARE_';
const names = ['URL','CONTROL_TOKEN','SECRETS_FILE','REPO_PATH','WORKTREE_ROOT','CODEX_CREDENTIAL','CLAUDE_CREDENTIAL','CHECKS','TIMEOUT_MS'];
const invalid = () => new Error('Invalid Cloudflare dashboard configuration.');
const identifier = (value: string) => /^[A-Za-z0-9_-]{1,120}$/.test(value);
/** Private execution binding. Rotating the control token does not change a task's scope. */
export function configurationScope(options: CloudPortOptions): string {
  return createHash('sha256').update(JSON.stringify({ ...options, controlToken: undefined })).digest('hex');
}
export function configurationGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PATH','LANG','LC_ALL','LC_CTYPE','SystemRoot','WINDIR','TMPDIR','TMP','TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[prefix + name];
  if (!value || !value.trim() || value.length > 64000 || /[\0\r\n]/.test(value)) throw invalid();
  return value;
}
function timeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1000 || value > 3600000) throw invalid();
  return value;
}
function readControlToken(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 64000) throw invalid();
    const content = readFileSync(descriptor, 'utf8').trim();
    if (content.startsWith('{')) {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'CONTROL_TOKEN')) throw invalid();
      const token: unknown = (parsed as Record<string, unknown>).CONTROL_TOKEN;
      if (typeof token !== 'string') throw invalid();
      return token;
    }
    const lines = content.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?CONTROL_TOKEN\s*=/.test(line));
    if (lines.length !== 1) throw invalid();
    let token = lines[0]!.replace(/^\s*(?:export\s+)?CONTROL_TOKEN\s*=\s*/, '').trim();
    if (token.startsWith('"') || token.startsWith("'")) {
      if (token.length < 2 || token.at(-1) !== token[0]) throw invalid();
      token = token.slice(1, -1);
    }
    return token;
  } finally { closeSync(descriptor); }
}

function parseChecks(parsed:unknown,controlToken:string):CloudPortOptions['checks'] {
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4) throw invalid();
    const checks: CloudPortOptions['checks'] = parsed.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
      const check = item as Record<string, unknown>;
      if (Object.keys(check).length !== 3 || !['id','argv','timeoutMs'].every(key => Object.hasOwn(check,key)) || typeof check.id !== 'string' || !identifier(check.id) || !Array.isArray(check.argv) || check.argv.length < 1 || check.argv.length > 32 || !check.argv.every(arg => typeof arg === 'string' && !!arg.trim() && arg.length <= 1000 && !arg.includes('\0') && !arg.includes(controlToken))) throw invalid();
      return { id: check.id, argv: check.argv as string[], timeoutMs: timeout(check.timeoutMs) };
    });
    if (new Set(checks.map(check => check.id)).size !== checks.length) throw invalid();
  return checks;
}
export function loadCloudWorkflowChecks(config:CloudPortOptions|undefined,env:NodeJS.ProcessEnv=process.env):WorkflowChecks|undefined {
  if(env[prefix+'WORKFLOW_CHECKS']===undefined)return undefined;
  if(!config)throw invalid();
  try {
    const value:unknown=JSON.parse(required(env,'WORKFLOW_CHECKS'));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3)throw invalid();
    const fields=value as Record<string,unknown>;
    return {codex:parseChecks(fields.codex,config.controlToken),claude:parseChecks(fields.claude,config.controlToken),
      integration:parseChecks([fields.integration],config.controlToken)[0]!};
  }catch{throw invalid();}
}

/** Server-only configuration. No secret value or filesystem path belongs in an API DTO. */
export function loadCloudflareConfig(env: NodeJS.ProcessEnv = process.env): CloudPortOptions | undefined {
  if (!names.some(name => env[prefix + name] !== undefined)) return undefined;
  try {
    const rawUrl = required(env, 'URL'); const url = new URL(rawUrl);
    if (rawUrl !== rawUrl.trim() || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
    const directToken = env[prefix + 'CONTROL_TOKEN']; const secretFile = env[prefix + 'SECRETS_FILE'];
    if ((directToken !== undefined) === (secretFile !== undefined)) throw invalid();
    const controlToken = directToken !== undefined ? required(env, 'CONTROL_TOKEN') : readControlToken(required(env, 'SECRETS_FILE'));
    if (!controlToken || controlToken.length > 4096 || /[\s\x00-\x1f\x7f]/.test(controlToken)) throw invalid();
    const repositoryPath = realpathSync(required(env, 'REPO_PATH'));
    if (!isAbsolute(required(env, 'REPO_PATH')) || !statSync(repositoryPath).isDirectory()) throw invalid();
    const gitEnv = configurationGitEnvironment();
    const git = (args: string[]) => execFileSync('git', ['-C', repositoryPath, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 64000, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true' || realpathSync(git(['rev-parse', '--show-toplevel'])) !== repositoryPath) throw invalid();
    const baseCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw invalid();
    const rawRoot = required(env, 'WORKTREE_ROOT');
    if (!isAbsolute(rawRoot) || rawRoot.length > 4096) throw invalid();
    const worktreeRoot = resolve(rawRoot);
    let ancestor = worktreeRoot;
    while (true) {
      try { if (!statSync(ancestor).isDirectory()) throw invalid(); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
    }
    if (worktreeRoot === repositoryPath) throw invalid();
    const parsed: unknown = JSON.parse(required(env, 'CHECKS'));
    const checks = parseChecks(parsed,controlToken);
    const credentialIds = { codex: env[prefix + 'CODEX_CREDENTIAL'] ?? 'codex-remote', claude: env[prefix + 'CLAUDE_CREDENTIAL'] ?? 'claude-remote' };
    if (!identifier(credentialIds.codex) || !identifier(credentialIds.claude) || credentialIds.codex === credentialIds.claude) throw invalid();
    const rawTimeout = env[prefix + 'TIMEOUT_MS'];
    if (rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) throw invalid();
    return { baseUrl: url.href, controlToken, repositoryPath, worktreeRoot, policy: { id: 'cloudflare', name: basename(repositoryPath), baseCommit, testProfile: 'default', testCommand: [...checks[0]!.argv] }, credentialIds, checks, timeoutMs: timeout(rawTimeout === undefined ? 600000 : Number(rawTimeout)) };
  } catch { throw invalid(); }
}
