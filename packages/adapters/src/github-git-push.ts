import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitHubCommitMaterializer } from './github-draft-pr.js';
import { restoreFromGitBundle } from './git-bundle.js';
import { processEnvironment, runExecutable } from './process.js';

export interface GitPushMaterializerOptions {
  bundlePath: string;
  expectedBundleSha256: string;
  workRoot: string;
  remoteUrl: string;
  /** Optional auth header value (e.g. Basic <base64>) passed via GIT_CONFIG_* env, never written to disk or remote URL. */
  httpExtraHeader?: string;
  authorName?: string;
  authorEmail?: string;
  /** When false, materializes and verifies the local commit+treeSha without calling git push (dry-run/testing). */
  push?: boolean;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const HEX40_PATTERN = /^[a-f0-9]{40}$/i;

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runExecutable(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd, signal, timeoutMs: 60_000, env, maxOutputBytes: 256_000 },
  );
  if (result.status !== 'passed') {
    throw new Error(`Git ${args[0]} failed: ${result.stderr.slice(0, 1000)}`);
  }
  return result.stdout.trim();
}

export function createGitPushCommitMaterializer(options: GitPushMaterializerOptions): GitHubCommitMaterializer {
  const shouldPush = options.push ?? true;
  if (shouldPush && !/^https:\/\/github\.com\/|^file:\/\/|^\//.test(options.remoteUrl)) {
    throw new Error('Remote URL must be HTTPS GitHub or explicit local test bare repository');
  }

  return {
    async createIsolatedBranchCommit(input, signal) {
      if (
        PROTECTED_BRANCHES.has(input.branchName) ||
        !input.branchName.includes('/') ||
        !SAFE_BRANCH_PATTERN.test(input.branchName) ||
        input.branchName.includes('..') ||
        input.branchName.endsWith('/') ||
        input.branchName.endsWith('.lock')
      ) {
        throw new Error('Refusing to commit or push to protected or non-isolated branch');
      }
      const commitMatch = HEX40_PATTERN.exec(input.baseCommit);
      if (!commitMatch) {
        throw new Error('Invalid baseCommit');
      }
      const cleanBaseCommit = commitMatch[0].toLowerCase();
      const cleanBranchName = SAFE_BRANCH_PATTERN.exec(input.branchName)![0];

      const scratch = await mkdtemp(join(options.workRoot, 'pr-materialize-'));
      const repoDir = join(scratch, 'repo');
      const homeDir = join(scratch, 'home');
      const patchFile = join(scratch, 'verified.patch');
      const commitMsgFile = join(scratch, 'commit-msg.txt');
      await mkdir(homeDir, { recursive: true });
      const baseEnv: NodeJS.ProcessEnv = {
        ...processEnvironment(homeDir),
        GIT_AUTHOR_NAME: options.authorName ?? 'Project HIVEMIND',
        GIT_AUTHOR_EMAIL: options.authorEmail ?? 'hivemind@users.noreply.github.com',
        GIT_COMMITTER_NAME: options.authorName ?? 'Project HIVEMIND',
        GIT_COMMITTER_EMAIL: options.authorEmail ?? 'hivemind@users.noreply.github.com',
      };
      try {
        await restoreFromGitBundle(
          options.bundlePath,
          options.expectedBundleSha256,
          cleanBaseCommit,
          repoDir,
          signal,
        );
        await git(repoDir, ['checkout', '-q', '-b', cleanBranchName, cleanBaseCommit], signal, baseEnv);
        if (input.patch.trim()) {
          await writeFile(patchFile, input.patch, 'utf8');
          await git(repoDir, ['apply', '--whitespace=nowarn', patchFile], signal, baseEnv);
        }
        await git(repoDir, ['add', '--all'], signal, baseEnv);
        await writeFile(commitMsgFile, input.title.trim() || 'HIVEMIND verified change', 'utf8');
        await git(repoDir, ['commit', '--allow-empty', '-q', '-F', commitMsgFile], signal, baseEnv);

        const commitSha = (await git(repoDir, ['rev-parse', 'HEAD'], signal, baseEnv)).toLowerCase();
        const treeSha = (await git(repoDir, ['rev-parse', 'HEAD^{tree}'], signal, baseEnv)).toLowerCase();
        if (treeSha !== input.expectedTreeHash.toLowerCase()) {
          throw new Error(`Committed treeSha (${treeSha}) does not match expectedTreeHash (${input.expectedTreeHash})`);
        }

        if (shouldPush) {
          const pushEnv: NodeJS.ProcessEnv = options.httpExtraHeader
            ? {
                ...baseEnv,
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
                GIT_CONFIG_VALUE_0: options.httpExtraHeader,
              }
            : baseEnv;
          await git(
            repoDir,
            ['push', '--no-verify', options.remoteUrl, `HEAD:refs/heads/${cleanBranchName}`],
            signal,
            pushEnv,
          );
        }

        return { commitSha, treeSha };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
