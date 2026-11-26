import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueGithubAppInstallationToken, type GithubAppSecretConfig } from '../packages/adapters/src/github-app-token.js';

/**
 * Registers a GitHub App in the Control Plane's Draft PR secret (`hivemind-runtime/github-draft-pr`).
 *
 *   HIVEMIND_GITHUB_APP_ID=<app id> \
 *   HIVEMIND_GITHUB_APP_PRIVATE_KEY_FILE=<path to the downloaded .pem> \
 *   HIVEMIND_GITHUB_APP_REPOSITORIES=roboco-io/project-hivemind,roboco-io/silicon-model-factory \
 *   AWS_PROFILE=roboco npx tsx scripts/aws-set-github-app-secret.ts
 *
 * Before writing anything it issues a real installation token for every listed repository. That proves
 * the app is installed there and has `contents: write` and `pull_requests: write`. Each test token is
 * revoked at once. Stored PATs of the listed repositories are removed, because keeping them would leave the
 * broad credential in place; set HIVEMIND_GITHUB_KEEP_PATS=1 to keep them. PATs of other repositories stay.
 *
 * The script never prints the private key or any token.
 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const secretId = process.env.HIVEMIND_GITHUB_SECRET_ID ?? 'hivemind-runtime/github-draft-pr';
  const appId = process.env.HIVEMIND_GITHUB_APP_ID?.trim();
  const keyFile = process.env.HIVEMIND_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const repositories = (process.env.HIVEMIND_GITHUB_APP_REPOSITORIES ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  const keepPats = process.env.HIVEMIND_GITHUB_KEEP_PATS === '1';
  if (!appId || !keyFile || repositories.length === 0) {
    throw new Error('Set HIVEMIND_GITHUB_APP_ID, HIVEMIND_GITHUB_APP_PRIVATE_KEY_FILE and HIVEMIND_GITHUB_APP_REPOSITORIES.');
  }
  if (repositories.some((r) => !REPO_PATTERN.test(r))) throw new Error('HIVEMIND_GITHUB_APP_REPOSITORIES must list owner/name entries.');
  const privateKeyPem = readFileSync(keyFile, 'utf8').trim();
  if (!privateKeyPem.includes('PRIVATE KEY')) throw new Error('The private key file does not look like a PEM private key.');

  const config: GithubAppSecretConfig = { appId, privateKeyPem, repositories };
  const verified: { repository: string; installationId: number; expiresAt: string }[] = [];
  for (const repository of repositories) {
    const issued = await issueGithubAppInstallationToken(config, repository);
    verified.push({ repository, installationId: issued.installationId, expiresAt: issued.expiresAt });
    // The test token is not needed again: revoke it instead of letting it live for an hour.
    await fetch('https://api.github.com/installation/token', {
      method: 'DELETE',
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${issued.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'project-hivemind-secret-rotator',
      },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  const awsArgs = ['--profile', profile, '--region', region, 'secretsmanager'];
  let existing: { tokensByRepo?: Record<string, string>; token?: string } = {};
  try {
    const raw = execFileSync('aws', [...awsArgs, 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString', '--output', 'text'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (raw.startsWith('{')) existing = JSON.parse(raw) as typeof existing;
    else if (raw) existing = { token: raw };
  } catch {
    // Secret may be empty or newly initialized.
  }

  const covered = new Set(repositories.map((r) => r.toLowerCase()));
  const tokensByRepo = Object.fromEntries(
    Object.entries(existing.tokensByRepo ?? {}).filter(([repo]) => keepPats || !covered.has(repo.trim().toLowerCase())),
  );
  const removedPats = Object.keys(existing.tokensByRepo ?? {}).filter((repo) => !(repo in tokensByRepo));
  // A bare `token` is a catch-all PAT for every repository, so it is dropped together with the covered PATs.
  const keepCatchAll = keepPats && typeof existing.token === 'string';
  const payload = JSON.stringify({
    githubApp: config,
    ...(Object.keys(tokensByRepo).length > 0 ? { tokensByRepo } : {}),
    ...(keepCatchAll ? { token: existing.token } : {}),
  });

  // The payload holds the private key: pass it through a 0600 file, not through the process argument list.
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-gh-app-'));
  const payloadFile = join(dir, 'secret.json');
  let version: unknown;
  try {
    writeFileSync(payloadFile, payload, { mode: 0o600 });
    version = JSON.parse(
      execFileSync('aws', [...awsArgs, 'put-secret-value', '--secret-id', secretId, '--secret-string', `file://${payloadFile}`, '--query', '{Name:Name,VersionId:VersionId}', '--output', 'json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        appId,
        verifiedRepositories: verified,
        removedPatRepositories: removedPats,
        removedCatchAllToken: typeof existing.token === 'string' && !keepCatchAll,
        remainingPatRepositories: Object.keys(tokensByRepo),
        secret: version,
        note: 'The Control Plane reads this secret for every Draft PR publication. No restart is needed.',
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
