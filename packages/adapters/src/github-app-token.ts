import { createSign } from 'node:crypto';

/**
 * GitHub App settings kept in the Control Plane's Draft PR secret. The private key signs a short-lived app
 * JWT. The JWT is exchanged for an installation token that is limited to one repository and to the
 * permissions listed in INSTALLATION_PERMISSIONS, and that expires after one hour.
 */
export interface GithubAppSecretConfig {
  appId: string;
  privateKeyPem: string;
  /** Repositories (`owner/name`) this Control Plane may request a token for. Anything else is refused. */
  repositories: string[];
}

export interface IssuedInstallationToken {
  token: string;
  expiresAt: string;
  installationId: number;
  permissions: Record<string, string>;
}

export interface GithubAppTokenOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  apiBaseUrl?: string;
}

/** The only permissions a Draft PR needs: push a branch and open a pull request. */
export const INSTALLATION_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const;

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const APP_ID_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** RS256 app JWT. `iat` is backdated 60 s for clock drift; GitHub rejects a lifetime over 10 minutes. */
export function createGithubAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  if (!APP_ID_PATTERN.test(appId)) throw new Error('Invalid GitHub App ID');
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  } catch {
    // The crypto error text can quote key material, so it is replaced.
    throw new Error('GitHub App private key is not a valid RSA private key');
  }
  return `${header}.${payload}.${base64Url(signature)}`;
}

export function findAllowedRepository(config: GithubAppSecretConfig, repository: string): string | null {
  const wanted = repository.trim().toLowerCase();
  return config.repositories.find((r) => r.trim().toLowerCase() === wanted) ?? null;
}

/**
 * Issues a one-hour installation token for exactly one repository.
 * Fails closed: the repository must be in the configured allowlist, the app must be installed on it, and
 * GitHub's answer must grant both required permissions and name only that repository.
 */
export async function issueGithubAppInstallationToken(
  config: GithubAppSecretConfig,
  repository: string,
  options: GithubAppTokenOptions = {},
): Promise<IssuedInstallationToken> {
  const cleanRepo = repository.trim();
  if (!REPO_PATTERN.test(cleanRepo)) throw new Error(`Invalid GitHub repository format: ${repository}`);
  if (!findAllowedRepository(config, cleanRepo)) {
    throw new Error(`GitHub App is not configured for repository ${cleanRepo}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const api = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const jwt = createGithubAppJwt(config.appId, config.privateKeyPem, (options.now ?? Date.now)());
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${jwt}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'project-hivemind-control-plane',
  };
  const signal = () => options.signal ?? AbortSignal.timeout(15_000);
  const [owner, name] = cleanRepo.split('/') as [string, string];

  const installationRes = await fetchImpl(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`, {
    method: 'GET',
    redirect: 'error',
    headers,
    signal: signal(),
  });
  if (installationRes.status === 404) {
    throw new Error(`GitHub App is not installed on repository ${cleanRepo}`);
  }
  if (!installationRes.ok) {
    throw new Error(`GitHub App installation lookup for ${cleanRepo} failed with HTTP ${installationRes.status}`);
  }
  const installation = (await installationRes.json()) as { id?: unknown };
  if (typeof installation.id !== 'number' || !Number.isSafeInteger(installation.id) || installation.id <= 0) {
    throw new Error('GitHub App installation lookup returned no installation id');
  }

  const tokenRes = await fetchImpl(`${api}/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    redirect: 'error',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: [name], permissions: INSTALLATION_PERMISSIONS }),
    signal: signal(),
  });
  if (!tokenRes.ok) {
    // 422 means the app was not granted a requested permission or cannot access the repository.
    throw new Error(`GitHub App installation token request for ${cleanRepo} failed with HTTP ${tokenRes.status}`);
  }
  const issued = (await tokenRes.json()) as {
    token?: unknown;
    expires_at?: unknown;
    permissions?: Record<string, string>;
    repositories?: { full_name?: string }[];
  };
  if (typeof issued.token !== 'string' || issued.token.length < 20 || typeof issued.expires_at !== 'string') {
    throw new Error('GitHub App installation token response is malformed');
  }
  const permissions = issued.permissions ?? {};
  for (const [permission, level] of Object.entries(INSTALLATION_PERMISSIONS)) {
    if (permissions[permission] !== level) {
      throw new Error(`GitHub App installation token for ${cleanRepo} lacks ${permission}:${level}`);
    }
  }
  const granted = (issued.repositories ?? []).map((r) => (r.full_name ?? '').toLowerCase());
  if (granted.length !== 1 || granted[0] !== cleanRepo.toLowerCase()) {
    throw new Error(`GitHub App installation token is not limited to repository ${cleanRepo}`);
  }
  return { token: issued.token, expiresAt: issued.expires_at, installationId: installation.id, permissions };
}
