import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDelegatedStore } from '../packages/core/src/delegated-store.js';
import { SqliteDelegatedStore } from '../packages/core/src/delegated-node-store.js';
import { delegatedLedgerKey, workloadFingerprint } from '../packages/core/src/delegated.js';
import type { DelegatedLedger, WorkloadDescriptor } from '../packages/contracts/src/delegated.js';
const d: WorkloadDescriptor = { version: 1, workloadId: 'train', amiId: 'ami-12345678', bootstrapSha256: 'a'.repeat(64), inputManifestDigests: ['b'.repeat(64)], iam: { instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/train', policyRevision: 'v1', policySha256: 'c'.repeat(64) }, accountId: '123456789012', region: 'us-east-2', availabilityZoneId: 'use2-az1', s3: { bucket: 'train-bucket', prefix: 'tasks/t1/', maxObjects: 4, maxObjectBytes: 1000, maxTotalBytes: 2000, retentionMs: 60000, storageReserveMicros: 10, requestReserveMicros: 20, transferReserveMicros: 30 }, hf: { repo: 'org/model', visibility: 'private', tokenRef: 'hf-scoped', delivery: { mode: 'instance-private-envelope', audience: 'central', path: '/run/hivemind/hf-token', fileMode: '0600', ttlMs: 60000, trainingEnvironment: false } }, qualityGateIds: ['eval'], releasePolicy: { id: 'release', revision: 'v1', allowPublicTransition: true } };
function state(): DelegatedLedger { return { version: 1, binding: { taskId: 't1', revision: 1, instanceId: 'i-12345678', accountId: d.accountId, region: d.region, workloadId: d.workloadId, descriptorHash: workloadFingerprint(d) }, descriptor: d, generation: 0, reservationId: 'r1', registration: { state: 'reserved', retentionUntil: 60100 }, reservedMicros: 60, actualBillingMicros: null, receipts: [], createdAt: 100 }; }
for (const mode of ['memory', 'sqlite'])
    test(mode + ' store is atomic, clones values, persists fences, rejects asynchronous writes', async () => { const dir = mkdtempSync(join(tmpdir(), 'delegated-')); const path = join(dir, 'store.db'); const s = mode === 'sqlite' ? new SqliteDelegatedStore(path) : new MemoryDelegatedStore(); try {
        const initial = state();
        const key = delegatedLedgerKey(initial.binding);
        await s.mutate(key, () => ({ state: initial, result: true }));
        initial.generation = 20;
        assert.equal((await s.read(key))?.generation, 0);
        await assert.rejects(s.mutate(key, v => { v!.generation++; throw Error('rollback'); }));
        assert.equal((await s.read(key))?.generation, 0);
        await s.mutate(key, v => { v!.generation++; v!.operation = { id: 'op1', kind: 'publish', receiptId: 'r1' }; return { state: v!, result: true }; });
        if (mode === 'sqlite') {
            s.close();
            const reopened = new SqliteDelegatedStore(path);
            assert.equal((await reopened.read(key))?.operation?.id, 'op1');
            reopened.close();
        }
        else
            assert.equal((await s.read(key))?.operation?.id, 'op1');
    }
    finally {
        s.close();
        rmSync(dir, { recursive: true, force: true });
    } });
test('memory store rejects async callbacks, stale fences, mutated identity and capacity overflow', async () => { const s = new MemoryDelegatedStore({ maxLedgers: 1 }); const initial = state(), key = delegatedLedgerKey(initial.binding); await s.mutate(key, () => ({ state: initial, result: 0 })); await assert.rejects(s.mutate(key, (async (v: DelegatedLedger | undefined) => ({ state: v!, result: 0 })) as never)); await assert.rejects(s.mutate(key, v => { v!.operation = { id: 'op', kind: 'verify', receiptId: 'r1' }; return { state: v!, result: 0 }; })); await assert.rejects(s.mutate(key, v => { v!.binding.instanceId = 'i-87654321'; v!.generation++; return { state: v!, result: 0 }; })); const other = state(); other.binding.instanceId = 'i-87654321'; await assert.rejects(s.mutate(delegatedLedgerKey(other.binding), () => ({ state: other, result: 0 }))); assert.equal((await s.read(key))?.generation, 0); });
test('Worker SQL store bounds every chunk and atomically rolls back a partial large write', async () => { const { DatabaseSync } = await import('node:sqlite'); const { createDelegatedSqlStore } = await import('../packages/core/src/delegated-store.js'); const db = new DatabaseSync(':memory:'); let fail = false; let largest = 0; const store = createDelegatedSqlStore({ exec(q, ...b) { for (const v of b)
        if (typeof v === 'string')
            largest = Math.max(largest, Buffer.byteLength(v)); if (fail && q.startsWith('INSERT INTO delegated_chunks') && b[1] === 1)
        throw Error('write failed'); const stmt = db.prepare(q); return stmt.columns().length ? stmt.all(...b) : (stmt.run(...b), []); }, transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try {
        const out = fn();
        db.exec('COMMIT');
        return out;
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    } } }); try {
    const initial = state(), key = delegatedLedgerKey(initial.binding);
    await store.mutate(key, () => ({ state: initial, result: 0 }));
    const big = structuredClone(initial);
    big.generation++;
    for (let i = 0; i < 250; i++)
        big.receipts.push({ binding: big.binding, receipt: { kind: 'hf', receiptId: 'hf' + i, repo: d.hf.repo, commit: 'a'.repeat(40), visibility: 'private', files: [{ path: 'model' + i + '.bin', size: 900, oid: 'b'.repeat(40), sha256: 'c'.repeat(64) }] }, status: 'reported', reportedAt: 100, cleanup: 'retained' });
    fail = true;
    await assert.rejects(store.mutate(key, () => ({ state: big, result: 0 })));
    assert.equal((await store.read(key))?.receipts.length, 0);
    fail = false;
    await store.mutate(key, () => ({ state: big, result: 0 }));
    assert.equal((await store.read(key))?.receipts.length, 250);
    assert.ok(largest <= 96 * 1024);
    db.prepare('UPDATE delegated_chunks SET data=? WHERE key=? AND ordinal=0').run('AAAA', key);
    await assert.rejects(store.read(key));
}
finally {
    db.close();
} });
