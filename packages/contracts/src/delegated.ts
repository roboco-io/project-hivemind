import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = uint.positive();
const path = z.string().min(1).max(512).refine(v => !v.startsWith('/') && !v.includes('..') && !/[\\\s?#%]/.test(v));
const ref = z.strictObject({ id, sha256: hash });
export const InputManifestSchema = z.strictObject({
    version: z.literal(1), code: ref, data: z.array(ref).max(64),
    arguments: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.union([z.string().max(256).regex(/^[A-Za-z0-9_.,:+ /-]*$/).refine(v => !v.includes('://') && !v.includes('//') && !v.includes('..')), z.number().finite(), z.boolean()])).refine(v => Object.keys(v).length <= 64),
});
export type InputManifest = z.infer<typeof InputManifestSchema>;
export const WorkloadDescriptorSchema = z.strictObject({
    version: z.literal(1), workloadId: id,
    amiId: z.string().regex(/^ami-[a-f0-9]{8,17}$/), bootstrapSha256: hash,
    inputManifestDigests: z.array(hash).min(1).max(64).refine(v => new Set(v).size === v.length),
    iam: z.strictObject({ instanceProfileArn: z.string().regex(/^arn:aws:iam::[0-9]{12}:instance-profile\/[A-Za-z0-9_+=,.@/-]+$/), policyRevision: id, policySha256: hash }),
    awsDelivery: z.strictObject({ mode: z.literal('instance_role_scoped'), policySha256: hash, durationSeconds: positive.max(120), purpose: z.literal('delegated-upload'), roleArn: z.string().regex(/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/) }).optional(),
    accountId: z.string().regex(/^[0-9]{12}$/), region: z.string().regex(/^[a-z]{2}-[a-z]+-[0-9]$/), availabilityZoneId: z.string().regex(/^[a-z0-9]+-az[0-9]+$/),
    s3: z.strictObject({ bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), prefix: path.refine(v => v.endsWith('/')), ownerCanonicalId: z.string().regex(/^[a-f0-9]{64}$/).optional(), maxObjects: positive.max(4096), maxObjectBytes: positive, maxTotalBytes: positive,
        retentionMs: positive, storageReserveMicros: uint, requestReserveMicros: uint, transferReserveMicros: uint }),
    hf: z.strictObject({ repo: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/), visibility: z.enum(['private', 'public']), tokenRef: id,
        delivery: z.strictObject({ mode: z.literal('instance-private-envelope'), audience: id, path: z.literal('/run/hivemind/hf-token'), fileMode: z.literal('0600'), ttlMs: positive.max(300000), trainingEnvironment: z.literal(false) }) }),
    qualityGateIds: z.array(id).min(1).max(32).refine(v => new Set(v).size === v.length),
    releasePolicy: z.strictObject({ id, revision: id, allowPublicTransition: z.boolean() }),
}).refine(v => v.iam.instanceProfileArn.includes(`::${v.accountId}:`) && v.s3.maxObjectBytes <= v.s3.maxTotalBytes);
export type WorkloadDescriptor = z.infer<typeof WorkloadDescriptorSchema>;
export interface DelegatedBinding {
    taskId: string;
    revision: number;
    workloadId: string;
    descriptorHash: string;
    instanceId: string;
    accountId: string;
    region: string;
}
export interface DelegatedAuthority {
    binding: DelegatedBinding;
    descriptor: WorkloadDescriptor;
    active: boolean;
    expiresAt: number;
}
export const S3ReceiptSchema = z.strictObject({ kind: z.literal('s3'), receiptId: id, bucket: z.string().min(3).max(63), key: path, versionId: z.string().min(1).max(256).refine(v => v !== 'null' && !/[\s\x00-\x1f]/.test(v)), size: positive, sha256: hash.optional(), checksum: z.strictObject({ algorithm: z.literal('SHA256'), type: z.enum(['FULL_OBJECT', 'COMPOSITE']), value: z.string().max(64) }).refine(c => c.type === 'FULL_OBJECT' ? /^[A-Za-z0-9+/]{43}=$/.test(c.value) : /^[A-Za-z0-9+/]{43}=-[1-9][0-9]{0,3}$/.test(c.value) || /^[A-Za-z0-9+/]{43}=-10000$/.test(c.value)).optional(), ownerAccountId: z.string().regex(/^[0-9]{12}$/) }).refine(r => r.sha256 !== undefined || r.checksum !== undefined);
const hfFile = z.strictObject({ path, size: positive, oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), sha256: hash.optional() });
export const HfReceiptSchema = z.strictObject({ kind: z.literal('hf'), receiptId: id, repo: z.string().min(3).max(128), commit: z.string().regex(/^[a-f0-9]{40}$/), visibility: z.enum(['private', 'public']), files: z.array(hfFile).min(1).max(256) }).refine(v => new Set(v.files.map(f => f.path)).size === v.files.length);
export const DelegatedReceiptSchema = z.discriminatedUnion('kind', [S3ReceiptSchema, HfReceiptSchema]);
export type DelegatedReceipt = z.infer<typeof DelegatedReceiptSchema>;
export type S3Receipt = z.infer<typeof S3ReceiptSchema>;
export type HfReceipt = z.infer<typeof HfReceiptSchema>;
export type ReceiptStatus = 'reported' | 'unverified' | 'verified' | 'mismatch' | 'unknown';
export interface ReceiptRecord {
    binding: DelegatedBinding;
    receipt: DelegatedReceipt;
    status: ReceiptStatus;
    reportedAt: number;
    verifiedAt?: number;
    proofCode?: string;
    checksumEvidence?: 'full-sha256' | 'native-composite';
    wholeSha256Status?: 'instance_report' | 'verified' | 'not_reported';
    cleanupAttemptId?: string;
    cleanupSettlement?: 'intent' | 'unknown' | 'settled';
    cleanup: 'retained' | 'intent' | 'deleted' | 'unknown';
}
export interface ProofResult {
    checksumEvidence?: 'full-sha256' | 'native-composite';
    status: 'verified' | 'mismatch' | 'unknown';
    code: string;
}
export interface TrustedQualityProof {
    binding: DelegatedBinding;
    receiptId: string;
    commit: string;
    gateIds: string[];
    policyId: string;
    policyRevision: string;
    validUntil: number;
    proofId: string;
}
export interface PublicationIntent {
    receiptId: string;
    commit: string;
    state: 'intent' | 'verified' | 'mismatch' | 'unknown';
    at: number;
    qualityProofId: string;
}
export interface DelegatedLedger {
    version: 1;
    binding: DelegatedBinding;
    descriptor: WorkloadDescriptor;
    generation: number;
    reservationId: string | null;
    registration: {
        state: 'intent' | 'reserved' | 'unknown';
        retentionUntil: number;
    };
    reservedMicros: number;
    actualBillingMicros: null | number;
    receipts: ReceiptRecord[];
    publication?: PublicationIntent;
    operation?: {
        id: string;
        kind: 'verify' | 'publish' | 'cleanup';
        receiptId: string;
    };
    createdAt: number;
}
export interface DelegatedStore {
    read(key: string): Promise<DelegatedLedger | undefined>;
    mutate<T>(key: string, fn: (state: DelegatedLedger | undefined) => {
        state: DelegatedLedger;
        result: T;
    }): Promise<T>;
}
export interface DelegatedPublicationGuard {
    authorize(): Promise<void>;
    assertValid(): void;
}
export interface DelegatedProofPort {
    verify(descriptor: WorkloadDescriptor, receipt: DelegatedReceipt): Promise<ProofResult>;
    publish(descriptor: WorkloadDescriptor, receipt: HfReceipt, guard: DelegatedPublicationGuard): Promise<ProofResult>;
    publicationState(descriptor: WorkloadDescriptor, receipt: HfReceipt): Promise<ProofResult>;
    cleanupState(descriptor: WorkloadDescriptor, receipt: S3Receipt): Promise<ProofResult>;
    cleanup(descriptor: WorkloadDescriptor, receipt: S3Receipt): Promise<ProofResult>;
}
export interface DelegatedBudgetPort {
    reconcile(key: string): Promise<{
        reservationId: string;
    } | undefined>;
    reserve(input: {
        key: string;
        binding: DelegatedBinding;
        upperBoundMicros: number;
        retentionUntil: number;
    }): Promise<{
        reservationId: string;
    }>;
    settle(input: {
        reservationId: string;
        actualBillingMicros: null;
        retained: boolean;
    }): Promise<void>;
}
export interface DelegatedControllerPorts {
    store: DelegatedStore;
    currentAuthority(taskId: string): Promise<DelegatedAuthority | undefined>;
    authorizeInstance(binding: DelegatedBinding, privateContext: unknown, purpose: 'report'): Promise<boolean>;
    budget: DelegatedBudgetPort;
    proof: DelegatedProofPort;
    qualityProof(binding: DelegatedBinding, receipt: HfReceipt): Promise<TrustedQualityProof | undefined>;
    now?: () => number;
}
