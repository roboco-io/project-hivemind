export interface ScopedGithubSecretPayload {
  tokensByRepo?: Record<string, string>;
  token?: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * Resolves a repository-scoped GitHub token from AWS Secrets Manager JSON or raw string.
 * Fails explicitly with an actionable repository name when no token is configured (never silently disables).
 */
export function resolveGithubTokenForRepo(rawSecret: string, repository: string): string {
  const cleanRepo = repository.trim();
  if (!REPO_PATTERN.test(cleanRepo)) {
    throw new Error(`Invalid GitHub repository format: ${repository}`);
  }
  const trimmed = rawSecret.trim();
  if (!trimmed) {
    throw new Error(`No GitHub token configured for repository ${cleanRepo} (secret is empty)`);
  }

  if (!trimmed.startsWith('{')) {
    return trimmed;
  }

  let parsed: ScopedGithubSecretPayload;
  try {
    parsed = JSON.parse(trimmed) as ScopedGithubSecretPayload;
  } catch {
    throw new Error('GitHub Draft PR secret must be valid JSON or a raw token string');
  }

  if (parsed.tokensByRepo && typeof parsed.tokensByRepo === 'object' && !Array.isArray(parsed.tokensByRepo)) {
    // Case-insensitive owner/repo lookup while preserving exact token value.
    const exact = parsed.tokensByRepo[cleanRepo];
    if (typeof exact === 'string' && exact.trim()) return exact.trim();
    const lowerRepo = cleanRepo.toLowerCase();
    for (const [k, v] of Object.entries(parsed.tokensByRepo)) {
      if (k.trim().toLowerCase() === lowerRepo && typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }

  if (typeof parsed.token === 'string' && parsed.token.trim()) {
    return parsed.token.trim();
  }

  throw new Error(
    `No GitHub token configured for repository ${cleanRepo}; register a scoped PAT via scripts/aws-set-github-secret.ts`,
  );
}
