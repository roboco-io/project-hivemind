import { createHash } from 'node:crypto';
import type { ExternalLargeManifest } from '../../contracts/src/autonomous-external-large.js';
import type {
  ModelArtifactReceipt,
  ModelFactoryJob,
  ModelReleaseAttestation,
  ModelReleasePublication,
} from '../../contracts/src/model-factory.js';
import { hfLfsCommit } from './autonomous-external-hf-lfs.js';
import type { S3ObjectPort } from './aws-s3-artifacts.js';

export interface TrustedHfReleasePublisherConfig {
  s3: S3ObjectPort;
  resolveHfToken: (signal?: AbortSignal) => Promise<string>;
  uploadHosts?: readonly string[];
  allowPublicLarge?: boolean;
  forbiddenValues?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Control-Plane-only Hugging Face release publisher (Issue #12 B6).
 * Workers never receive HF write tokens. Every file is read from S3 with SHA-256 verification
 * against the human-approved receipt manifestDigest before streaming via hfLfsCommit.
 */
/** Hosts Hugging Face hands out for LFS upload URLs. Any other upload host is refused. */
export const HF_RELEASE_UPLOAD_HOSTS: readonly string[] = [
    's3.us-east-1.amazonaws.com',
    // Multipart LFS uploads for large files are presigned on S3 Transfer Acceleration (seen 2026-11-27).
    'hf-hub-lfs-us-east-1.s3-accelerate.amazonaws.com',
    'cdn-lfs.hf.co',
    'cdn-lfs-us-1.hf.co',
    'cdn-lfs-eu-1.hf.co',
];

export function createTrustedHfReleasePublisher(config: TrustedHfReleasePublisherConfig) {
  const uploadHosts = config.uploadHosts ?? HF_RELEASE_UPLOAD_HOSTS;
  const now = config.now ?? Date.now;

  const hfFetch = config.fetchImpl ?? fetch;
  return {
    /**
     * Creates `owner/name` as a model repository with the given visibility when it does not exist. An
     * existing repository is left as it is; its visibility is checked again right before the commit.
     */
    async ensureRepository(repository: string, visibility: 'private' | 'public', signal?: AbortSignal): Promise<'exists' | 'created'> {
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,95})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,95})$/.exec(repository);
      if (!match || repository.includes('..')) throw new Error('Invalid Hugging Face repository name');
      const token = (await config.resolveHfToken(signal)).trim();
      if (!token) throw new Error('Control Plane Hugging Face write token is empty');
      const headers = { authorization: `Bearer ${token}`, 'user-agent': 'hivemind-release/1' };
      const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
      const existing = await hfFetch(`https://huggingface.co/api/models/${match[1]}/${match[2]}`, { headers, redirect: 'manual', signal: timeout });
      if (existing.status === 200) return 'exists';
      if (existing.status !== 404 && existing.status !== 401) throw new Error(`Hugging Face repository lookup failed with HTTP ${existing.status}`);
      const created = await hfFetch('https://huggingface.co/api/repos/create', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'model', name: match[2], organization: match[1], private: visibility === 'private' }),
        redirect: 'manual',
        signal: timeout,
      });
      if (created.status === 409) return 'exists';
      if (!created.ok) throw new Error(`Hugging Face repository creation failed with HTTP ${created.status}`);
      return 'created';
    },

    async publish(input: {
      job: ModelFactoryJob;
      receipt: ModelArtifactReceipt;
      attestation: ModelReleaseAttestation;
      signal?: AbortSignal;
    }): Promise<ModelReleasePublication> {
      const { job, receipt, attestation, signal } = input;
      if (job.releasePolicy.mode !== 'hf_release' || !job.releasePolicy.hfRepository) {
        throw new Error('Job releasePolicy is not configured for hf_release');
      }
      if (!attestation.releaseCheckPassed) {
        throw new Error('Cannot publish to Hugging Face without passing release check attestation');
      }
      if (receipt.manifestDigest !== attestation.manifestDigest) {
        throw new Error('Receipt manifestDigest does not match release attestation');
      }

      const token = (await config.resolveHfToken(signal)).trim();
      if (!token) {
        throw new Error('Control Plane Hugging Face write token is empty');
      }

      const revision = job.releasePolicy.hfRevision ?? 'main';
      const manifest: ExternalLargeManifest = {
        version: 1,
        taskId: job.id,
        revision: 1,
        profileId: `model-factory:${job.modelId}`,
        files: receipt.files.map((f) => ({
          path: f.path,
          size: f.sizeBytes,
          sha256: f.sha256,
          storageRef: `${receipt.s3Prefix}/${f.path}`,
        })),
      };

      const nowMs = now();
      const invocation = {
        taskId: job.id,
        revision: 1,
        ownershipToken: `mf-release-${job.id}`,
        idempotencyKey: receipt.manifestDigest,
        parametersHash: createHash('sha256')
          .update(JSON.stringify({ repo: job.releasePolicy.hfRepository, revision, digest: receipt.manifestDigest }))
          .digest('hex'),
        expiresAt: nowMs + 30 * 60 * 1000,
      };

      const provenanceTag =
        attestation.attestationSource === 'independent_verifier'
          ? 'independent_verifier'
          : 'operator_self_reported';
      const proof = await hfLfsCommit(invocation, token, manifest, {
        repository: job.releasePolicy.hfRepository,
        revision,
        message: `HIVEMIND release ${job.modelId} (manifest ${receipt.manifestDigest.slice(0, 12)}, check: ${provenanceTag})`,
        visibility: job.releasePolicy.visibility,
        // The acknowledgement exists only for public repositories; any value for a private one is refused.
        ...(job.releasePolicy.visibility === 'public' ? { allowPublicLarge: config.allowPublicLarge ?? true } : {}),
        forbiddenValues: config.forbiddenValues,
        fetch: config.fetchImpl,
        now,
        signal,
        uploadHosts,
        async open(file) {
          // Stream large files so a model bigger than the Control Plane's memory can still be published.
          if (config.s3.openObjectStream) {
            return config.s3.openObjectStream(file.storageRef, file.sha256, file.size, signal);
          }
          const bytes = await config.s3.getObject(file.storageRef, file.sha256, signal);
          return (async function* () {
            const chunkSize = 1024 * 1024;
            for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
              yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
            }
          })();
        },
      });

      return {
        mode: 'hf_release',
        repository: job.releasePolicy.hfRepository,
        revision,
        commitSha: proof.commitOid,
        url: `https://huggingface.co/${job.releasePolicy.hfRepository}/commit/${proof.commitOid}`,
        manifestDigest: receipt.manifestDigest,
        publishedAt: new Date(now()).toISOString(),
        // hfLfsCommit returns only after hfLfsProof compared every file on the Hub with the receipt.
        verifiedFiles: receipt.files.length,
      };
    },
  };
}
