import assert from 'node:assert/strict';
import test from 'node:test';
import { createAwsSecretsManagerPort } from '../packages/adapters/src/aws-secrets-manager.js';

test('createAwsSecretsManagerPort signs GetSecretValue with SigV4, validates region, and extracts SecretString', async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const port = createAwsSecretsManagerPort({
    region: 'ap-northeast-2',
    credentials: () => ({
      accessKeyId: 'AKIAEXAMPLE123456',
      secretAccessKey: 'super-secret-aws-key-never-leak',
      sessionToken: 'session-token-123',
    }),
    now: () => Date.parse('2026-11-25T15:00:00.000Z'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body ?? ''),
      });
      return new Response(JSON.stringify({ SecretString: '{"token":"ghp_example_secret_value"}' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const secret = await port.getSecretString('arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:hivemind-runtime/github-draft-pr-abc');
  assert.equal(secret, '{"token":"ghp_example_secret_value"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://secretsmanager.ap-northeast-2.amazonaws.com/');
  assert.equal(calls[0]!.headers['x-amz-target'], 'secretsmanager.GetSecretValue');
  assert.match(
    calls[0]!.headers.authorization!,
    /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123456\/20261125\/ap-northeast-2\/secretsmanager\/aws4_request/,
  );

  assert.throws(
    () =>
      createAwsSecretsManagerPort({
        region: 'us-east-2',
        credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
      }),
    /region/i,
  );
});
