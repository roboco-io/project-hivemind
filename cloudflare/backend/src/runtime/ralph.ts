import {readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import type {RalphCheckpoint, RalphFeedback} from '../contracts.ts';

export async function writeCheckpoint(dir: string, checkpoint: RalphCheckpoint): Promise<void> {
  await writeFile(join(dir, 'ralph.pending.json'), JSON.stringify(checkpoint), {mode: 0o600});
  await rename(join(dir, 'ralph.pending.json'), join(dir, 'ralph.json'));
}

export async function waitForFeedback(dir: string, round: number, deadline: number,
  signal: AbortSignal): Promise<RalphFeedback | null> {
  while (!signal.aborted && Date.now() < deadline) {
    const value = await readFile(join(dir, `feedback-${round}.json`), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (value !== null) return JSON.parse(value) as RalphFeedback;
    await sleep(100);
  }
  return null;
}
