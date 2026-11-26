import assert from 'node:assert/strict';
import test from 'node:test';
import { createEcsTaskCredentialsProvider } from '../packages/adapters/src/aws-ecs-metadata-creds.js';

test('createEcsTaskCredentialsProvider loads ECS task metadata credentials and rejects unsafe relative URI', async () => {
  const provider = createEcsTaskCredentialsProvider(
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc-123' },
    async (input) => {
      assert.equal(String(input), 'http://169.254.170.2/v2/credentials/abc-123');
      return new Response(
        JSON.stringify({ AccessKeyId: 'ASIAEXAMPLE', SecretAccessKey: 'secret-val', Token: 'tok-val' }),
        { status: 200 },
      );
    },
  );
  const creds = await provider();
  assert.equal(creds.accessKeyId, 'ASIAEXAMPLE');
  assert.equal(creds.sessionToken, 'tok-val');

  const badUri = createEcsTaskCredentialsProvider({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'http://evil.example/x' });
  await assert.rejects(() => badUri(), /Invalid AWS_CONTAINER_CREDENTIALS_RELATIVE_URI/);

  const envFallback = createEcsTaskCredentialsProvider({
    AWS_ACCESS_KEY_ID: 'AKIAFALLBACK',
    AWS_SECRET_ACCESS_KEY: 'secret-fallback',
  });
  const fallback = await envFallback();
  assert.equal(fallback.accessKeyId, 'AKIAFALLBACK');
});
