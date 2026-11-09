import { setTimeout as delay } from 'node:timers/promises';
import { runOnce } from './worker.js';
import { loadWorkerSettings } from './config.js';
import { getAdapter } from '../../../packages/adapters/src/index.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const settings = loadWorkerSettings(process.env);
const config = {...settings,adapter:getAdapter(settings.provider,settings.codex ?? settings.claude)};
const once = process.argv.includes('--once');

do {
  try {
    const processed = await runOnce(config, controller.signal);
    console.log(processed ? `${settings.provider} task result submitted to control plane.` : 'No approved task available.');
  } catch (error) {
    if (controller.signal.aborted) break;
    console.error(error instanceof Error ? error.message : 'Worker execution failed.');
    if (once) process.exitCode = 1;
  }
  if (once || controller.signal.aborted) break;
  await delay(2000, undefined, { signal: controller.signal }).catch(() => undefined);
} while (!controller.signal.aborted);
