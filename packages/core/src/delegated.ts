import { createHash, randomUUID } from 'node:crypto';
import { DelegatedReceiptSchema, InputManifestSchema, WorkloadDescriptorSchema } from '../../contracts/src/delegated.js';
import type { DelegatedAuthority, DelegatedBinding, DelegatedControllerPorts, DelegatedLedger, HfReceipt, ProofResult, ReceiptRecord, WorkloadDescriptor } from '../../contracts/src/delegated.js';
export function canonicalDelegatedJson(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(canonicalDelegatedJson).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalDelegatedJson((value as Record<string, unknown>)[k])).join(',') + '}';
    return JSON.stringify(value);
}
export function workloadFingerprint(input: unknown): string { return createHash('sha256').update(canonicalDelegatedJson(WorkloadDescriptorSchema.parse(input))).digest('hex'); }
export function inputManifestDigest(input: unknown): string { return createHash('sha256').update(canonicalDelegatedJson(InputManifestSchema.parse(input))).digest('hex'); }
export function delegatedLedgerKey(binding: DelegatedBinding): string { return createHash('sha256').update(canonicalDelegatedJson(binding)).digest('hex'); }
export function createDelegatedController(p: DelegatedControllerPorts): DelegatedController {
    for (const port of [p.store?.read, p.store?.mutate, p.currentAuthority, p.authorizeInstance, p.budget?.reconcile, p.budget?.reserve, p.budget?.settle, p.proof?.verify, p.proof?.publish, p.proof?.publicationState, p.proof?.cleanup, p.proof?.cleanupState, p.qualityProof])
        if (typeof port !== 'function')
            throw Error('delegated proof ports required');
    const now = p.now ?? Date.now;
    const same = (a: unknown, b: unknown) => canonicalDelegatedJson(a) === canonicalDelegatedJson(b);
    async function authority(taskId: string, active = true): Promise<DelegatedAuthority> {
        const a = await p.currentAuthority(taskId);
        if (!a || a.binding.taskId !== taskId || !Number.isSafeInteger(a.binding.revision) || a.binding.revision < 1 || !/^i-[a-f0-9]{8,17}$/.test(a.binding.instanceId) || a.binding.descriptorHash !== workloadFingerprint(a.descriptor) || a.binding.workloadId !== a.descriptor.workloadId || a.binding.accountId !== a.descriptor.accountId || a.binding.region !== a.descriptor.region || !Number.isFinite(a.expiresAt) || (active && (!a.active || a.expiresAt <= now())))
            throw Error('delegated authority rejected');
        return structuredClone(a);
    }
    function owned(s: DelegatedLedger | undefined, a: DelegatedAuthority): DelegatedLedger {
        if (!s || !same(s.binding, a.binding) || !same(s.descriptor, a.descriptor))
            throw Error('delegated ledger binding rejected');
        return s;
    }
    async function recheck(a: DelegatedAuthority, active = true) {
        const next = await authority(a.binding.taskId, active);
        if (!same(next.binding, a.binding) || !same(next.descriptor, a.descriptor))
            throw Error('delegated authority changed');
    }
    const receipt = (s: DelegatedLedger, id: string) => {
        const r = s.receipts.find(r => r.receipt.receiptId === id);
        if (!r)
            throw Error('delegated receipt missing');
        return r;
    };
    const advance = (s: DelegatedLedger) => { s.generation++; return s; };
    const safeProof = async (fn: () => Promise<ProofResult>): Promise<ProofResult> => {
        try {
            const r = await fn();
            if (!r || !['verified', 'mismatch', 'unknown'].includes(r.status))
                throw Error();
            return { status: r.status, code: /^[a-z0-9_-]{1,64}$/.test(r.code) ? r.code : 'provider-result', ...(r.checksumEvidence === 'full-sha256' || r.checksumEvidence === 'native-composite' ? { checksumEvidence: r.checksumEvidence } : {}) };
        }
        catch {
            return { status: 'unknown', code: 'provider-unavailable' };
        }
    };
    async function start(a: DelegatedAuthority, id: string, kind: 'verify' | 'publish' | 'cleanup', extra?: (s: DelegatedLedger, r: ReceiptRecord) => void) {
        const op = randomUUID();
        const r = await p.store.mutate(delegatedLedgerKey(a.binding), state => {
            const s = owned(state, a);
            if (s.operation && !(kind === 'verify' && s.operation.kind === 'verify' && s.operation.receiptId === id))
                throw Error('delegated operation fenced');
            const r = receipt(s, id);
            extra?.(s, r);
            s.operation = { id: op, kind, receiptId: id };
            if (kind === 'verify')
                r.status = 'unverified';
            if (kind === 'cleanup') {
                r.cleanup = 'intent';
                r.cleanupAttemptId = op;
                delete r.cleanupSettlement;
            }
            return { state: advance(s), result: structuredClone(r) };
        });
        return { op, r };
    }
    async function finish<T>(a: DelegatedAuthority, op: string, fn: (s: DelegatedLedger) => T) {
        return p.store.mutate(delegatedLedgerKey(a.binding), state => {
            const s = owned(state, a);
            if (s.operation?.id !== op)
                throw Error('delegated operation stale');
            const result = fn(s);
            delete s.operation;
            return { state: advance(s), result };
        });
    }
    async function settleCleanup(a: DelegatedAuthority, id: string): Promise<ReceiptRecord> {
        const key = delegatedLedgerKey(a.binding), s = owned(await p.store.read(key), a), r = receipt(s, id);
        if (!s.reservationId)
            throw Error('delegated reservation missing');
        // The budget implementation must be idempotent by reservationId; no invoice is invented.
        try {
            await p.budget.settle({ reservationId: s.reservationId, actualBillingMicros: null, retained: s.receipts.some(r => r.receipt.kind === 's3' && r.cleanup !== 'deleted') });
        }
        catch (e) {
            await p.store.mutate(key, state => { const next = owned(state, a), record = receipt(next, id); if (record.cleanupAttemptId !== r.cleanupAttemptId || record.cleanup !== r.cleanup)
                throw Error('delegated settlement stale'); record.cleanupSettlement = 'unknown'; return { state: advance(next), result: undefined }; });
            throw e;
        }
        return p.store.mutate(key, state => { const next = owned(state, a), record = receipt(next, id); if (record.cleanupAttemptId !== r.cleanupAttemptId || record.cleanup !== r.cleanup)
            throw Error('delegated settlement stale'); record.cleanupSettlement = 'settled'; return { state: advance(next), result: record }; });
    }
    const controller: DelegatedController = {
        async register(taskId) {
            const a = await authority(taskId, false);
            const key = delegatedLedgerKey(a.binding);
            let existing = await p.store.read(key);
            if (existing?.registration.state === 'reserved')
                return owned(existing, a);
            if (!existing) {
                await recheck(a);
                const createdAt = now();
                const upperBoundMicros = delegatedReservedMicros(a.descriptor);
                const retentionUntil = createdAt + a.descriptor.s3.retentionMs;
                if (!Number.isSafeInteger(upperBoundMicros) || !Number.isSafeInteger(retentionUntil))
                    throw Error('delegated budget overflow');
                existing = await p.store.mutate(key, s => {
                    if (s)
                        return { state: owned(s, a), result: s };
                    const state: DelegatedLedger = { version: 1, binding: a.binding, descriptor: a.descriptor, generation: 0, reservationId: null, registration: { state: 'intent', retentionUntil }, reservedMicros: upperBoundMicros, actualBillingMicros: null, receipts: [], createdAt };
                    return { state, result: state };
                });
            }
            owned(existing, a);
            const intent = existing;
            try {
                let reservation = await p.budget.reconcile(key);
                if (!reservation) {
                    await recheck(a);
                    reservation = await p.budget.reserve({ key, binding: a.binding, upperBoundMicros: intent.reservedMicros, retentionUntil: intent.registration.retentionUntil });
                }
                if (!reservation?.reservationId || reservation.reservationId.length > 256)
                    throw Error('delegated reservation required');
                await recheck(a, false);
                return p.store.mutate(key, state => {
                    const s = owned(state, a);
                    if (s.registration.state === 'reserved') {
                        if (s.reservationId !== reservation.reservationId)
                            throw Error('delegated reservation changed');
                        return { state: s, result: s };
                    }
                    s.reservationId = reservation.reservationId;
                    s.registration.state = 'reserved';
                    return { state: advance(s), result: s };
                });
            }
            catch (e) {
                await p.store.mutate(key, state => {
                    const s = owned(state, a);
                    if (s.registration.state !== 'reserved') {
                        s.registration.state = 'unknown';
                        advance(s);
                    }
                    return { state: s, result: undefined };
                });
                throw e;
            }
        },
        async read(taskId) { const a = await authority(taskId, false); const s = await p.store.read(delegatedLedgerKey(a.binding)); return s ? owned(s, a) : undefined; },
        async report(taskId, context, input) {
            const a = await authority(taskId, false);
            if (!await p.authorizeInstance(a.binding, context, 'report'))
                throw Error('delegated instance rejected');
            const r = DelegatedReceiptSchema.parse(input);
            await recheck(a, false);
            if (r.kind === 's3') {
                if (r.bucket !== a.descriptor.s3.bucket || !r.key.startsWith(a.descriptor.s3.prefix) || r.ownerAccountId !== a.binding.accountId || r.size > a.descriptor.s3.maxObjectBytes)
                    throw Error('delegated S3 scope rejected');
            }
            else if (r.repo !== a.descriptor.hf.repo || r.visibility !== a.descriptor.hf.visibility)
                throw Error('delegated HF scope rejected');
            return p.store.mutate(delegatedLedgerKey(a.binding), state => {
                const s = owned(state, a);
                if (s.registration.state !== 'reserved')
                    throw Error('delegated registration incomplete');
                if (s.operation)
                    throw Error('delegated operation fenced');
                const old = s.receipts.find(x => x.receipt.receiptId === r.receiptId);
                if (old) {
                    if (!same(old.receipt, r))
                        throw Error('delegated receipt immutable');
                    return { state: s, result: old };
                }
                if (s.receipts.length >= 512)
                    throw Error('delegated receipt quota');
                if (r.kind === 's3') {
                    const objs = s.receipts.filter(x => x.receipt.kind === 's3');
                    if (objs.some(x => x.receipt.kind === 's3' && x.receipt.key === r.key && x.receipt.versionId === r.versionId) || objs.length >= a.descriptor.s3.maxObjects || objs.reduce((n, x) => n + (x.receipt.kind === 's3' ? x.receipt.size : 0), 0) + r.size > a.descriptor.s3.maxTotalBytes)
                        throw Error('delegated object quota');
                }
                const record: ReceiptRecord = { binding: a.binding, receipt: r, status: 'reported', reportedAt: now(), cleanup: 'retained', ...(r.kind === 's3' ? { wholeSha256Status: r.sha256 ? 'instance_report' as const : 'not_reported' as const } : {}) };
                s.receipts.push(record);
                return { state: advance(s), result: record };
            });
        },
        async verify(taskId, id) {
            const a = await authority(taskId, false);
            const { op, r } = await start(a, id, 'verify');
            const proof = await safeProof(() => p.proof.verify(a.descriptor, r.receipt));
            await recheck(a, false);
            return finish(a, op, s => {
                const r = receipt(s, id);
                r.status = proof.status;
                r.proofCode = proof.code;
                if (r.receipt.kind === 's3') {
                    r.checksumEvidence = proof.checksumEvidence;
                    r.wholeSha256Status = r.receipt.sha256 ? (proof.status === 'verified' && proof.checksumEvidence === 'full-sha256' ? 'verified' : 'instance_report') : 'not_reported';
                }
                r.verifiedAt = now();
                return r;
            });
        },
        async publish(taskId, id) {
            const a = await authority(taskId);
            const s = owned(await p.store.read(delegatedLedgerKey(a.binding)), a);
            const r = receipt(s, id);
            if (r.receipt.kind !== 'hf' || r.status !== 'verified' || r.receipt.visibility !== 'private' || !a.descriptor.releasePolicy.allowPublicTransition || s.publication)
                throw Error('delegated release rejected');
            const hf = r.receipt;
            const rawQuality = await p.qualityProof(a.binding, hf);
            const q = rawQuality ? structuredClone(rawQuality) : undefined;
            if (!q || !same(q.binding, a.binding) || q.receiptId !== id || q.commit !== hf.commit || q.policyId !== a.descriptor.releasePolicy.id || q.policyRevision !== a.descriptor.releasePolicy.revision || q.validUntil <= now() || !Number.isFinite(q.validUntil) || !q.proofId || !same([...new Set(q.gateIds)].sort(), [...a.descriptor.qualityGateIds].sort()))
                throw Error('trusted quality proof required');
            await recheck(a);
            const { op } = await start(a, id, 'publish', (s, r) => {
                if (s.publication || r.status !== 'verified' || !same(r.receipt, hf))
                    throw Error('delegated release changed');
                s.publication = { receiptId: id, commit: hf.commit, state: 'intent', at: now(), qualityProofId: q.proofId };
            });
            const pre = await safeProof(() => p.proof.verify(a.descriptor, hf));
            if (pre.status !== 'verified')
                return finish(a, op, s => { s.publication!.state = pre.status === 'mismatch' ? 'mismatch' : 'unknown'; return s.publication!; });
            await recheck(a);
            let currentExpiry = a.expiresAt;
            const guard = { authorize: async () => { const fresh = await authority(taskId); if (!same(fresh.binding, a.binding) || !same(fresh.descriptor, a.descriptor))
                    throw Error('delegated authority changed'); currentExpiry = fresh.expiresAt; guard.assertValid(); }, assertValid: () => { if (now() >= q.validUntil || now() >= currentExpiry)
                    throw Error('trusted quality proof expired'); } };
            await guard.authorize();
            guard.assertValid();
            const proof = await safeProof(() => p.proof.publish(a.descriptor, hf, guard));
            await recheck(a);
            return finish(a, op, s => { s.publication!.state = proof.status; return s.publication!; });
        },
        async recoverPublication(taskId) {
            const a = await authority(taskId, false);
            const s = owned(await p.store.read(delegatedLedgerKey(a.binding)), a);
            if (!s.publication || s.publication.state === 'verified' || s.publication.state === 'mismatch')
                throw Error('delegated publication not recoverable');
            const r = receipt(s, s.publication.receiptId);
            if (r.receipt.kind !== 'hf')
                throw Error('delegated release rejected');
            const proof = await safeProof(() => p.proof.publicationState(a.descriptor, r.receipt as HfReceipt));
            await recheck(a, false);
            return p.store.mutate(delegatedLedgerKey(a.binding), state => {
                const next = owned(state, a);
                if (next.publication?.commit !== s.publication!.commit || next.operation?.id !== s.operation?.id)
                    throw Error('delegated recovery stale');
                next.publication!.state = proof.status === 'verified' ? 'verified' : 'unknown';
                if (proof.status === 'verified' && next.operation?.kind === 'publish')
                    delete next.operation;
                return { state: advance(next), result: next.publication! };
            });
        },
        async cleanup(taskId, id) {
            const a = await authority(taskId, false);
            const previous = owned(await p.store.read(delegatedLedgerKey(a.binding)), a);
            const old = receipt(previous, id);
            if ((previous.operation?.kind === 'cleanup' && previous.operation.receiptId === id) || ['intent', 'unknown', 'deleted'].includes(old.cleanup))
                return controller.recoverCleanup(taskId, id);
            const { op, r } = await start(a, id, 'cleanup', (s, r) => { if (r.receipt.kind !== 's3' || r.status !== 'verified' || now() < s.registration.retentionUntil)
                throw Error('delegated cleanup rejected'); });
            if (r.receipt.kind !== 's3')
                throw Error('delegated cleanup rejected');
            const proof = await safeProof(() => p.proof.cleanup(a.descriptor, r.receipt as import('../../contracts/src/delegated.js').S3Receipt));
            await recheck(a, false);
            await finish(a, op, s => { const record = receipt(s, id); record.cleanup = proof.status === 'verified' ? 'deleted' : 'unknown'; record.cleanupSettlement = 'intent'; return record; });
            return settleCleanup(a, id);
        },
        async recoverCleanup(taskId, id) {
            const a = await authority(taskId, false), key = delegatedLedgerKey(a.binding);
            const s = owned(await p.store.read(key), a), r = receipt(s, id);
            if (r.receipt.kind !== 's3' || r.status !== 'verified' || now() < s.registration.retentionUntil || (s.operation && (s.operation.kind !== 'cleanup' || s.operation.receiptId !== id)) || (!r.cleanupAttemptId && r.cleanup === 'retained'))
                throw Error('delegated cleanup not recoverable');
            if (r.cleanup === 'deleted') {
                if (r.cleanupSettlement === 'settled')
                    return r;
                return settleCleanup(a, id);
            }
            const proof = await safeProof(() => p.proof.cleanupState(a.descriptor, r.receipt as import('../../contracts/src/delegated.js').S3Receipt));
            await recheck(a, false);
            await p.store.mutate(key, state => {
                const next = owned(state, a), record = receipt(next, id);
                if (next.operation?.id !== s.operation?.id || record.cleanupAttemptId !== r.cleanupAttemptId || record.cleanup !== r.cleanup)
                    throw Error('delegated cleanup recovery stale');
                if (proof.status === 'verified') {
                    record.cleanup = 'deleted';
                    delete next.operation;
                }
                else if (proof.status === 'mismatch' && proof.code === 'owned-version-present') {
                    record.cleanup = 'retained';
                    delete next.operation;
                }
                else
                    record.cleanup = 'unknown';
                record.cleanupSettlement = 'intent';
                return { state: advance(next), result: record };
            });
            return settleCleanup(a, id);
        },
    };
    return controller;
}
export interface DelegatedController {
    register(taskId: string): Promise<import('../../contracts/src/delegated.js').DelegatedLedger>;
    report(taskId: string, privateContext: unknown, receipt: unknown): Promise<import('../../contracts/src/delegated.js').ReceiptRecord>;
    verify(taskId: string, receiptId: string): Promise<import('../../contracts/src/delegated.js').ReceiptRecord>;
    publish(taskId: string, receiptId: string): Promise<import('../../contracts/src/delegated.js').PublicationIntent>;
    recoverPublication(taskId: string): Promise<import('../../contracts/src/delegated.js').PublicationIntent>;
    recoverCleanup(taskId: string, receiptId: string): Promise<ReceiptRecord>;
    cleanup(taskId: string, receiptId: string): Promise<import('../../contracts/src/delegated.js').ReceiptRecord>;
    read(taskId: string): Promise<import('../../contracts/src/delegated.js').DelegatedLedger | undefined>;
}
export function delegatedReservedMicros(d: WorkloadDescriptor): number { return d.s3.storageReserveMicros + d.s3.requestReserveMicros + d.s3.transferReserveMicros; }
