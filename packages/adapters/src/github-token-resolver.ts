import {
  findAllowedRepository,
  issueGithubAppInstallationToken,
  type GithubAppSecretConfig,
  type GithubAppTokenOptions,
} from './github-app-token.js';

export interface ScopedGithubSecretPayload {
  tokensByRepo?: Record<string, string>;
  token?: string;
  /** GitHub App settings. For a repository listed here, a short-lived installation token replaces any PAT. */
  githubApp?: GithubAppSecretConfig;
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

export interface ResolvedGithubCredential {
  token: string;
  /** 'github_app' tokens expire after one hour and are limited to the one repository. */
  source: 'github_app' | 'personal_access_token';
  expiresAt: string | null;
}

function parseGithubAppConfig(rawSecret: string): GithubAppSecretConfig | null {
  const trimmed = rawSecret.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: ScopedGithubSecretPayload;
  try {
    parsed = JSON.parse(trimmed) as ScopedGithubSecretPayload;
  } catch {
    throw new Error('GitHub Draft PR secret must be valid JSON or a raw token string');
  }
  const app = parsed.githubApp;
  if (app === undefined) return null;
  if (
    !app ||
    typeof app !== 'object' ||
    typeof app.appId !== 'string' ||
    typeof app.privateKeyPem !== 'string' ||
    !app.privateKeyPem.includes('PRIVATE KEY') ||
    !Array.isArray(app.repositories) ||
    app.repositories.some((r) => typeof r !== 'string' || !REPO_PATTERN.test(r.trim()))
  ) {
    throw new Error('GitHub Draft PR secret has a malformed githubApp entry');
  }
  return app;
}

/**
 * Resolves the credential the Control Plane uses to push a branch and open a Draft PR.
 *
 * When the secret has a `githubApp` entry that lists the repository, a new installation token is issued
 * for every call. A failure there is NOT answered with a stored PAT: falling back would silently bring the
 * broad, long-lived credential back. Repositories the app does not list use the stored PAT as before.
 */
export async function resolveGithubCredentialForRepo(
  rawSecret: string,
  repository: string,
  options: GithubAppTokenOptions = {},
): Promise<ResolvedGithubCredential> {
  const cleanRepo = repository.trim();
  if (!REPO_PATTERN.test(cleanRepo)) {
    throw new Error(`Invalid GitHub repository format: ${repository}`);
  }
  const app = parseGithubAppConfig(rawSecret);
  if (app && findAllowedRepository(app, cleanRepo)) {
    const issued = await issueGithubAppInstallationToken(app, cleanRepo, options);
    return { token: issued.token, source: 'github_app', expiresAt: issued.expiresAt };
  }
  return { token: resolveGithubTokenForRepo(rawSecret, cleanRepo), source: 'personal_access_token', expiresAt: null };
}
