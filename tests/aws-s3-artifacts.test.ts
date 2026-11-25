import assert from 'node:assert/strict';
import test from 'node:test';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';

test('createAwsS3ArtifactsPort signs SigV4 PUT/GET with SHA-256 checksum, enforces digest on GET, and rejects unsafe keys/buckets', async () => {
  const storage = new Map<string, Uint8Array>();
  const seenHeaders: Record<string, string>[] = [];

  const s3 = createAwsS3ArtifactsPort({
    region: 'ap-northeast-2',
    bucket: 'hivemind-artifacts-test',
    credentials: () => ({
      accessKeyId: 'AKIAEXAMPLE123',
      secretAccessKey: 's3-secret-never-logged',
      sessionToken: 'sess-123',
    }),
    now: () => Date.parse('2026-11-25T12:00:00.000Z'),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      if (init?.method === 'PUT') {
        const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : Buffer.from(String(init.body ?? ''));
        storage.set(url.pathname, body);
        return new Response('', { status: 200, headers: { etag: '"etag-1"' } });
      }
      const data = storage.get(url.pathname);
      if (!data) return new Response('Not Found', { status: 404 });
      return new Response(Buffer.from(data), { status: 200 });
    },
  });

  const payload = Buffer.from('pinned git bundle bytes', 'utf8');
  const uploaded = await s3.putObject('bundles/base.bundle', payload, 'application/octet-stream');
  assert.equal(uploaded.etag, '"etag-1"');
  assert.match(seenHeaders[0]!.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123\/20261125\/ap-northeast-2\/s3\/aws4_request/);
  assert.ok(seenHeaders[0]!['x-amz-checksum-sha256']);

  const roundtrip = await s3.getObject('bundles/base.bundle', uploaded.sha256);
  assert.deepEqual(Buffer.from(roundtrip), payload);

  // Corrupted or mismatched SHA-256 must fail closed.
  await assert.rejects(() => s3.getObject('bundles/base.bundle', '0'.repeat(64)), /SHA-256 verification failed/);

  // Unsafe keys and dotted bucket names are rejected.
  await assert.rejects(() => s3.putObject('../escape.bin', payload, 'application/octet-stream'), /Unsafe S3 object key/);
  assert.throws(
    () =>
      createAwsS3ArtifactsPort({
        region: 'ap-northeast-2',
        bucket: 'dotted.bucket.name',
        credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
      }),
    /Invalid S3 bucket name/,
  );
});
