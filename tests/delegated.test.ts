import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDelegatedStore } from '../packages/core/src/delegated-store.js';
import { createDelegatedController, workloadFingerprint, inputManifestDigest } from '../packages/core/src/delegated.js';
import type { DelegatedAuthority, DelegatedControllerPorts, WorkloadDescriptor } from '../packages/contracts/src/delegated.js';
export const descriptor: WorkloadDescriptor = { version: 1, workloadId: 'train', amiId: 'ami-12345678', bootstrapSha256: 'a'.repeat(64), inputManifestDigests: ['b'.repeat(64)], iam: { instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/train', policyRevision: 'v1', policySha256: 'c'.repeat(64) }, accountId: '123456789012', region: 'us-east-2', availabilityZoneId: 'use2-az1', s3: { bucket: 'train-bucket', prefix: 'tasks/t1/', maxObjects: 4, maxObjectBytes: 1000, maxTotalBytes: 2000, retentionMs: 60000, storageReserveMicros: 10, requestReserveMicros: 20, transferReserveMicros: 30 }, hf: { repo: 'org/model', visibility: 'private', tokenRef: 'hf-scoped', delivery: { mode: 'instance-private-envelope', audience: 'central', path: '/run/hivemind/hf-token', fileMode: '0600', ttlMs: 60000, trainingEnvironment: false } }, qualityGateIds: ['eval'], releasePolicy: { id: 'release', revision: 'v1', allowPublicTransition: true } };
function fixture() { const store = new MemoryDelegatedStore(); const a: DelegatedAuthority = { binding: { taskId: 't1', revision: 1, workloadId: 'train', descriptorHash: workloadFingerprint(descriptor), instanceId: 'i-12345678', accountId: '123456789012', region: 'us-east-2' }, descriptor: structuredClone(descriptor), active: true, expiresAt: 10000 }; let reserved = 0; const ports: DelegatedControllerPorts = { store, currentAuthority: async () => structuredClone(a), authorizeInstance: async (_b, c) => c === 'private', budget: { reconcile: async () => undefined, reserve: async () => { reserved++; return { reservationId: 'reserve-1' }; }, settle: async () => { } }, proof: { cleanupState: async () => ({ status: 'verified', code: 'owned-version-absent' }), verify: async () => ({ status: 'verified', code: 'match' }), publish: async () => ({ status: 'verified', code: 'public' }), publicationState: async () => ({ status: 'verified', code: 'public' }), cleanup: async () => ({ status: 'verified', code: 'deleted' }) }, qualityProof: async () => undefined, now: () => 100 }; return { ports, a, reserved: () => reserved }; }
const s3 = { kind: 's3', receiptId: 'r1', bucket: 'train-bucket', key: 'tasks/t1/model.bin', versionId: 'version1', size: 900, sha256: 'd'.repeat(64), ownerAccountId: '123456789012' };
test('canonical descriptor binds every policy and input; manifest rejects execution injection', () => {
    assert.equal(workloadFingerprint(descriptor), workloadFingerprint(JSON.parse(JSON.stringify(descriptor))));
    for (const change of [() => ({ ...descriptor, bootstrapSha256: 'd'.repeat(64) }), () => ({ ...descriptor, iam: { ...descriptor.iam, policyRevision: 'v2' } }), () => ({ ...descriptor, hf: { ...descriptor.hf, visibility: 'public' } })])
        assert.notEqual(workloadFingerprint(change()), workloadFingerprint(descriptor));
    assert.throws(() => inputManifestDigest({ version: 1, code: { id: 'code', sha256: 'a'.repeat(64) }, data: [], arguments: { x: 'https://evil/x' } }));
    assert.throws(() => inputManifestDigest({ version: 1, code: { id: 'code', sha256: 'a'.repeat(64) }, data: [], arguments: {}, UserData: 'sh' }));
});
test('report requires server authority and private instance authentication; reported is never verified', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); assert.equal(f.reserved(), 1); await assert.rejects(c.report('t1', 'forged', s3)); const r = await c.report('t1', 'private', s3); assert.equal(r.status, 'reported'); assert.equal((await c.read('t1'))?.actualBillingMicros, null); assert.equal((await c.verify('t1', 'r1')).status, 'verified'); f.a.active = false; await assert.rejects(c.report('t1', 'forged', { ...s3, receiptId: 'r2' })); });
const hf = { kind: 'hf' as const, receiptId: 'hf1', repo: 'org/model', commit: 'a'.repeat(40), visibility: 'private' as const, files: [{ path: 'model.bin', size: 900, oid: 'b'.repeat(40) }] };
test('public transition requires independent receipt and exact trusted quality proof, never request booleans', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); await assert.rejects(c.report('t1', 'private', { ...hf, passed: true })); await c.report('t1', 'private', hf); await assert.rejects(c.publish('t1', 'hf1')); await c.verify('t1', 'hf1'); await assert.rejects(c.publish('t1', 'hf1')); f.ports.qualityProof = async () => ({ binding: f.a.binding, receiptId: 'hf1', commit: hf.commit, gateIds: ['eval'], policyId: 'release', policyRevision: 'v1', validUntil: 1000, proofId: 'trusted-1' }); assert.equal((await c.publish('t1', 'hf1')).state, 'verified'); await assert.rejects(c.publish('t1', 'hf1')); });
test('ambiguous public write persists intent and recovery never repeats PUT', async () => { const f = fixture(); let writes = 0; f.ports.qualityProof = async () => ({ binding: f.a.binding, receiptId: 'hf1', commit: hf.commit, gateIds: ['eval'], policyId: 'release', policyRevision: 'v1', validUntil: 1000, proofId: 'trusted-1' }); f.ports.proof.publish = async () => { writes++; throw Error('lost response'); }; const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', hf); await c.verify('t1', 'hf1'); assert.equal((await c.publish('t1', 'hf1')).state, 'unknown'); assert.equal((await c.recoverPublication('t1')).state, 'verified'); assert.equal(writes, 1); });
test('recovery while PUT is still running cannot conclude private means failed or erase write fence', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>(r => release = r);
    f.ports.qualityProof = async () => ({ binding: f.a.binding, receiptId: 'hf1', commit: hf.commit, gateIds: ['eval'], policyId: 'release', policyRevision: 'v1', validUntil: 1000, proofId: 'trusted-1' });
    f.ports.proof.publish = async () => { await held; return { status: 'verified', code: 'public' }; };
    f.ports.proof.publicationState = async () => ({ status: 'mismatch', code: 'repository-state-mismatch' });
    const c = createDelegatedController(f.ports);
    await c.register('t1');
    await c.report('t1', 'private', hf);
    await c.verify('t1', 'hf1');
    const publishing = c.publish('t1', 'hf1');
    while (!(await c.read('t1'))?.operation)
        await new Promise(r => setImmediate(r));
    assert.equal((await c.recoverPublication('t1')).state, 'unknown');
    assert.equal((await c.read('t1'))?.operation?.kind, 'publish');
    release();
    assert.equal((await publishing).state, 'verified');
});
test('S3 quotas and retention prevent unapproved costs and deletion, unknown billing remains null', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', s3); await assert.rejects(c.report('t1', 'private', { ...s3, receiptId: 'r2' })); await assert.rejects(c.report('t1', 'private', { ...s3, receiptId: 'r2', key: 'other/model.bin' })); await c.verify('t1', 'r1'); await assert.rejects(c.cleanup('t1', 'r1')); f.ports.now = () => 100000; f.a.expiresAt = 200000; const reopened = createDelegatedController(f.ports); assert.equal((await reopened.cleanup('t1', 'r1')).cleanup, 'deleted'); assert.equal((await reopened.read('t1'))?.actualBillingMicros, null); });
test('missing independent proof ports fails closed', () => { const f = fixture(); assert.throws(() => createDelegatedController({ ...f.ports, proof: undefined as never })); });
test('reserve committed then reply lost recovers fixed durable intent without another charge after cancellation', async () => { const f = fixture(); let calls = 0; let committed = false; const reserveInputs: unknown[] = []; f.ports.budget.reserve = async (input) => { calls++; reserveInputs.push(input); committed = true; throw Error('ack lost'); }; f.ports.budget.reconcile = async () => committed ? { reservationId: 'committed-1' } : undefined; const c = createDelegatedController(f.ports); await assert.rejects(c.register('t1')); const intent = await c.read('t1'); assert.equal(intent?.registration.state, 'unknown'); f.a.active = false; const recovered = await c.register('t1'); assert.equal(recovered.registration.state, 'reserved'); assert.equal(recovered.reservationId, 'committed-1'); assert.equal(recovered.registration.retentionUntil, intent?.registration.retentionUntil); assert.equal(calls, 1); assert.equal(reserveInputs.length, 1); assert.equal(recovered.actualBillingMicros, null); });
test('historical authenticated final metadata accepted without enabling publication or new execution', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); f.a.active = false; assert.equal((await c.report('t1', 'private', s3)).status, 'reported'); await assert.rejects(c.publish('t1', 'hf1')); });
test('canonical fingerprint survives JSON roundtrip of optional absent fields', () => { assert.equal(workloadFingerprint({ ...descriptor, awsDelivery: undefined }), workloadFingerprint(descriptor)); });
test('mutable unversioned S3 receipts and manifest URL or shell forms are rejected', async () => {
    const f = fixture();
    const c = createDelegatedController(f.ports);
    await c.register('t1');
    await assert.rejects(c.report('t1', 'private', { ...s3, versionId: 'null' }));
    for (const value of ['https://evil/a', '$(cat token)', 'abc;sh', '../private'])
        assert.throws(() => inputManifestDigest({ version: 1, code: { id: 'safe', sha256: 'a'.repeat(64) }, data: [], arguments: { x: value } }));
});
test('independent reconciliation may verify historical receipt after cancellation and expiry', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', s3); f.a.active = false; f.a.expiresAt = 50; assert.equal((await c.verify('t1', 'r1')).status, 'verified'); });
test('read-only verification can recover a durable abandoned verification fence', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', s3); const { delegatedLedgerKey } = await import('../packages/core/src/delegated.js'); await f.ports.store.mutate(delegatedLedgerKey(f.a.binding), s => { s!.generation++; s!.operation = { id: 'old-operation', kind: 'verify', receiptId: 'r1' }; s!.receipts[0]!.status = 'unverified'; return { state: s!, result: 0 }; }); assert.equal((await c.verify('t1', 'r1')).status, 'verified'); });
test('controller persists native composite evidence without upgrading whole-file instance hash', async () => { const f = fixture(); f.ports.proof.verify = async () => ({ status: 'verified', code: 'native-composite-match', checksumEvidence: 'native-composite' }); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', { ...s3, checksum: { algorithm: 'SHA256', type: 'COMPOSITE', value: Buffer.from('f'.repeat(64), 'hex').toString('base64') + '-3' } }); const record = await c.verify('t1', 'r1'); assert.equal(record.status, 'verified'); assert.equal(record.checksumEvidence, 'native-composite'); assert.equal(record.wholeSha256Status, 'instance_report'); assert.equal((await c.read('t1'))?.receipts[0]?.wholeSha256Status, 'instance_report'); });
test('approved instance role scoped delivery duration matches GSC 1 through 120 seconds', () => { const delivery = { mode: 'instance_role_scoped' as const, policySha256: 'a'.repeat(64), durationSeconds: 120, purpose: 'delegated-upload' as const, roleArn: 'arn:aws:iam::123456789012:role/train' }; assert.doesNotThrow(() => workloadFingerprint({ ...descriptor, awsDelivery: delivery })); assert.doesNotThrow(() => workloadFingerprint({ ...descriptor, awsDelivery: { ...delivery, durationSeconds: 1 } })); for (const durationSeconds of [0, 121, 900])
    assert.throws(() => workloadFingerprint({ ...descriptor, awsDelivery: { ...delivery, durationSeconds } })); });
test('quality expiry during independent preflight prevents invoking publication transport', async () => { const f = fixture(); let time = 100, writes = 0; f.ports.now = () => time; f.ports.qualityProof = async () => ({ binding: f.a.binding, receiptId: 'hf1', commit: hf.commit, gateIds: ['eval'], policyId: 'release', policyRevision: 'v1', validUntil: 150, proofId: 'quality' }); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', hf); await c.verify('t1', 'hf1'); f.ports.proof.verify = async () => { time = 151; return { status: 'verified', code: 'match' }; }; f.ports.proof.publish = async () => { writes++; return { status: 'verified', code: 'public' }; }; try {
    await c.publish('t1', 'hf1');
}
catch { } assert.equal(writes, 0); assert.notEqual((await c.read('t1'))?.publication?.state, 'verified'); });
test('restart cleanup fence reconciles exact version without repeating DELETE and resumes lost settlement', async () => { const f = fixture(); let deletes = 0, settles = 0; const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', s3); await c.verify('t1', 'r1'); f.ports.now = () => 100000; f.ports.proof.cleanup = async () => { deletes++; return { status: 'verified', code: 'deleted' }; }; f.ports.proof.cleanupState = async () => ({ status: 'verified', code: 'owned-version-absent' }); f.ports.budget.settle = async () => { settles++; if (settles === 1)
    throw Error('settlement ack lost'); }; const { delegatedLedgerKey } = await import('../packages/core/src/delegated.js'); await f.ports.store.mutate(delegatedLedgerKey(f.a.binding), s => { s!.generation++; s!.operation = { id: 'old-delete', kind: 'cleanup', receiptId: 'r1' }; s!.receipts[0]!.cleanup = 'intent'; return { state: s!, result: 0 }; }); const restarted = createDelegatedController(f.ports); await assert.rejects(restarted.cleanup('t1', 'r1')); assert.equal((await restarted.read('t1'))?.receipts[0]?.cleanup, 'deleted'); const again = createDelegatedController(f.ports); assert.equal((await again.cleanup('t1', 'r1')).cleanup, 'deleted'); assert.equal(deletes, 0); assert.equal(settles, 2); assert.equal((await again.read('t1'))?.actualBillingMicros, null); });
test('cleanup DELETE acknowledgement loss reconciles absence and never repeats destructive request', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', s3); await c.verify('t1', 'r1'); f.ports.now = () => 100000; let deletes = 0; f.ports.proof.cleanup = async () => { deletes++; throw Error('DELETE committed response lost'); }; f.ports.proof.cleanupState = async () => ({ status: 'verified', code: 'owned-version-absent' }); assert.equal((await createDelegatedController(f.ports).cleanup('t1', 'r1')).cleanup, 'unknown'); assert.equal((await createDelegatedController(f.ports).cleanup('t1', 'r1')).cleanup, 'deleted'); assert.equal(deletes, 1); });
test('recovery of still-present owned version is read-only and releases abandoned cleanup fence', async () => { const f = fixture(); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', s3); await c.verify('t1', 'r1'); f.ports.now = () => 100000; let deletes = 0; f.ports.proof.cleanup = async () => { deletes++; return { status: 'unknown', code: 'lost' }; }; await createDelegatedController(f.ports).cleanup('t1', 'r1'); f.ports.proof.cleanupState = async () => ({ status: 'mismatch', code: 'owned-version-present' }); assert.equal((await createDelegatedController(f.ports).cleanup('t1', 'r1')).cleanup, 'retained'); assert.equal(deletes, 1); assert.equal((await c.read('t1'))?.operation, undefined); });
test('SQLite reopen recovers persisted cleanup intent and settlement acknowledgement loss', async () => { const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { SqliteDelegatedStore } = await import('../packages/core/src/delegated-node-store.js'); const { delegatedLedgerKey } = await import('../packages/core/src/delegated.js'); const dir = mkdtempSync(join(tmpdir(), 'delegated-cleanup-')), path = join(dir, 'ledger.db'); const f = fixture(); let store = new SqliteDelegatedStore(path); f.ports.store = store; try {
    const c = createDelegatedController(f.ports);
    await c.register('t1');
    await c.report('t1', 'private', s3);
    await c.verify('t1', 'r1');
    await store.mutate(delegatedLedgerKey(f.a.binding), s => { s!.generation++; s!.operation = { id: 'crashed-delete', kind: 'cleanup', receiptId: 'r1' }; s!.receipts[0]!.cleanup = 'intent'; return { state: s!, result: 0 }; });
    store.close();
    store = new SqliteDelegatedStore(path);
    f.ports.store = store;
    f.ports.now = () => 100000;
    let deletes = 0, settles = 0;
    f.ports.proof.cleanup = async () => { deletes++; throw Error('unexpected destructive retry'); };
    f.ports.proof.cleanupState = async () => ({ status: 'verified', code: 'owned-version-absent' });
    f.ports.budget.settle = async () => { settles++; if (settles === 1)
        throw Error('settle reply lost'); };
    await assert.rejects(createDelegatedController(f.ports).cleanup('t1', 'r1'));
    assert.equal((await createDelegatedController(f.ports).read('t1'))?.receipts[0]?.cleanupSettlement, 'unknown');
    store.close();
    store = new SqliteDelegatedStore(path);
    f.ports.store = store;
    assert.equal((await createDelegatedController(f.ports).cleanup('t1', 'r1')).cleanupSettlement, 'settled');
    assert.equal(deletes, 0);
    assert.equal(settles, 2);
    assert.equal((await createDelegatedController(f.ports).read('t1'))?.actualBillingMicros, null);
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('concrete publication adapter rechecks current workload after internal metadata awaits on cancellation', async () => { const { createDelegatedProofAdapter } = await import('../packages/adapters/src/delegated-proof.js'); const f = fixture(); let gets = 0, puts = 0; f.ports.proof = createDelegatedProofAdapter({ hfToken: async () => 'hf-private', authorizeS3: async (r) => r, fetch: async (_input, init) => { if (init?.method === 'PUT')
        puts++;
    else
        gets++; if (gets === 7)
        f.a.active = false; return Response.json({ id: descriptor.hf.repo, sha: hf.commit, private: true, siblings: hf.files.map(file => ({ rfilename: file.path, size: file.size, blobId: file.oid })) }); } }); f.ports.qualityProof = async () => ({ binding: f.a.binding, receiptId: 'hf1', commit: hf.commit, gateIds: ['eval'], policyId: 'release', policyRevision: 'v1', validUntil: 1000, proofId: 'quality' }); const c = createDelegatedController(f.ports); await c.register('t1'); await c.report('t1', 'private', hf); await c.verify('t1', 'hf1'); await assert.rejects(c.publish('t1', 'hf1')); assert.equal(puts, 0); assert.ok(gets >= 7); });
