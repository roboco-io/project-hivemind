import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeProviderAuth, redactWorkerOutput } from '../apps/worker/src/aws-worker-auth.js';

test('materializeProviderAuth isolates codex/claude credentials with 0700/0600 modes, rejects unsupported providers, redacts secrets, and cleans up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-worker-auth-'));
  try {
    const codexSecret = JSON.stringify({
      codex: {
        authJson: JSON.stringify({ tokens: { access_token: 'codex-access-secret-token-123456', refresh_token: 'codex-refresh-secret-token-654321' } }),
        model: 'gpt-5.4-mini',
      },
      claude: {
        oauthToken: 'claude-oauth-secret-token-987654',
        model: 'claude-sonnet-4-5',
      },
    });

    const codexAuth = await materializeProviderAuth('codex', codexSecret, root);
    assert.ok(codexAuth.env.CODEX_HOME);
    assert.equal(codexAuth.model, 'gpt-5.4-mini');
    const authFile = join(codexAuth.env.CODEX_HOME!, 'auth.json');
    assert.equal(statSync(codexAuth.env.CODEX_HOME!).mode & 0o777, 0o700);
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
    assert.match(readFileSync(authFile, 'utf8'), /codex-access-secret-token-123456/);

    const scrubbed = redactWorkerOutput(
      'Failed using codex-access-secret-token-123456 and Bearer something-secret',
      codexAuth.redactSecrets,
    );
    assert.ok(!scrubbed.includes('codex-access-secret-token-123456'));
    assert.ok(!scrubbed.includes('something-secret'));

    await codexAuth.cleanup();
    assert.equal(existsSync(codexAuth.env.CODEX_HOME!), false);

    const claudeAuth = await materializeProviderAuth('claude', codexSecret, root);
    assert.equal(claudeAuth.env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-oauth-secret-token-987654');
    assert.equal(claudeAuth.model, 'claude-sonnet-4-5');
    await claudeAuth.cleanup();
    assert.equal(existsSync(claudeAuth.env.CLAUDE_CONFIG_DIR!), false);

    // Explicitly rejects gemini or arbitrary providers inside secret payload.
    await assert.rejects(
      () => materializeProviderAuth('codex', JSON.stringify({ gemini: { oauthToken: 'forbidden' } }), root),
      /Unsupported provider/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
