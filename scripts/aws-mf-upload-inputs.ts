import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { ComputeInputFile } from '../packages/contracts/src/compute.js';
import { computeInputsDigest } from '../packages/core/src/compute.js';

function loadAwsCredentials(profile: string): AwsEcsCredentials {
  const raw = execFileSync(
    'aws',
    ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(raw) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
  };
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    ...(parsed.SessionToken ? { sessionToken: parsed.SessionToken } : {}),
  };
}

function walkFiles(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '__pycache__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, root, out);
    } else if (st.isFile()) {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  // The Hub artifacts bucket is named after the account, so the default is read from STS, not written here.
  const bucket =
    process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim() ||
    `hivemind-runtime-${execFileSync('aws', ['sts', 'get-caller-identity', '--profile', profile, '--query', 'Account', '--output', 'text'], { encoding: 'utf8' }).trim()}-${region}-artifacts`;
  const modelId = process.env.HIVEMIND_MODEL_ID?.trim();
  const inputDir = process.env.HIVEMIND_INPUT_DIR?.trim();
  const bundleId = process.env.HIVEMIND_INPUT_BUNDLE_ID?.trim() || `bundle-${Date.now()}`;

  if (!modelId || !inputDir) {
    throw new Error('Set HIVEMIND_MODEL_ID and HIVEMIND_INPUT_DIR to upload pinned training inputs to S3');
  }

  const s3Prefix = `models/${modelId}/inputs/${bundleId}`;
  const s3 = createAwsS3ArtifactsPort({
    region,
    allowedRegions: [region],
    bucket,
    credentials: () => loadAwsCredentials(profile),
  });

  const relPaths = walkFiles(inputDir, inputDir).sort();
  if (relPaths.length === 0) {
    throw new Error(`No files found in ${inputDir}`);
  }

  const files: ComputeInputFile[] = [];
  for (const rel of relPaths) {
    const body = readFileSync(join(inputDir, rel));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const s3Key = `${s3Prefix}/${rel}`;
    await s3.putObject(s3Key, body, 'application/octet-stream');
    files.push({ path: rel, sha256, sizeBytes: body.byteLength });
  }

  const digest = computeInputsDigest(s3Prefix, files);
  console.log(
    JSON.stringify(
      {
        ok: true,
        bucket,
        region,
        inputs: { s3Prefix, digest, files },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
