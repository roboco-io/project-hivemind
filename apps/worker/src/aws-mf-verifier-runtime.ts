import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { processEnvironment, runProcess } from '../../../packages/adapters/src/process.js';
import type { ProcessEvidence } from '../../../packages/contracts/src/index.js';
import type {
  ModelArtifactReceipt,
  ModelTrainingInputSpec,
  SubmitModelReleaseAttestation,
} from '../../../packages/contracts/src/model-factory.js';
import { computeModelManifestDigest } from '../../../packages/core/src/model-factory.js';

export interface ModelReleaseVerificationInput {
  jobId: string;
  /** S3 prefix of the job's artifacts; `receipt.json` lives directly under it. */
  artifactPrefix: string;
  /** Manifest digest the Control Plane recorded for this job. The S3 receipt must carry the same one. */
  expectedManifestDigest: string;
  releaseCheckCommand: string[];
  /** Pinned training inputs. When present they are the working directory of the check command. */
  inputs?: Pick<ModelTrainingInputSpec, 's3Prefix' | 'files'>;
  s3: S3ObjectPort;
  workRoot?: string;
  timeoutMs?: number;
  /** Total artifact bytes this verifier will download. Larger jobs cannot be verified here. */
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

/** The last stdout line may be a flat JSON object of metrics; anything else is ignored. */
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
 * Independent release verification of one Model Factory job.
 *
 * The verifier trusts nothing the training instance reported except through its own checks:
 *   1. The S3 receipt must belong to this job, and its manifest digest must equal both the digest the
 *      Control Plane recorded and the digest recomputed from the receipt's file list.
 *   2. Every artifact file is downloaded and its SHA-256 compared with the receipt.
 *   3. The pinned training inputs, if any, are downloaded and their SHA-256 compared with the approved spec.
 *   4. `releaseCheckCommand` runs with the inputs as working directory and the artifacts in
 *      `HIVEMIND_ARTIFACT_DIR`. Its exit code decides `releaseCheckPassed`.
 *
 * Steps 1 to 3 throw on a mismatch: no attestation is produced, so the job stays in `evaluating` for an
 * operator to inspect. Only step 4 can produce a failing attestation.
 *
 * Isolation limits: the command runs without shell, without the task's credential environment variables and
 * with a fresh HOME. It is NOT a sandbox: it shares the container and its network with this process.
 */
export async function runModelReleaseVerification(input: ModelReleaseVerificationInput): Promise<SubmitModelReleaseAttestation> {
  if (!input.releaseCheckCommand.length || !input.releaseCheckCommand[0]) throw new Error('releaseCheckCommand is empty');
  const now = input.now ?? Date.now;
  const prefix = input.artifactPrefix.replace(/\/+$/, '');
  const expectedDigest = input.expectedManifestDigest.toLowerCase();

  const receipt = JSON.parse(Buffer.from(await input.s3.getObject(`${prefix}/receipt.json`)).toString('utf8')) as ModelArtifactReceipt;
  if (receipt.jobId !== input.jobId) throw new Error('S3 receipt belongs to a different job');
  if (typeof receipt.manifestDigest !== 'string' || receipt.manifestDigest.toLowerCase() !== expectedDigest) {
    throw new Error('S3 receipt manifestDigest does not match the digest recorded by the Control Plane');
  }
  if (computeModelManifestDigest(receipt.files) !== expectedDigest) {
    throw new Error('S3 receipt file list does not hash to its manifestDigest');
  }
  const totalBytes = receipt.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const maxBytes = input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (totalBytes > maxBytes) {
    throw new Error(`Artifacts total ${totalBytes} bytes, above the ${maxBytes}-byte limit of this verifier`);
  }

  const workspace = await mkdtemp(join(input.workRoot ?? tmpdir(), 'hivemind-mf-verify-'));
  try {
    const artifactDir = join(workspace, 'artifacts');
    const inputsDir = join(workspace, 'inputs');
    const homeDir = join(workspace, 'home');
    await Promise.all([mkdir(artifactDir), mkdir(inputsDir), mkdir(homeDir)]);

    for (const file of receipt.files) {
      const relative = safeRelativePath(file.path, 'artifact path');
      const bytes = await input.s3.getObject(`${prefix}/${relative}`, file.sha256);
      // The port already checks the hash when it can; checking again keeps this guarantee local.
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

    // Base environment only (PATH, locale, HOME): none of the task's credential or token variables.
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
        // Verifier-measured facts win over anything the command printed under the same name.
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

/** Decodes the job description the Control Plane passes to the verifier task as base64 JSON. */
export function decodeModelReleaseVerificationSpec(base64: string): Pick<
  ModelReleaseVerificationInput,
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
    throw new Error('Malformed model release verification spec');
  }
  const inputs = parsed.inputs as ModelReleaseVerificationInput['inputs'] | undefined;
  if (inputs !== undefined && (typeof inputs?.s3Prefix !== 'string' || !Array.isArray(inputs.files))) {
    throw new Error('Malformed pinned inputs in model release verification spec');
  }
  return {
    jobId: parsed.jobId,
    artifactPrefix: parsed.artifactPrefix,
    expectedManifestDigest: parsed.expectedManifestDigest,
    releaseCheckCommand: command as string[],
    ...(inputs ? { inputs: { s3Prefix: inputs.s3Prefix, files: inputs.files } } : {}),
  };
}
