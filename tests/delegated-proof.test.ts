import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDelegatedProofAdapter } from '../packages/adapters/src/delegated-proof.js';
import type { HfReceipt, S3Receipt, WorkloadDescriptor } from '../packages/contracts/src/delegated.js';
const d: WorkloadDescriptor = { version: 1, workloadId: 'train', amiId: 'ami-12345678', bootstrapSha256: 'a'.repeat(64), inputManifestDigests: ['b'.repeat(64)], iam: { instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/train', policyRevision: 'v1', policySha256: 'c'.repeat(64) }, accountId: '123456789012', region: 'us-east-2', availabilityZoneId: 'use2-az1', s3: { bucket: 'train-bucket', prefix: 'tasks/t1/', maxObjects: 4, maxObjectBytes: 1000, maxTotalBytes: 2000, retentionMs: 60000, storageReserveMicros: 10, requestReserveMicros: 20, transferReserveMicros: 30 }, hf: { repo: 'org/model', visibility: 'private', tokenRef: 'hf-scoped', delivery: { mode: 'instance-private-envelope', audience: 'central', path: '/run/hivemind/hf-token', fileMode: '0600', ttlMs: 60000, trainingEnvironment: false } }, qualityGateIds: ['eval'], releasePolicy: { id: 'release', revision: 'v1', allowPublicTransition: true } };
const s3: S3Receipt = { kind: 's3', receiptId: 'r1', bucket: 'train-bucket', key: 'tasks/t1/model.bin', versionId: 'version1', size: 900, sha256: 'd'.repeat(64), ownerAccountId: '123456789012' };
const publicationGuard = { authorize: async () => { }, assertValid: () => { } };
const hf: HfReceipt = { kind: 'hf', receiptId: 'r2', repo: 'org/model', commit: 'a'.repeat(40), visibility: 'private', files: [{ path: 'model.safetensors', size: 900, oid: 'b'.repeat(40), sha256: 'd'.repeat(64) }] };
test('independent S3 HEAD requires version size full checksum and actual owner evidence', async () => { let calls = 0; const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => '', fetch: async () => { calls++; return new Response(null, { headers: { 'content-length': '900', 'x-amz-version-id': 'version1', 'x-amz-checksum-sha256': Buffer.from(s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': 'FULL_OBJECT' } }); } }); assert.equal((await adapter.verify(d, s3)).status, 'unknown'); assert.ok(calls > 0); });
test('HF verification uses commit metadata and actual file oid/LFS hash, never downloads weights', async () => { const urls: string[] = []; const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => 'hf-private', fetch: async (input) => { const u = String(input instanceof Request ? input.url : input); urls.push(u); return Response.json({ id: 'org/model', sha: hf.commit, private: true, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] }); } }); assert.equal((await adapter.verify(d, hf)).status, 'verified'); assert.ok(urls.every(u => u.startsWith('https://huggingface.co/api/models/org/model'))); assert.ok(urls.every(u => !u.includes('/resolve/'))); });
test('S3 complete owner evidence verifies and composite checksum remains unknown', async () => {
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    let composite = false;
    const requests: Request[] = [];
    const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => '', fetch: async (input) => {
            const req = input as Request;
            requests.push(req);
            if (req.method === 'GET')
                return new Response('<AccessControlPolicy><Owner><ID>' + owned.s3.ownerCanonicalId + '</ID></Owner></AccessControlPolicy>');
            return new Response(null, { headers: { 'content-length': '900', 'x-amz-version-id': s3.versionId, 'x-amz-checksum-sha256': Buffer.from(s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': composite ? 'COMPOSITE' : 'FULL_OBJECT' } });
        } });
    assert.equal((await adapter.verify(owned, s3)).status, 'verified');
    assert.ok(requests.every(r => r.url.includes('versionId=version1') && r.headers.get('x-amz-expected-bucket-owner') === d.accountId));
    composite = true;
    assert.equal((await adapter.verify(owned, s3)).status, 'unknown');
});
test('S3 wrong version size checksum or ACL owner is mismatch', async () => {
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    for (const field of ['version', 'size', 'checksum', 'owner']) {
        const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => '', fetch: async (input) => {
                const req = input as Request;
                if (req.method === 'GET')
                    return new Response('<Owner><ID>' + (field === 'owner' ? 'f'.repeat(64) : owned.s3.ownerCanonicalId) + '</ID></Owner>');
                return new Response(null, { headers: { 'content-length': field === 'size' ? '899' : '900', 'x-amz-version-id': field === 'version' ? 'v2' : s3.versionId, 'x-amz-checksum-sha256': Buffer.from(field === 'checksum' ? 'f'.repeat(64) : s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': 'FULL_OBJECT' } });
            } });
        assert.equal((await adapter.verify(owned, s3)).status, 'mismatch', field);
    }
});
test('HF settings PUT is a separate action with exact current commit and public postcondition', async () => {
    let publicRepo = false;
    const methods: string[] = [];
    const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => 'hf-private', fetch: async (input, init) => {
            const url = String(input);
            methods.push((init?.method ?? 'GET') + ' ' + url);
            if (init?.method === 'PUT') {
                assert.equal(url, 'https://huggingface.co/api/models/org/model/settings');
                assert.deepEqual(JSON.parse(String(init.body)), { visibility: 'public' });
                publicRepo = true;
                return Response.json({});
            }
            return Response.json({ id: 'org/model', sha: hf.commit, private: !publicRepo, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] });
        } });
    assert.equal((await adapter.publish(d, hf, publicationGuard)).status, 'verified');
    assert.equal(methods.filter(m => m.startsWith('PUT')).length, 1);
    assert.ok(methods.every(m => !m.includes('/resolve/')));
});
test('HF rejects wrong file OID and missing checksum evidence independently', async () => {
    for (const field of ['oid', 'checksum', 'commit', 'visibility']) {
        const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => 'hf-private', fetch: async () => Response.json({ id: 'org/model', sha: field === 'commit' ? 'f'.repeat(40) : hf.commit, private: field !== 'visibility', siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: field === 'oid' ? 'c'.repeat(40) : 'b'.repeat(40), ...(field === 'checksum' ? {} : { lfs: { sha256: 'd'.repeat(64), size: 900 } }) }] }) });
        assert.equal((await adapter.verify(d, hf)).status, field === 'checksum' ? 'unknown' : 'mismatch', field);
    }
});
test('version cleanup never deletes key without version and verifies absence', async () => {
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    let deleted = false;
    const methods: string[] = [];
    const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => '', fetch: async (input) => {
            const req = input as Request;
            assert.equal(new URL(req.url).searchParams.get('versionId'), 'version1');
            methods.push(req.method);
            if (req.method === 'DELETE') {
                deleted = true;
                return new Response(null, { status: 204 });
            }
            if (deleted)
                return new Response(null, { status: 404 });
            if (req.method === 'GET')
                return new Response('<Owner><ID>' + owned.s3.ownerCanonicalId + '</ID></Owner>');
            return new Response(null, { headers: { 'content-length': '900', 'x-amz-version-id': s3.versionId, 'x-amz-checksum-sha256': Buffer.from(s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': 'FULL_OBJECT' } });
        } });
    assert.equal((await adapter.cleanup(owned, s3)).status, 'verified');
    assert.deepEqual(methods, ['HEAD', 'GET', 'DELETE', 'HEAD']);
});
test('multipart native SHA256 is verified separately from an instance-reported whole-file hash', async () => {
    const native = Buffer.from('f'.repeat(64), 'hex').toString('base64') + '-3';
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    const adapter = createDelegatedProofAdapter({ authorizeS3: async (r) => r, hfToken: async () => '', fetch: async (input) => {
            if ((input as Request).method === 'GET')
                return new Response('<Owner><ID>' + owned.s3.ownerCanonicalId + '</ID></Owner>');
            return new Response(null, { headers: { 'content-length': '900', 'x-amz-version-id': s3.versionId, 'x-amz-checksum-sha256': native, 'x-amz-checksum-type': 'COMPOSITE' } });
        } });
    const receipt = { ...s3, checksum: { algorithm: 'SHA256' as const, type: 'COMPOSITE' as const, value: native } };
    const proof = await adapter.verify(owned, receipt);
    assert.equal(proof.status, 'verified');
    assert.equal(proof.checksumEvidence, 'native-composite');
    assert.equal(proof.code, 'native-composite-match');
    assert.equal((await adapter.verify(owned, { ...receipt, checksum: { ...receipt.checksum, value: native.slice(0, -1) + '2' } })).status, 'mismatch');
});
test('Worker fetch accepts only manual redirect mode for HF and signed S3 requests', async () => {
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    let signedInputManual = false;
    const adapter = createDelegatedProofAdapter({ hfToken: async () => 'hf-private', authorizeS3: async (req) => { signedInputManual = req.redirect === 'manual'; return new Request(req, { redirect: 'follow', headers: { ...Object.fromEntries(Array.from(['x-amz-expected-bucket-owner', 'x-amz-checksum-mode']).filter(k => req.headers.has(k)).map(k => [k, req.headers.get(k)!])), 'authorization': 'AWS-private' } }); }, fetch: async (input, init) => {
            const req = input instanceof Request ? input : new Request(input, init);
            if (req.redirect === 'error')
                throw new TypeError('unsupported redirect mode');
            assert.equal(req.redirect, 'manual');
            if (req.url.startsWith('https://huggingface.co/'))
                return Response.json({ id: d.hf.repo, sha: hf.commit, private: true, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] });
            if (req.method === 'GET')
                return new Response('<Owner><ID>' + owned.s3.ownerCanonicalId + '</ID></Owner>');
            return new Response(null, { headers: { 'content-length': '900', 'x-amz-version-id': s3.versionId, 'x-amz-checksum-sha256': Buffer.from(s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': 'FULL_OBJECT' } });
        } });
    assert.equal((await adapter.verify(d, hf)).status, 'verified');
    assert.equal((await adapter.verify(owned, s3)).status, 'verified');
    assert.equal(signedInputManual, true);
});
test('302 metadata responses never follow Location or forward provider secrets', async () => {
    for (const receipt of [hf, s3]) {
        const calls: Request[] = [];
        const adapter = createDelegatedProofAdapter({ hfToken: async () => 'hf-private', authorizeS3: async (req) => { const headers = new Headers(req.headers); headers.set('authorization', 'AWS-private'); return new Request(req, { headers }); }, fetch: async (input, init) => { const req = input instanceof Request ? input : new Request(input, init); calls.push(req); assert.equal(req.redirect, 'manual'); assert.notEqual(new URL(req.url).host, 'attacker.invalid'); return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/leak' } }); } });
        assert.equal((await adapter.verify(d, receipt)).status, 'unknown');
        assert.equal(calls.length, 1);
        assert.ok(calls[0]?.headers.has('authorization'));
    }
});
test('already redirected 200 metadata and redirected 404 cleanup proof are rejected', async () => {
    for (const receipt of [hf, s3]) {
        const adapter = createDelegatedProofAdapter({ hfToken: async () => 'hf-private', authorizeS3: async (req) => req, fetch: async () => { const r = Response.json({ id: d.hf.repo, sha: hf.commit, private: true, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] }); Object.defineProperty(r, 'redirected', { value: true }); return r; } });
        assert.equal((await adapter.verify(d, receipt)).status, 'unknown');
    }
});
test('signed S3 URL changes are rejected before fetch', async () => { let calls = 0; const adapter = createDelegatedProofAdapter({ hfToken: async () => '', authorizeS3: async (req) => new Request('https://attacker.invalid/', req), fetch: async () => { calls++; return new Response(null); } }); assert.equal((await adapter.verify(d, s3)).status, 'unknown'); assert.equal(calls, 0); });
test('HF publication 302 is unknown and never requests redirected target or public postcondition', async () => {
    const requests: Request[] = [];
    const adapter = createDelegatedProofAdapter({ hfToken: async () => 'hf-private', authorizeS3: async (req) => req, fetch: async (input, init) => {
            const req = input instanceof Request ? input : new Request(input, init);
            requests.push(req);
            if (req.method === 'PUT')
                return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/leak' } });
            return Response.json({ id: d.hf.repo, sha: hf.commit, private: true, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] });
        } });
    assert.equal((await adapter.publish(d, hf, publicationGuard)).status, 'unknown');
    assert.deepEqual(requests.map(r => r.method), ['GET', 'GET', 'GET', 'PUT']);
    assert.ok(requests.every(r => r.redirect === 'manual' && new URL(r.url).host === 'huggingface.co'));
});
test('S3 delete redirect and already redirected 404 cannot verify cleanup', async () => {
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    for (const mode of ['delete302', 'head404redirected']) {
        let deleted = false;
        const requests: Request[] = [];
        const adapter = createDelegatedProofAdapter({ hfToken: async () => '', authorizeS3: async (req) => req, fetch: async (input) => {
                const req = input as Request;
                requests.push(req);
                if (req.method === 'DELETE') {
                    deleted = true;
                    return new Response(null, { status: mode === 'delete302' ? 302 : 204, headers: { location: 'https://attacker.invalid/leak' } });
                }
                if (deleted) {
                    const r = new Response(null, { status: 404 });
                    Object.defineProperty(r, 'redirected', { value: true });
                    return r;
                }
                if (req.method === 'GET')
                    return new Response('<Owner><ID>' + owned.s3.ownerCanonicalId + '</ID></Owner>');
                return new Response(null, { headers: { 'content-length': '900', 'x-amz-version-id': s3.versionId, 'x-amz-checksum-sha256': Buffer.from(s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': 'FULL_OBJECT' } });
            } });
        assert.equal((await adapter.cleanup(owned, s3)).status, 'unknown');
        assert.equal(requests.length, mode === 'delete302' ? 3 : 4);
        assert.ok(requests.every(r => r.redirect === 'manual' && new URL(r.url).host === 'train-bucket.s3.us-east-2.amazonaws.com'));
    }
});
test('null or changed HEAD version never verifies or deletes a replacement object', async () => {
    const owned = { ...d, s3: { ...d.s3, ownerCanonicalId: 'e'.repeat(64) } };
    for (const actualVersion of ['null', 'replacement-version']) {
        const methods: string[] = [];
        const adapter = createDelegatedProofAdapter({ hfToken: async () => '', authorizeS3: async (req) => req, fetch: async (input) => { const req = input as Request; methods.push(req.method); return new Response(null, { headers: { 'content-length': String(s3.size), 'x-amz-version-id': actualVersion, 'x-amz-checksum-sha256': Buffer.from(s3.sha256!, 'hex').toString('base64'), 'x-amz-checksum-type': 'FULL_OBJECT' } }); } });
        assert.equal((await adapter.verify(owned, s3)).status, 'mismatch');
        assert.equal((await adapter.cleanup(owned, s3)).status, 'mismatch');
        assert.deepEqual(methods, ['HEAD', 'HEAD']);
        assert.equal((await adapter.verify(owned, { ...s3, versionId: 'null' })).status, 'unknown');
        assert.equal((await adapter.cleanup(owned, { ...s3, versionId: 'null' })).status, 'unknown');
        assert.deepEqual(methods, ['HEAD', 'HEAD']);
    }
});
test('private publication guard runs after HF token await immediately before PUT', async () => { let time = 100, tokens = 0, puts = 0, checks = 0; const adapter = createDelegatedProofAdapter({ hfToken: async () => { tokens++; if (tokens === 4)
        time = 200; return 'hf-private'; }, authorizeS3: async (r) => r, fetch: async (_input, init) => { if (init?.method === 'PUT')
        puts++; return Response.json({ id: d.hf.repo, sha: hf.commit, private: true, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] }); } }); const guard = { authorize: async () => { checks++; assert.equal(tokens, 4); }, assertValid: () => { if (time >= 150)
        throw Error('expired quality'); } }; assert.equal((await adapter.publish(d, hf, guard)).status, 'unknown'); assert.equal(tokens, 4); assert.equal(checks, 1); assert.equal(puts, 0); });
test('quality guard rechecks expiry after asynchronous current authority refresh', async () => { let time = 100, puts = 0; const adapter = createDelegatedProofAdapter({ hfToken: async () => 'hf-private', authorizeS3: async (r) => r, fetch: async (_input, init) => { if (init?.method === 'PUT')
        puts++; return Response.json({ id: d.hf.repo, sha: hf.commit, private: true, siblings: [{ rfilename: 'model.safetensors', size: 900, blobId: 'b'.repeat(40), lfs: { sha256: 'd'.repeat(64), size: 900 } }] }); } }); assert.equal((await adapter.publish(d, hf, { authorize: async () => { await Promise.resolve(); time = 200; }, assertValid: () => { if (time >= 150)
        throw Error('expired quality'); } })).status, 'unknown'); assert.equal(puts, 0); });
test('cleanup recovery reads only exact immutable version and does not repeat DELETE', async () => { const requests: Request[] = []; const adapter = createDelegatedProofAdapter({ hfToken: async () => '', authorizeS3: async (r) => r, fetch: async (input) => { requests.push(input as Request); return new Response(null, { status: 404 }); } }); assert.deepEqual(await adapter.cleanupState(d, s3), { status: 'verified', code: 'owned-version-absent' }); assert.equal(requests.length, 1); assert.equal(requests[0]?.method, 'HEAD'); assert.equal(new URL(requests[0]!.url).searchParams.get('versionId'), s3.versionId); assert.equal((await adapter.cleanupState(d, { ...s3, versionId: 'null' })).status, 'unknown'); assert.equal(requests.length, 1); });
