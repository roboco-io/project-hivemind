import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DelegatedReceiptSchema, WorkloadDescriptorSchema } from '../../contracts/src/delegated.js';
import type { DelegatedLedger, DelegatedStore } from '../../contracts/src/delegated.js';
import { canonicalDelegatedJson, delegatedLedgerKey, delegatedReservedMicros, workloadFingerprint } from './delegated.js';
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(256);
const binding = z.strictObject({ taskId: text, revision: uint.positive(), workloadId: text, descriptorHash: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.string().regex(/^i-[a-f0-9]{8,17}$/), accountId: z.string().regex(/^[0-9]{12}$/), region: text });
const schema = z.strictObject({ version: z.literal(1), binding, descriptor: WorkloadDescriptorSchema, generation: uint, reservationId: text.nullable(), registration: z.strictObject({ state: z.enum(['intent', 'reserved', 'unknown']), retentionUntil: uint }), reservedMicros: uint, actualBillingMicros: uint.nullable(), receipts: z.array(z.strictObject({ binding, receipt: DelegatedReceiptSchema, status: z.enum(['reported', 'unverified', 'verified', 'mismatch', 'unknown']), reportedAt: uint, verifiedAt: uint.optional(), proofCode: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional(), checksumEvidence: z.enum(['full-sha256', 'native-composite']).optional(), wholeSha256Status: z.enum(['instance_report', 'verified', 'not_reported']).optional(), cleanupAttemptId: text.optional(), cleanupSettlement: z.enum(['intent', 'unknown', 'settled']).optional(), cleanup: z.enum(['retained', 'intent', 'deleted', 'unknown']) })).max(512), publication: z.strictObject({ receiptId: text, commit: z.string().regex(/^[a-f0-9]{40}$/), state: z.enum(['intent', 'verified', 'mismatch', 'unknown']), at: uint, qualityProofId: text }).optional(), operation: z.strictObject({ id: text, kind: z.enum(['verify', 'publish', 'cleanup']), receiptId: text }).optional(), createdAt: uint });
export interface DelegatedStoreLimits {
    maxLedgers?: number;
    maxLedgerBytes?: number;
    maxTotalBytes?: number;
}
export function delegatedStoreLimits(options: DelegatedStoreLimits) {
    const result = { maxLedgers: options.maxLedgers ?? 128, maxLedgerBytes: options.maxLedgerBytes ?? 524288, maxTotalBytes: options.maxTotalBytes ?? 33554432 };
    for (const v of Object.values(result))
        if (!Number.isSafeInteger(v) || v < 1)
            throw Error('delegated store limits rejected');
    return result;
}
export function validateDelegatedLedger(key: string, value: unknown): DelegatedLedger {
    if (!/^[a-f0-9]{64}$/.test(key))
        throw Error('delegated store key rejected');
    const s = schema.parse(value);
    if (delegatedLedgerKey(s.binding) !== key || workloadFingerprint(s.descriptor) !== s.binding.descriptorHash || s.descriptor.workloadId !== s.binding.workloadId || s.descriptor.accountId !== s.binding.accountId || s.descriptor.region !== s.binding.region || s.reservedMicros !== delegatedReservedMicros(s.descriptor))
        throw Error('delegated stored identity rejected');
    if (s.receipts.some(r => canonicalDelegatedJson(r.binding) !== canonicalDelegatedJson(s.binding)) || new Set(s.receipts.map(r => r.receipt.receiptId)).size !== s.receipts.length)
        throw Error('delegated stored receipt rejected');
    return s;
}
export function prepareDelegatedMutation<T>(key: string, old: DelegatedLedger | undefined, fn: (s: DelegatedLedger | undefined) => {
    state: DelegatedLedger;
    result: T;
}) {
    if (fn.constructor.name === 'AsyncFunction')
        throw Error('delegated synchronous mutation required');
    const out = fn(structuredClone(old));
    if (out && typeof (out as unknown as {
        then?: unknown;
    }).then === 'function') {
        void Promise.resolve(out).catch(() => { });
        throw Error('delegated synchronous mutation required');
    }
    const state = validateDelegatedLedger(key, out.state);
    if (old && (canonicalDelegatedJson(state.binding) !== canonicalDelegatedJson(old.binding) || canonicalDelegatedJson(state.descriptor) !== canonicalDelegatedJson(old.descriptor) || (old.reservationId !== null && state.reservationId !== old.reservationId) || state.generation < old.generation || state.generation > old.generation + 1))
        throw Error('delegated stored fence rejected');
    if (old && canonicalDelegatedJson(state) !== canonicalDelegatedJson(old) && state.generation !== old.generation + 1)
        throw Error('delegated generation stale');
    if (old && state.registration.retentionUntil !== old.registration.retentionUntil)
        throw Error('delegated retention immutable');
    return { state, result: structuredClone(out.result), json: JSON.stringify(state) };
}
export class MemoryDelegatedStore implements DelegatedStore {
    private states = new Map<string, string>();
    private bounds: ReturnType<typeof delegatedStoreLimits>;
    constructor(options: DelegatedStoreLimits = {}) { this.bounds = delegatedStoreLimits(options); }
    async read(key: string) { const value = this.states.get(key); return value === undefined ? undefined : validateDelegatedLedger(key, JSON.parse(value)); }
    async mutate<T>(key: string, fn: (s: DelegatedLedger | undefined) => {
        state: DelegatedLedger;
        result: T;
    }): Promise<T> {
        const old = this.states.get(key);
        const { result, json } = prepareDelegatedMutation(key, old ? validateDelegatedLedger(key, JSON.parse(old)) : undefined, fn);
        const bytes = Buffer.byteLength(json);
        let total = bytes;
        for (const [k, v] of this.states)
            if (k !== key)
                total += Buffer.byteLength(v);
        if (bytes > this.bounds.maxLedgerBytes || total > this.bounds.maxTotalBytes || (!old && this.states.size >= this.bounds.maxLedgers))
            throw Error('delegated store quota');
        this.states.set(key, json);
        return result;
    }
    close() { }
}
/** Durable Object SQLite port. transactionSync must rollback when its callback throws. */
export interface DelegatedSqlPort {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>;
    transactionSync<T>(fn: () => T): T;
}
export function createDelegatedSqlStore(sql: DelegatedSqlPort, options: DelegatedStoreLimits = {}): DelegatedStore {
    const bounds = delegatedStoreLimits(options);
    const chunkBytes = 65536;
    sql.exec('CREATE TABLE IF NOT EXISTS delegated_manifests (key TEXT PRIMARY KEY,digest TEXT NOT NULL,bytes INTEGER NOT NULL,chunks INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS delegated_chunks (key TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(key,ordinal))');
    function load(key: string) {
        const row = Array.from(sql.exec('SELECT digest,bytes,chunks FROM delegated_manifests WHERE key=?', key))[0];
        if (!row)
            return undefined;
        if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > bounds.maxLedgerBytes || !Number.isSafeInteger(row.chunks) || Number(row.chunks) !== Math.ceil(Number(row.bytes) / chunkBytes))
            throw Error('delegated manifest rejected');
        const rows = Array.from(sql.exec('SELECT ordinal,data FROM delegated_chunks WHERE key=? ORDER BY ordinal', key));
        if (rows.length !== row.chunks)
            throw Error('delegated chunk missing');
        const chunks = rows.map((r, i) => {
            if (r.ordinal !== i || typeof r.data !== 'string' || r.data.length > 98304 || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data))
                throw Error('delegated chunk rejected');
            const data = Buffer.from(r.data, 'base64');
            if (data.toString('base64') !== r.data || data.length > chunkBytes)
                throw Error('delegated chunk rejected');
            return data;
        });
        const buffer = Buffer.concat(chunks);
        if (buffer.length !== row.bytes || createHash('sha256').update(buffer).digest('hex') !== row.digest)
            throw Error('delegated manifest mismatch');
        return validateDelegatedLedger(key, JSON.parse(buffer.toString('utf8')));
    }
    return { async read(key) { return sql.transactionSync(() => load(key)); }, async mutate<T>(key: string, fn: (state: DelegatedLedger | undefined) => {
            state: DelegatedLedger;
            result: T;
        }) {
            return sql.transactionSync(() => {
                const { result, json } = prepareDelegatedMutation(key, load(key), fn);
                const buffer = Buffer.from(json);
                const bytes = buffer.length;
                const totals = Array.from(sql.exec('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM delegated_manifests WHERE key<>?', key))[0]!;
                if (bytes > bounds.maxLedgerBytes || Number(totals.bytes) + bytes > bounds.maxTotalBytes || Number(totals.count) + 1 > bounds.maxLedgers)
                    throw Error('delegated store quota');
                sql.exec('DELETE FROM delegated_chunks WHERE key=?', key);
                let count = 0;
                for (let at = 0; at < bytes; at += chunkBytes) {
                    sql.exec('INSERT INTO delegated_chunks(key,ordinal,data) VALUES(?,?,?)', key, count++, buffer.subarray(at, at + chunkBytes).toString('base64'));
                }
                sql.exec('INSERT INTO delegated_manifests(key,digest,bytes,chunks) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,bytes=excluded.bytes,chunks=excluded.chunks', key, createHash('sha256').update(buffer).digest('hex'), bytes, count);
                return result;
            });
        } };
}
