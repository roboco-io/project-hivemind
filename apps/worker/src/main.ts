import { setTimeout as delay } from 'node:timers/promises';
import { runOnce } from './worker.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const config = {
  apiUrl: process.env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4310',
  workerId: process.env.HIVEMIND_WORKER_ID ?? 'worker-local-1',
  workerToken: process.env.HIVEMIND_WORKER_TOKEN ?? 'local-worker-only',
};
const once = process.argv.includes('--once');

do {
  try {
    const processed = await runOnce(config, controller.signal);
    console.log(processed ? 'Mock task submitted for human review.' : 'No approved task available.');
  } catch (error) {
    if (controller.signal.aborted) break;
    console.error(error instanceof Error ? error.message : 'Worker execution failed.');
    if (once) process.exitCode = 1;
  }
  if (once || controller.signal.aborted) break;
  await delay(2000, undefined, { signal: controller.signal }).catch(() => undefined);
} while (!controller.signal.aborted);
