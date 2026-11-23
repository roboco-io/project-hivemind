import { DelegatedReceiptSchema, S3ReceiptSchema, WorkloadDescriptorSchema } from '../../contracts/src/delegated.js';
import type { DelegatedProofPort, DelegatedPublicationGuard, HfReceipt, ProofResult, S3Receipt, WorkloadDescriptor } from '../../contracts/src/delegated.js';
export interface DelegatedProofOptions {
    fetch: typeof globalThis.fetch;
    authorizeS3(request: Request, descriptor: WorkloadDescriptor): Promise<Request>;
    hfToken(descriptor: WorkloadDescriptor): Promise<string>;
}
const result = (status: ProofResult['status'], code: string): ProofResult => ({ status, code });
const unknown = (code = 'metadata-unavailable') => result('unknown', code);
const mismatch = (code = 'metadata-mismatch') => result('mismatch', code);
const verified = () => result('verified', 'metadata-match');
/** Metadata only. Fixed provider endpoints; redirect, weight download, and repository creation are absent. */
export function createDelegatedProofAdapter(o: DelegatedProofOptions): DelegatedProofPort {
    for (const fn of [o.fetch, o.authorizeS3, o.hfToken])
        if (typeof fn !== 'function')
            throw Error('delegated proof configuration required');
    async function text(response: Response): Promise<string> {
        const reader = response.body?.getReader();
        if (!reader)
            return '';
        let size = 0;
        const chunks: Uint8Array[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([(async () => {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        size += value.byteLength;
                        if (size > 262144)
                            throw Error('metadata too large');
                        chunks.push(value);
                    }
                    return Buffer.concat(chunks).toString('utf8');
                })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('metadata deadline')), 5000); })]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            void reader.cancel().catch(() => { });
        }
    }
    async function hf(d: WorkloadDescriptor, path: string, method = 'GET', body?: string, guard?: DelegatedPublicationGuard) {
        const token = await o.hfToken(d);
        if (!token || /[\r\n]/.test(token))
            throw Error('HF token unavailable');
        if (method === 'PUT') {
            if (!guard)
                throw Error('publication guard required');
            await guard.authorize();
            guard.assertValid();
        }
        const response = await o.fetch('https://huggingface.co' + path, { method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (response.redirected || response.status < 200 || response.status >= 300)
            throw Error('HF response rejected');
        return response;
    }
    const repoPath = (d: WorkloadDescriptor) => '/api/models/' + d.hf.repo.split('/').map(encodeURIComponent).join('/');
    async function hfProof(d: WorkloadDescriptor, r: HfReceipt, visibility: 'private' | 'public'): Promise<ProofResult> {
        if (r.repo !== d.hf.repo)
            return mismatch('repository-mismatch');
        const current = await hf(d, repoPath(d));
        if (!current.ok)
            return unknown();
        const info = JSON.parse(await text(current));
        if (info.id !== d.hf.repo || info.sha !== r.commit || typeof info.private !== 'boolean' || info.disabled === true || info.private !== (visibility === 'private'))
            return mismatch('repository-state-mismatch');
        const response = await hf(d, repoPath(d) + '/revision/' + r.commit + '?blobs=true');
        if (!response.ok)
            return unknown();
        const pinned = JSON.parse(await text(response));
        if (pinned.id !== d.hf.repo || pinned.sha !== r.commit || typeof pinned.private !== 'boolean' || pinned.private !== (visibility === 'private') || !Array.isArray(pinned.siblings))
            return mismatch('commit-mismatch');
        for (const file of r.files) {
            const entries = pinned.siblings.filter((f: Record<string, unknown>) => f.rfilename === file.path);
            if (entries.length !== 1)
                return mismatch('file-missing');
            const f = entries[0];
            if (typeof f.blobId !== 'string' || !Number.isSafeInteger(f.size))
                return unknown('file-metadata-incomplete');
            if (f.blobId !== file.oid || f.size !== file.size)
                return mismatch('file-mismatch');
            if (file.sha256) {
                if (typeof f.lfs?.sha256 !== 'string' || !Number.isSafeInteger(f.lfs.size))
                    return unknown('file-checksum-unavailable');
                if (f.lfs.sha256 !== file.sha256 || f.lfs.size !== file.size)
                    return mismatch('file-checksum-mismatch');
            }
        }
        // The publication target must still be the inspected commit after reading file metadata.
        const last = await hf(d, repoPath(d));
        if (!last.ok)
            return unknown();
        const state = JSON.parse(await text(last));
        if (state.id !== d.hf.repo || state.sha !== r.commit || state.private !== (visibility === 'private') || state.disabled === true)
            return mismatch('repository-state-changed');
        return verified();
    }
    function s3Url(d: WorkloadDescriptor, r: S3Receipt, acl = false) {
        const u = new URL('https://' + d.s3.bucket + '.s3.' + d.region + '.amazonaws.com/' + r.key.split('/').map(encodeURIComponent).join('/'));
        u.searchParams.set('versionId', r.versionId);
        if (acl)
            u.searchParams.set('acl', '');
        return u;
    }
    async function s3(d: WorkloadDescriptor, r: S3Receipt, method: 'HEAD' | 'GET' | 'DELETE', acl = false) {
        const url = s3Url(d, r, acl).href;
        const headers = new Headers({ 'x-amz-expected-bucket-owner': d.accountId });
        if (method === 'HEAD')
            headers.set('x-amz-checksum-mode', 'ENABLED');
        const req = new Request(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const signed = await o.authorizeS3(req, d);
        if (signed.url !== url || signed.method !== method || signed.headers.get('x-amz-expected-bucket-owner') !== d.accountId || (method === 'HEAD' && signed.headers.get('x-amz-checksum-mode') !== 'ENABLED') || signed.body !== null)
            throw Error('S3 authorization scope changed');
        const response = await o.fetch(new Request(signed, { redirect: 'manual', signal: AbortSignal.timeout(5000) }));
        if (response.redirected || ((response.status < 200 || response.status >= 300) && !(method === 'HEAD' && response.status === 404)))
            throw Error('S3 response rejected');
        return response;
    }
    async function s3Proof(d: WorkloadDescriptor, r: S3Receipt): Promise<ProofResult> {
        r = S3ReceiptSchema.parse(r);
        if (r.bucket !== d.s3.bucket || !r.key.startsWith(d.s3.prefix) || r.ownerAccountId !== d.accountId || r.size > d.s3.maxObjectBytes)
            return mismatch('object-scope-mismatch');
        const head = await s3(d, r, 'HEAD');
        if (!head.ok)
            return unknown();
        if (head.headers.get('x-amz-version-id') !== r.versionId || head.headers.get('content-length') !== String(r.size) || head.headers.get('x-amz-delete-marker') === 'true')
            return mismatch('object-version-size-mismatch');
        const type = head.headers.get('x-amz-checksum-type');
        const checksum = head.headers.get('x-amz-checksum-sha256');
        let evidence: 'full-sha256' | 'native-composite';
        if (r.checksum) {
            if (type !== r.checksum.type || !checksum)
                return unknown('native-checksum-unavailable');
            if (checksum !== r.checksum.value)
                return mismatch('native-checksum-mismatch');
            evidence = type === 'COMPOSITE' ? 'native-composite' : 'full-sha256';
            if (evidence === 'full-sha256' && r.sha256 && Buffer.from(checksum, 'base64').toString('hex') !== r.sha256)
                return mismatch('object-checksum-mismatch');
        }
        else {
            if (type !== 'FULL_OBJECT' || !checksum || !/^[A-Za-z0-9+/]{43}=$/.test(checksum))
                return unknown('full-checksum-unavailable');
            if (Buffer.from(checksum, 'base64').toString('hex') !== r.sha256)
                return mismatch('object-checksum-mismatch');
            evidence = 'full-sha256';
        }
        if (!d.s3.ownerCanonicalId)
            return unknown('owner-evidence-required');
        const acl = await s3(d, r, 'GET', true);
        if (!acl.ok)
            return unknown('owner-evidence-unavailable');
        const xml = await text(acl);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml))
            return unknown('owner-evidence-invalid');
        const owner = xml.match(/<Owner>\s*(?:<DisplayName>[^<]*<\/DisplayName>\s*)?<ID>([a-f0-9]{64})<\/ID>\s*(?:<DisplayName>[^<]*<\/DisplayName>\s*)?<\/Owner>/)?.[1];
        if (!owner)
            return unknown('owner-evidence-invalid');
        if (owner !== d.s3.ownerCanonicalId)
            return mismatch('object-owner-mismatch');
        return { ...verified(), code: evidence === 'native-composite' ? 'native-composite-match' : 'full-sha256-match', checksumEvidence: evidence };
    }
    async function guard(fn: () => Promise<ProofResult>) {
        try {
            return await fn();
        }
        catch {
            return unknown();
        }
    }
    return {
        verify: (input, r) => guard(async () => { const d = WorkloadDescriptorSchema.parse(input); const parsed = DelegatedReceiptSchema.parse(r); return parsed.kind === 's3' ? s3Proof(d, parsed) : hfProof(d, parsed, d.hf.visibility); }),
        publicationState: (input, r) => guard(async () => hfProof(WorkloadDescriptorSchema.parse(input), r, 'public')),
        publish: (input, r, writeGuard) => guard(async () => {
            const d = WorkloadDescriptorSchema.parse(input);
            if (d.hf.visibility !== 'private' || !d.releasePolicy.allowPublicTransition)
                return mismatch('release-policy-denied');
            const pre = await hfProof(d, r, 'private');
            if (pre.status !== 'verified')
                return pre;
            const response = await hf(d, repoPath(d) + '/settings', 'PUT', JSON.stringify({ visibility: 'public' }), writeGuard);
            if (!response.ok)
                return unknown('publication-write-unknown');
            return hfProof(d, r, 'public');
        }),
        cleanupState: (input, r) => guard(async () => { const d = WorkloadDescriptorSchema.parse(input), receipt = S3ReceiptSchema.parse(r); if (receipt.bucket !== d.s3.bucket || !receipt.key.startsWith(d.s3.prefix) || receipt.ownerAccountId !== d.accountId)
            return mismatch('object-scope-mismatch'); const response = await s3(d, receipt, 'HEAD'); if (response.status === 404)
            return result('verified', 'owned-version-absent'); const present = await s3Proof(d, receipt); return present.status === 'verified' ? mismatch('owned-version-present') : unknown('cleanup-state-unknown'); }),
        cleanup: (input, r) => guard(async () => {
            const d = WorkloadDescriptorSchema.parse(input);
            const pre = await s3Proof(d, r);
            if (pre.status !== 'verified')
                return pre;
            const deleted = await s3(d, r, 'DELETE');
            if (!deleted.ok)
                return unknown('cleanup-write-unknown');
            const after = await s3(d, r, 'HEAD');
            return after.status === 404 ? verified() : unknown('cleanup-postcondition-unknown');
        }),
    };
}
