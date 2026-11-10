import { buildApp } from './app.js';
import { configurationGitEnvironment, configurationScope, loadCloudflareConfig } from './cloudflare-config.js';
import { createCloudPort } from '../../../packages/adapters/src/cloudflare.js';
import { createCloudControl } from '../../../packages/core/src/cloudflare-store.js';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import type { RepositoryPolicy } from '../../../packages/contracts/src/index.js';
import type { CloudControl } from '../../../packages/contracts/src/cloudflare.js';

let app: ReturnType<typeof buildApp> | undefined;
let cloudflare: CloudControl | undefined;
const startupErrors = new Set([
  'Invalid HIVEMIND_PORT',
  'Non-loopback binding requires two distinct custom tokens of at least 24 characters',
  'Invalid local repository configuration.',
  'Invalid Cloudflare dashboard configuration.',
  'Invalid Cloudflare port configuration.',
  'Operator and worker tokens must be nonempty and distinct'
]);
try {
  const host = process.env.HIVEMIND_HOST ?? '127.0.0.1';
  const port = Number(process.env.HIVEMIND_PORT ?? '4310');
  const operatorToken = process.env.HIVEMIND_OPERATOR_TOKEN ?? 'local-development-only';
  const workerToken = process.env.HIVEMIND_WORKER_TOKEN ?? 'local-worker-only';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HIVEMIND_PORT');
  if (!['127.0.0.1','localhost','::1'].includes(host) &&
      (operatorToken.length < 24 || workerToken.length < 24 || operatorToken === 'local-development-only' || workerToken === 'local-worker-only')) {
    throw new Error('Non-loopback binding requires two distinct custom tokens of at least 24 characters');
  }
  let repository: RepositoryPolicy | undefined;
  if (process.env.HIVEMIND_REPO_PATH) {
    try {
      const path = realpathSync(process.env.HIVEMIND_REPO_PATH);
      const git = (args: string[]) => execFileSync('git',['-C',path,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],env:configurationGitEnvironment()}).trim();
      const root = git(['rev-parse','--show-toplevel']);
      const baseCommit = git(['rev-parse','--verify','HEAD^{commit}']);
      if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error();
      const testCommand: unknown = JSON.parse(process.env.HIVEMIND_TEST_COMMAND ?? '["npm","run","check"]');
      if (!Array.isArray(testCommand) || testCommand.length < 1 || testCommand.length > 32 || !testCommand.every(arg=>typeof arg === 'string' && !!arg.trim() && arg.length <= 1000 && !arg.includes('\0'))) throw new Error();
      repository = {id:'local',name:basename(root),baseCommit,testProfile:'default',testCommand};
    } catch { throw new Error('Invalid local repository configuration.'); }
  }
  const dbPath = process.env.HIVEMIND_DB ?? 'data/hivemind.sqlite';
  const config = loadCloudflareConfig();
  if (config) cloudflare = createCloudControl({ dbPath, policy: config.policy, port: createCloudPort(config), executionScope: configurationScope(config) });
  app = buildApp({dbPath,operatorToken,workerToken,repository,cloudflare});
  const address = await app.listen({host,port});
  console.log(`HIVEMIND control service: ${address}`);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app!.close(); });
} catch (error) {
  console.error(error instanceof Error && startupErrors.has(error.message) ? error.message : 'Unable to start HIVEMIND dashboard.');
  try { if (app) await app.close(); else await cloudflare?.close(); } catch { /* Startup errors stay scrubbed. */ }
  process.exitCode = 1;
}
