import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { captureAcceptanceTestSpec, createPinnedGitBundle } from '../../../packages/adapters/src/git-bundle.js';
import type { AutonomyTrigger } from '../../../packages/core/src/autonomy-trigger.js';
import { touchedProtectedPaths } from '../../../packages/core/src/delivery.js';
import type { PreparedSnapshot } from './autonomy-dispatcher.js';

const run = promisify(execFile);
/** At most this many protected files are pinned as acceptance files. */
const MAX_PINNED_FILES = 200;

/**
 * Prepares a task snapshot from the live repository: clones the base branch with a short-lived GitHub
 * token, bundles its head commit to S3 and pins the files under the protected paths as acceptance files,
 * so the verifier fails any change to them before the auto-merge check even runs.
 */
export function createGitSnapshotPreparer(options: {
  s3: S3ObjectPort;
  /** One-hour, single-repository token (GitHub App) or a stored PAT. */
  resolveToken: (repository: string, signal: AbortSignal) => Promise<string>;
  workRoot?: string;
  /** Clone URL; tests point it at a local repository. Default: https://github.com/<repository>.git */
  remoteUrl?: (repository: string) => string;
}): (trigger: AutonomyTrigger, signal: AbortSignal) => Promise<PreparedSnapshot> {
  return async (trigger, signal) => {
    const dir = await mkdtemp(join(options.workRoot ?? tmpdir(), 'hm-autonomy-'));
    const token = await options.resolveToken(trigger.repository, signal);
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    // A failed git command quotes its arguments, including the base64 header that decodes to the token.
    const scrub = (text: string) => text.split(token).join('[REDACTED]').split(encoded).join('[REDACTED]').replace(/http\.extraHeader=[^\n]*/g, 'http.extraHeader=[REDACTED]');
    try {
      const repoDir = join(dir, 'repo');
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      const header = `Authorization: Basic ${encoded}`;
      try {
        await run('git', ['-c', `http.extraHeader=${header}`, '-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-tags', '--single-branch', '--branch', trigger.baseBranch, (options.remoteUrl ?? ((r) => `https://github.com/${r}.git`))(trigger.repository), repoDir], { env, signal, timeout: 180_000, maxBuffer: 4_000_000 });
      } catch (error) {
        throw new Error(`git clone failed: ${scrub(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      }
      const baseCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env, signal })).stdout.trim().toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error('Could not read the base commit');
      const bundlePath = join(dir, 'snapshot.bundle');
      const manifest = await createPinnedGitBundle(repoDir, baseCommit, bundlePath, signal);
      const s3Key = `bundles/autonomy/${trigger.id}/${baseCommit}.bundle`;
      await options.s3.putObject(s3Key, await readFile(bundlePath), 'application/octet-stream', signal);
      const listed = (await run('git', ['ls-tree', '-r', '--name-only', baseCommit], { cwd: repoDir, env, signal, maxBuffer: 16_000_000 })).stdout.split('\n').filter(Boolean);
      const pinned = touchedProtectedPaths(listed, trigger.protectedPaths).slice(0, MAX_PINNED_FILES);
      if (pinned.length === 0) throw new Error('No file under the protected paths exists in the repository');
      const acceptance = await captureAcceptanceTestSpec(repoDir, baseCommit, pinned, trigger.testCommand, signal);
      return { baseCommit, bundle: { ...manifest, s3Key }, acceptance };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
