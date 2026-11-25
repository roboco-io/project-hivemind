import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceTestSpec, VerificationAttestation } from '../../../packages/contracts/src/delivery.js';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { verifyPatchWithImmutableAcceptance } from '../../../packages/adapters/src/git-bundle.js';
import { validateAcceptanceTestSpec } from '../../../packages/core/src/delivery.js';

export interface AwsVerifierControlPort {
  submitVerification(taskId: string, attestation: VerificationAttestation): Promise<void>;
}

export interface RunAwsVerifierOptions {
  taskId: string;
  runId: string;
  iteration: number;
  bundleS3Key: string;
  bundleSha256: string;
  acceptanceS3Key: string;
  expectedAcceptanceDigest: string;
  patchS3Key: string;
  expectedPatchSha256?: string;
  s3: S3ObjectPort;
  control: AwsVerifierControlPort;
  testTimeoutMs?: number;
  workRoot?: string;
}

export async function runAwsVerifierOnce(
  options: RunAwsVerifierOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<VerificationAttestation> {
  const scratch = await mkdtemp(join(options.workRoot ?? tmpdir(), 'hivemind-aws-verifier-'));
  try {
    const [bundleBytes, acceptanceBytes, patchBytes] = await Promise.all([
      options.s3.getObject(options.bundleS3Key, options.bundleSha256, signal),
      options.s3.getObject(options.acceptanceS3Key, undefined, signal),
      options.s3.getObject(options.patchS3Key, options.expectedPatchSha256, signal),
    ]);

    const parsedAcceptance = JSON.parse(Buffer.from(acceptanceBytes).toString('utf8')) as AcceptanceTestSpec;
    const acceptance = validateAcceptanceTestSpec(parsedAcceptance);
    if (acceptance.digest !== options.expectedAcceptanceDigest.toLowerCase()) {
      throw new Error('Downloaded acceptance test spec digest does not match approved acceptanceDigest');
    }

    const bundlePath = join(scratch, 'pinned.bundle');
    await writeFile(bundlePath, bundleBytes);
    const patchText = Buffer.from(patchBytes).toString('utf8');

    const attestation = await verifyPatchWithImmutableAcceptance(
      {
        runId: options.runId,
        iteration: options.iteration,
        bundlePath,
        expectedBundleSha256: options.bundleSha256,
        acceptance,
        patch: patchText,
        workRoot: scratch,
        testTimeoutMs: options.testTimeoutMs,
      },
      signal,
    );

    await options.control.submitVerification(options.taskId, attestation);
    return attestation;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
