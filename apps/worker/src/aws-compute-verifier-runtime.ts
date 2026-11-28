import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { processEnvironment, runProcess } from '../../../packages/adapters/src/process.js';
import type { ProcessEvidence } from '../../../packages/contracts/src/index.js';
import type {
  ComputeArtifactReceipt,
  ComputeInputSpec,
  SubmitComputeReleaseAttestation,
} from '../../../packages/contracts/src/compute.js';
import { computeArtifactManifestDigest } from '../../../packages/core/src/compute.js';

export interface ComputeReleaseVerificationInput {
  jobId: string;
  artifactPrefix: string;
  expectedManifestDigest: string;
  releaseCheckCommand: string[];
  inputs?: Pick<ComputeInputSpec, 's3Prefix' | 'files'>;
  s3: S3ObjectPort;
  workRoot?: string;
  timeoutMs?: number;
  maxArtifactBytes?: number;
  runCheck?: (command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ProcessEvidence>;
  now?: () => number;
}

const DEFAULT_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;

function safeRelativePath(path: string, label: string): string {
  const parts = path.split('/');
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`Unsafe ${label}: ${path.slice(0, 120)}`);
  }
  return path;
}

function metricsFromStdout(stdout: string): Record<string, number | string | boolean> {
  const last = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!last.startsWith('{') || last.length > 8000) return {};
  try {
    const parsed = JSON.parse(last) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const metrics: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parsed).slice(0, 50)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
      else if (typeof value === 'boolean') metrics[key] = value;
      else if (typeof value === 'string') metrics[key] = value.slice(0, 200);
    }
    return metrics;
  } catch {
    return {};
  }
}

/**
 * Independent release verification of one Compute job.
 * Verifies the S3 receipt manifestDigest, every artifact SHA-256, and pinned inputs before running
 * `releaseCheckCommand` in a clean environment without task credentials.
 */
export async function runComputeReleaseVerification(input: ComputeReleaseVerificationInput): Promise<SubmitComputeReleaseAttestation> {
  if (!input.releaseCheckCommand.length || !input.releaseCheckCommand[0]) throw new Error('releaseCheckCommand is empty');
  const now = input.now ?? Date.now;
  const prefix = input.artifactPrefix.replace(/\/+$/, '');
  const expectedDigest = input.expectedManifestDigest.toLowerCase();

  const receipt = JSON.parse(Buffer.from(await input.s3.getObject(`${prefix}/receipt.json`)).toString('utf8')) as ComputeArtifactReceipt;
  if (receipt.jobId !== input.jobId) throw new Error('S3 receipt belongs to a different job');
  if (typeof receipt.manifestDigest !== 'string' || receipt.manifestDigest.toLowerCase() !== expectedDigest) {
    throw new Error('S3 receipt manifestDigest does not match the digest recorded by the Control Plane');
  }
  if (computeArtifactManifestDigest(receipt.files) !== expectedDigest) {
    throw new Error('S3 receipt file list does not hash to its manifestDigest');
  }
  const totalBytes = receipt.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const maxBytes = input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (totalBytes > maxBytes) {
    throw new Error(`Artifacts total ${totalBytes} bytes, above the ${maxBytes}-byte limit of this verifier`);
  }

  const workspace = await mkdtemp(join(input.workRoot ?? tmpdir(), 'hivemind-compute-verify-'));
  try {
    const artifactDir = join(workspace, 'artifacts');
    const inputsDir = join(workspace, 'inputs');
    const homeDir = join(workspace, 'home');
    await Promise.all([mkdir(artifactDir), mkdir(inputsDir), mkdir(homeDir)]);

    for (const file of receipt.files) {
      const relative = safeRelativePath(file.path, 'artifact path');
      const bytes = await input.s3.getObject(`${prefix}/${relative}`, file.sha256);
      if (bytes.byteLength !== file.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) {
        throw new Error(`Artifact ${relative} does not match its receipt entry`);
      }
      const target = join(artifactDir, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    for (const file of input.inputs?.files ?? []) {
      const relative = safeRelativePath(file.path, 'input path');
      const bytes = await input.s3.getObject(`${input.inputs!.s3Prefix.replace(/\/+$/, '')}/${relative}`, file.sha256);
      if (bytes.byteLength !== file.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) {
        throw new Error(`Pinned input ${relative} does not match the approved specification`);
      }
      const target = join(inputsDir, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const env: NodeJS.ProcessEnv = {
      ...processEnvironment(homeDir),
      HIVEMIND_JOB_ID: input.jobId,
      HIVEMIND_ARTIFACT_DIR: artifactDir,
      HIVEMIND_INPUTS_DIR: inputsDir,
      HIVEMIND_MANIFEST_DIGEST: expectedDigest,
    };
    const timeoutMs = input.timeoutMs ?? 900_000;
    const run =
      input.runCheck ??
      ((command, options) =>
        runProcess(command, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs, signal: AbortSignal.timeout(options.timeoutMs + 5_000), maxOutputBytes: 256_000 }));
    const evidence = await run(input.releaseCheckCommand, { cwd: inputsDir, env, timeoutMs });

    const passed = evidence.status === 'passed' && evidence.exitCode === 0;
    const outputTail = `${evidence.stdout}\n${evidence.stderr}`.trim().slice(-1500);
    return {
      manifestDigest: expectedDigest,
      releaseCheckPassed: passed,
      metrics: {
        ...metricsFromStdout(evidence.stdout),
        verifierExitCode: evidence.exitCode ?? -1,
        verifierStatus: evidence.status,
        verifierDurationMs: evidence.durationMs,
        artifactFileCount: receipt.files.length,
        artifactBytes: totalBytes,
        pinnedInputFileCount: input.inputs?.files.length ?? 0,
      },
      summary:
        `Independent verifier ran ${JSON.stringify(input.releaseCheckCommand).slice(0, 300)}: ${evidence.status}` +
        ` (exit ${evidence.exitCode ?? 'none'}) after verifying ${receipt.files.length} artifact file(s) against the receipt.` +
        (outputTail ? `\n--- output tail ---\n${outputTail}` : ''),
      verifiedAt: new Date(now()).toISOString(),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function decodeComputeReleaseVerificationSpec(base64: string): Pick<
  ComputeReleaseVerificationInput,
  'jobId' | 'artifactPrefix' | 'expectedManifestDigest' | 'releaseCheckCommand' | 'inputs'
> {
  const parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
  const command = parsed.releaseCheckCommand;
  if (
    typeof parsed.jobId !== 'string' ||
    typeof parsed.artifactPrefix !== 'string' ||
    typeof parsed.expectedManifestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(parsed.expectedManifestDigest) ||
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== 'string')
  ) {
    throw new Error('Malformed compute release verification spec');
  }
  const inputs = parsed.inputs as ComputeReleaseVerificationInput['inputs'] | undefined;
  if (inputs !== undefined && (typeof inputs?.s3Prefix !== 'string' || !Array.isArray(inputs.files))) {
    throw new Error('Malformed pinned inputs in compute release verification spec');
  }
  return {
    jobId: parsed.jobId,
    artifactPrefix: parsed.artifactPrefix,
    expectedManifestDigest: parsed.expectedManifestDigest,
    releaseCheckCommand: command as string[],
    ...(inputs ? { inputs: { s3Prefix: inputs.s3Prefix, files: inputs.files } } : {}),
  };
}
