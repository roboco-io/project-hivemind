import type { GitHubDraftPrPort, GitHubDraftPrRequest, GitHubDraftPrResponse } from './draft-pr-publisher.js';

export interface GitHubDraftPrClientConfig {
  token: string;
  apiOrigin?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubCommitMaterializer {
  /**
   * Produces the commit SHA and verified tree SHA on the isolated branch via Git Data API or trusted server Git push.
   * Never executes untrusted repository hooks or model code.
   */
  createIsolatedBranchCommit(input: {
    repository: string;
    branchName: string;
    baseCommit: string;
    patch: string;
    expectedTreeHash: string;
    title: string;
  }, signal: AbortSignal): Promise<{ commitSha: string; treeSha: string }>;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);

export function createGitHubDraftPrPort(
  config: GitHubDraftPrClientConfig,
  materializer: GitHubCommitMaterializer,
): GitHubDraftPrPort {
  if (!config.token || !config.token.trim()) {
    throw new Error('GitHub Draft PR token is required');
  }
  const apiOrigin = (config.apiOrigin ?? 'https://api.github.com').replace(/\/+$/, '');
  if (!/^https:\/\/api\.github\.com$/.test(apiOrigin) && !/^https:\/\//.test(apiOrigin)) {
    throw new Error('GitHub Draft PR client requires HTTPS apiOrigin');
  }
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async publishDraftPr(request: GitHubDraftPrRequest, signal: AbortSignal): Promise<GitHubDraftPrResponse> {
      if (request.draft !== true) {
        throw new Error('Refusing non-draft pull request creation');
      }
      if (
        PROTECTED_BRANCHES.has(request.branchName) ||
        request.branchName === request.baseBranch ||
        !request.branchName.includes('/')
      ) {
        throw new Error('Refusing to publish to protected or non-isolated branch');
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)) {
        throw new Error('Invalid GitHub repository format');
      }

      const materialized = await materializer.createIsolatedBranchCommit(
        {
          repository: request.repository,
          branchName: request.branchName,
          baseCommit: request.baseCommit,
          patch: request.patch,
          expectedTreeHash: request.expectedTreeHash,
          title: request.title,
        },
        signal,
      );
      if (materialized.treeSha.toLowerCase() !== request.expectedTreeHash.toLowerCase()) {
        throw new Error('Materialized branch commit treeSha does not match expectedTreeHash');
      }

      const response = await fetchImpl(`${apiOrigin}/repos/${request.repository}/pulls`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'project-hivemind-draft-pr-publisher',
        },
        body: JSON.stringify({
          title: request.title,
          body: request.body,
          head: request.branchName,
          base: request.baseBranch,
          draft: true,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });

      if (!response.ok) {
        throw new Error(`GitHub Draft PR creation failed with HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        number?: number;
        html_url?: string;
        draft?: boolean;
        head?: { sha?: string };
      };
      if (
        data.draft !== true ||
        typeof data.number !== 'number' ||
        typeof data.html_url !== 'string' ||
        !data.html_url.startsWith(`https://github.com/${request.repository}/pull/`)
      ) {
        throw new Error('GitHub response did not confirm a valid Draft PR');
      }
      return {
        commitSha: (data.head?.sha ?? materialized.commitSha).toLowerCase(),
        prTreeHash: materialized.treeSha.toLowerCase(),
        prNumber: data.number,
        prUrl: data.html_url,
      };
    },
  };
}
