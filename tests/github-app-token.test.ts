import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  createGithubAppJwt,
  issueGithubAppInstallationToken,
  type GithubAppSecretConfig,
} from '../packages/adapters/src/github-app-token.js';
import { resolveGithubCredentialForRepo } from '../packages/adapters/src/github-token-resolver.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const NOW = Date.parse('2026-11-27T03:00:00.000Z');
const REPO = 'roboco-io/project-hivemind';
const ISSUED = 'ghs_installationTokenValue0123456789abcdef';

const config = (repositories = [REPO]): GithubAppSecretConfig => ({ appId: '123456', privateKeyPem: PRIVATE_PEM, repositories });

interface Call {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
}

function fakeGithub(overrides: {
  installationStatus?: number;
  tokenStatus?: number;
  permissions?: Record<string, string>;
  repositories?: string[];
} = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url, authorization: headers.authorization ?? '', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/installation')) {
      const status = overrides.installationStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { id: 777 } : { message: 'Not Found' }), { status });
    }
    const status = overrides.tokenStatus ?? 201;
    return new Response(
      JSON.stringify(
        status === 201
          ? {
              token: ISSUED,
              expires_at: '2026-11-27T04:00:00Z',
              permissions: overrides.permissions ?? { contents: 'write', pull_requests: 'write', metadata: 'read' },
              repositories: (overrides.repositories ?? [REPO]).map((full_name) => ({ full_name })),
            }
          : { message: 'Unprocessable' },
      ),
      { status },
    );
  };
  return { calls, fetchImpl };
}

test('createGithubAppJwt signs an RS256 JWT with a backdated iat and a lifetime under 10 minutes', () => {
  const jwt = createGithubAppJwt('123456', PRIVATE_PEM, NOW);
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, '123456');
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.equal(claims.exp - claims.iat, 600);
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')));

  assert.throws(() => createGithubAppJwt('123456', 'not a key', NOW), /not a valid RSA private key/);
  assert.throws(() => createGithubAppJwt('12 34', PRIVATE_PEM, NOW), /Invalid GitHub App ID/);
});

test('issueGithubAppInstallationToken requests a token for one repository with only the two needed permissions', async () => {
  const github = fakeGithub();
  const issued = await issueGithubAppInstallationToken(config(), 'ROBOCO-IO/Project-Hivemind', { fetchImpl: github.fetchImpl, now: () => NOW });
  assert.equal(issued.token, ISSUED);
  assert.equal(issued.expiresAt, '2026-11-27T04:00:00Z');
  assert.equal(issued.installationId, 777);

  assert.equal(github.calls.length, 2);
  const [lookup, create] = github.calls as [Call, Call];
  assert.equal(new URL(lookup.url).origin, 'https://api.github.com');
  assert.equal(new URL(lookup.url).pathname, '/repos/ROBOCO-IO/Project-Hivemind/installation');
  assert.equal(create.method, 'POST');
  assert.equal(new URL(create.url).pathname, '/app/installations/777/access_tokens');
  assert.deepEqual(create.body, { repositories: ['Project-Hivemind'], permissions: { contents: 'write', pull_requests: 'write' } });
  // Both calls authenticate with the app JWT, never with a stored token.
  for (const call of github.calls) assert.match(call.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test('issueGithubAppInstallationToken fails closed on every mismatch and never leaks the private key', async () => {
  const cases: [string, Parameters<typeof fakeGithub>[0], GithubAppSecretConfig, string, RegExp, number][] = [
    ['repository not in the allowlist', {}, config(), 'roboco-io/other-repo', /not configured for repository/, 0],
    ['malformed repository', {}, config(), 'not a repo', /Invalid GitHub repository format/, 0],
    ['app not installed', { installationStatus: 404 }, config(), REPO, /not installed on repository/, 1],
    ['installation lookup error', { installationStatus: 401 }, config(), REPO, /installation lookup .* HTTP 401/, 1],
    ['token request refused', { tokenStatus: 422 }, config(), REPO, /token request .* HTTP 422/, 2],
    ['missing pull_requests permission', { permissions: { contents: 'write' } }, config(), REPO, /lacks pull_requests:write/, 2],
    ['read-only contents', { permissions: { contents: 'read', pull_requests: 'write' } }, config(), REPO, /lacks contents:write/, 2],
    ['token covers a second repository', { repositories: [REPO, 'roboco-io/silicon-model-factory'] }, config(), REPO, /not limited to repository/, 2],
    ['token covers a different repository', { repositories: ['roboco-io/silicon-model-factory'] }, config(), REPO, /not limited to repository/, 2],
  ];
  for (const [name, overrides, cfg, repository, pattern, expectedCalls] of cases) {
    const github = fakeGithub(overrides);
    await assert.rejects(
      () => issueGithubAppInstallationToken(cfg, repository, { fetchImpl: github.fetchImpl, now: () => NOW }),
      (error: Error) => {
        assert.match(error.message, pattern, name);
        assert.ok(!error.message.includes('PRIVATE KEY'), name);
        return true;
      },
    );
    assert.equal(github.calls.length, expectedCalls, name);
  }
});

test('resolveGithubCredentialForRepo prefers the GitHub App, keeps PATs for unlisted repositories, and never falls back after an app failure', async () => {
  const secret = JSON.stringify({
    githubApp: config([REPO]),
    tokensByRepo: { [REPO]: 'ghp_classicTokenThatMustNotBeUsed000000', 'roboco-io/silicon-model-factory': 'ghp_smfClassicToken0000000000000000000' },
  });

  const github = fakeGithub();
  const viaApp = await resolveGithubCredentialForRepo(secret, REPO, { fetchImpl: github.fetchImpl, now: () => NOW });
  assert.deepEqual(viaApp, { token: ISSUED, source: 'github_app', expiresAt: '2026-11-27T04:00:00Z' });

  // A repository the app does not list still uses its stored PAT, without any GitHub App call.
  const untouched = fakeGithub();
  const viaPat = await resolveGithubCredentialForRepo(secret, 'roboco-io/silicon-model-factory', { fetchImpl: untouched.fetchImpl });
  assert.deepEqual(viaPat, { token: 'ghp_smfClassicToken0000000000000000000', source: 'personal_access_token', expiresAt: null });
  assert.equal(untouched.calls.length, 0);

  // The app is configured for the repository but GitHub refuses: no silent fallback to the stored PAT.
  const refused = fakeGithub({ installationStatus: 404 });
  await assert.rejects(
    () => resolveGithubCredentialForRepo(secret, REPO, { fetchImpl: refused.fetchImpl, now: () => NOW }),
    /not installed on repository/,
  );

  // Secrets without a githubApp entry behave exactly as before.
  const legacy = await resolveGithubCredentialForRepo(JSON.stringify({ tokensByRepo: { [REPO]: 'github_pat_legacy0000000000000000' } }), REPO);
  assert.equal(legacy.source, 'personal_access_token');
  assert.equal((await resolveGithubCredentialForRepo('ghp_rawStringToken00000000000000000000', REPO)).token, 'ghp_rawStringToken00000000000000000000');

  // A malformed githubApp entry is an error, not an ignored field.
  for (const bad of [{ appId: '1' }, { appId: '1', privateKeyPem: 'x', repositories: [REPO] }, { appId: '1', privateKeyPem: PRIVATE_PEM, repositories: ['bad repo'] }]) {
    await assert.rejects(() => resolveGithubCredentialForRepo(JSON.stringify({ githubApp: bad, token: 'ghp_fallback0000000000000000' }), REPO), /malformed githubApp/);
  }
});
