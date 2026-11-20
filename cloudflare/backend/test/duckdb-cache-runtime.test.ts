import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

const capability = 'hma_' + 'a'.repeat(64);
const endpoint = 'https://hivemind-duckdb-cache.invalid/v1/cache';
const payload = 'a/1/b292bfa7892ae13a602bdff067113486ac8734';

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'hivemind-duckdb-cache-test-'));
  context.after(() => rm(directory, {force: true, recursive: true}));
  const {prepareDuckdbCache} = await import('../src/runtime/duckdb-cache.ts');
  return {directory, prepareDuckdbCache};
}

test('seed archives only compiler entries and warm restores the same bytes', async context => {
  const {directory, prepareDuckdbCache} = await fixture(context);
  const seed = join(directory, 'seed');
  const warm = join(directory, 'warm');
  await mkdir(seed);
  await mkdir(warm);
  let archive: ArrayBuffer | undefined;
  let sha256: string | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer ' + capability);
    if (init?.method === 'PUT') {
      assert.ok(init.body instanceof Blob);
      archive = await init.body.arrayBuffer();
      sha256 = createHash('sha256').update(new Uint8Array(archive)).digest('hex');
      assert.equal(headers.get('x-hivemind-cache-sha256'), sha256);
      assert.equal(headers.get('x-hivemind-cache-length'), String(archive.byteLength));
      return new Response(null, {status: 201});
    }
    assert.ok(archive && sha256);
    return new Response(archive, {headers: {
      'x-hivemind-cache-length': String(archive.byteLength), 'x-hivemind-cache-sha256': sha256,
    }});
  };
  const source = await prepareDuckdbCache({directory: seed, mode: 'seed', capability, fetchImpl});
  await mkdir(join(source.cacheDir, 'a/1'), {recursive: true});
  await writeFile(join(source.cacheDir, payload), 'compiled');
  await writeFile(join(source.cacheDir, 'a/stats'), 'runner statistics');
  await writeFile(join(source.cacheDir, 'ccache.conf'), 'unsafe settings');
  await mkdir(join(source.cacheDir, 'tmp'));
  const published = await source.publish();
  assert.equal(published.sha256, sha256);
  const destination = await prepareDuckdbCache({directory: warm, mode: 'warm', capability, fetchImpl});
  assert.equal(destination.restoredSha256, sha256);
  assert.equal(destination.restoredBytes, published.sizeBytes);
  assert.equal(await readFile(join(destination.cacheDir, payload), 'utf8'), 'compiled');
  assert.deepEqual(await readdir(destination.cacheDir), ['a']);
  assert.deepEqual(await readdir(join(destination.cacheDir, 'a')), ['1']);
  await destination.cleanup();
  assert.deepEqual(await readdir(warm), []);
});

test('warm cache fails closed on missing or corrupt R2 bytes', async context => {
  const {directory, prepareDuckdbCache} = await fixture(context);
  const responses = [
    new Response(null, {status: 404}),
    new Response('wrong', {headers: {'x-hivemind-cache-length': '5', 'x-hivemind-cache-sha256': 'a'.repeat(64)}}),
    new Response('wrong', {headers: {'x-hivemind-cache-length': '4', 'x-hivemind-cache-sha256': 'a'.repeat(64)}}),
  ];
  for (const response of responses) {
    await assert.rejects(prepareDuckdbCache({directory, mode: 'warm', capability, fetchImpl: async () => response}), /cache/i);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('cold cache makes no R2 requests', async context => {
  const {directory, prepareDuckdbCache} = await fixture(context);
  const cold = await prepareDuckdbCache({directory, mode: 'cold', capability,
    fetchImpl: async () => assert.fail('cold cache must make no requests')});
  assert.deepEqual(await readdir(cold.cacheDir), []);
  assert.deepEqual(cold.restoreMs, 0);
  await assert.rejects(cold.publish(), /seed/i);
  await cold.cleanup();
  assert.deepEqual(await readdir(directory), []);
});

test('seed refuses compiler entry symlinks before the PUT', async context => {
  const {directory, prepareDuckdbCache} = await fixture(context);
  const seed = await prepareDuckdbCache({directory, mode: 'seed', capability,
    fetchImpl: async () => assert.fail('symlink cache must make no requests')});
  await mkdir(join(seed.cacheDir, 'a/1'), {recursive: true});
  await symlink('/etc/passwd', join(seed.cacheDir, payload));
  await assert.rejects(seed.publish(), /archive/i);
  assert.deepEqual(await readdir(directory), ['cache']);
});
