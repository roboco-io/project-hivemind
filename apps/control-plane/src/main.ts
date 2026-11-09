import { buildApp } from './app.js';

const host = process.env.HIVEMIND_HOST ?? '127.0.0.1';
const port = Number(process.env.HIVEMIND_PORT ?? '4310');
const operatorToken = process.env.HIVEMIND_OPERATOR_TOKEN ?? 'local-development-only';
const workerToken = process.env.HIVEMIND_WORKER_TOKEN ?? 'local-worker-only';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HIVEMIND_PORT');
if (!['127.0.0.1','localhost','::1'].includes(host) &&
    (operatorToken.length < 24 || workerToken.length < 24 || operatorToken === 'local-development-only' || workerToken === 'local-worker-only')) {
  throw new Error('Non-loopback binding requires two distinct custom tokens of at least 24 characters');
}
const app = buildApp({dbPath:process.env.HIVEMIND_DB ?? 'data/hivemind.sqlite',operatorToken,workerToken});
try {
  const address = await app.listen({host,port});
  console.log(`Project HIVEMIND mock/local dashboard: ${address}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to start server');
  await app.close(); process.exitCode = 1;
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app.close(); });
