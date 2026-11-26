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
export function createTrustedHfReleasePublisher(config: TrustedHfReleasePublisherConfig) {
  const uploadHosts = config.uploadHosts ?? [
    's3.us-east-1.amazonaws.com',
    'cdn-lfs.hf.co',
    'cdn-lfs-us-1.hf.co',
    'cdn-lfs-eu-1.hf.co',
  ];
  const now = config.now ?? Date.now;

  return {
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

      const proof = await hfLfsCommit(invocation, token, manifest, {
        repository: job.releasePolicy.hfRepository,
        revision,
        message: `HIVEMIND verified release ${job.modelId} (manifest ${receipt.manifestDigest.slice(0, 12)})`,
        visibility: job.releasePolicy.visibility,
        allowPublicLarge: config.allowPublicLarge ?? job.releasePolicy.visibility === 'public',
        forbiddenValues: config.forbiddenValues,
        fetch: config.fetchImpl,
        now,
        signal,
        uploadHosts,
        async open(file) {
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
      };
    },
  };
}
