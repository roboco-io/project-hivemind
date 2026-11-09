import { buildApp } from './app.js';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import type { RepositoryPolicy } from '../../../packages/contracts/src/index.js';

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
  const path = realpathSync(process.env.HIVEMIND_REPO_PATH);
  const git = (args: string[]) => execFileSync('git',['-C',path,...args],{encoding:'utf8',timeout:5000}).trim();
  const root = git(['rev-parse','--show-toplevel']);
  const baseCommit = git(['rev-parse','--verify','HEAD^{commit}']);
  if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error('Repository HEAD is not a full commit SHA');
  const testCommand: unknown = JSON.parse(process.env.HIVEMIND_TEST_COMMAND ?? '["npm","run","check"]');
  if (!Array.isArray(testCommand) || testCommand.length < 1 || testCommand.length > 32 || !testCommand.every(arg=>typeof arg === 'string' && !!arg.trim() && arg.length <= 1000 && !arg.includes('\0'))) throw new Error('HIVEMIND_TEST_COMMAND must be a nonempty JSON argument array');
  repository = {id:'local',name:basename(root),baseCommit,testProfile:'default',testCommand};
}
const app = buildApp({dbPath:process.env.HIVEMIND_DB ?? 'data/hivemind.sqlite',operatorToken,workerToken,repository});
try {
  const address = await app.listen({host,port});
  console.log(`Project HIVEMIND local dashboard: ${address}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to start server');
  await app.close(); process.exitCode = 1;
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app.close(); });
