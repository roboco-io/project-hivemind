import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveryTask } from '../packages/contracts/src/delivery.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { captureAcceptanceTestSpec, createPinnedGitBundle } from '../packages/adapters/src/git-bundle.js';
import { openSsmTunnel } from './lib/aws-live.js';

function awsJson(profile: string, region: string, args: string[]): unknown {
  const out = execFileSync('aws', ['--profile', profile, '--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function loadAwsProfileCredentials(profile: string, region: string): AwsEcsCredentials {
  const out = awsJson(profile, region, ['configure', 'export-credentials']) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
  };
  return {
    accessKeyId: out.AccessKeyId,
    secretAccessKey: out.SecretAccessKey,
    ...(out.SessionToken ? { sessionToken: out.SessionToken } : {}),
  };
}

function getOperatorToken(profile: string, region: string, secretArn: string): string {
  const out = awsJson(profile, region, ['secretsmanager', 'get-secret-value', '--secret-id', secretArn]) as {
    SecretString?: string;
  };
  if (!out.SecretString) throw new Error('Missing operator token SecretString');
  return out.SecretString.trim();
}

async function apiJson<T>(url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Control Plane ${url} failed with HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return (await res.json()) as T;
}


/**
 * Live AWS proof that the Control Plane publishes a Draft PR with a GitHub App installation token.
 *
 * It registers one very small delivery task against `roboco-io/project-hivemind` (create one probe file),
 * approves it, and waits while the Fargate Spot worker, the independent verifier and the Control Plane run.
 * The caller must start ControlPlaneService before and stop it after. This run makes real model calls and
 * opens a real Draft PR. It never prints the operator token.
 */
async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const outputsPath = process.env.HIVEMIND_CDK_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json';
  const outputs = (JSON.parse(readFileSync(outputsPath, 'utf8')) as Record<string, Record<string, string>>).HivemindAwsRuntimeStack;
  if (!outputs) throw new Error('Missing HivemindAwsRuntimeStack outputs');
  const cluster = outputs.ClusterName!;
  const service = outputs.ControlPlaneServiceName!;
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14371');
  const baseBranch = process.env.HIVEMIND_BASE_BRANCH ?? 'main';
  const provider = (process.env.HIVEMIND_PROVIDER ?? 'codex') as 'codex' | 'claude';
  const repository = 'roboco-io/project-hivemind';

  const repoRoot = process.cwd();
  const baseCommit = execFileSync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const operatorToken = getOperatorToken(profile, region, outputs.OperatorTokenSecretArn!);
  const s3 = createAwsS3ArtifactsPort({
    region,
    allowedRegions: [region],
    bucket: outputs.ArtifactsBucketName!,
    credentials: () => loadAwsProfileCredentials(profile, region),
  });
  const signal = new AbortController().signal;
  const stamp = Date.now();
  const probePath = `docs/verification/probes/github-app-draft-pr-${stamp}.md`;
  const heading = '# GitHub App Draft PR probe';

  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-ghapp-proof-'));
  try {
    const bundlePath = join(scratch, 'project-hivemind.bundle');
    const manifest = await createPinnedGitBundle(repoRoot, baseCommit, bundlePath, signal);
    const bundleS3Key = `bundles/ghapp-${stamp}-${baseCommit.slice(0, 12)}.bundle`;
    await s3.putObject(bundleS3Key, readFileSync(bundlePath), 'application/octet-stream', signal);

    // Acceptance: the probe file exists and starts with the fixed heading. package.json is pinned so the
    // worker cannot change the project's scripts.
    const acceptanceScript = [
      "const fs=require('node:fs');",
      `const t=fs.readFileSync(${JSON.stringify(probePath)},'utf8');`,
      `if(!t.startsWith(${JSON.stringify(heading)}))throw new Error('probe heading missing');`,
      "if(t.trim().split('\\n').length<3)throw new Error('probe body missing');",
    ].join('');
    const acceptance = await captureAcceptanceTestSpec(repoRoot, baseCommit, ['package.json'], ['node', '-e', acceptanceScript], signal);

    let tunnel = openSsmTunnel(profile, region, cluster, service, localPort);
    await tunnel.ready;
    let taskId: string;
    let approvedAtMs: number;
    try {
      const created = await apiJson<DeliveryTask>(`http://127.0.0.1:${localPort}/api/delivery/tasks`, operatorToken, {
        title: 'Add GitHub App Draft PR probe note',
        instructions: [
          `Create exactly one new file at \`${probePath}\`.`,
          `Its first line must be exactly \`${heading}\`.`,
          'After a blank line, add one sentence stating that this file is a probe created to verify that the Control Plane publishes Draft PRs with a GitHub App installation token, and that the pull request is not meant to be merged.',
          'Do not create, modify or delete any other file. Do not modify `package.json`.',
        ].join('\n'),
        provider,
        maxIterations: 2,
        budgetMicros: 300_000,
        acceptance,
        delivery: { mode: 'draft_pr', repository, baseBranch, branchPrefix: 'hivemind/', autoMerge: false },
        bundle: { ...manifest, s3Key: bundleS3Key },
        spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
      });
      taskId = created.id;
      const approved = await apiJson<DeliveryTask>(
        `http://127.0.0.1:${localPort}/api/delivery/tasks/${encodeURIComponent(taskId)}/approve`,
        operatorToken,
        { approvalFingerprint: created.approvalFingerprint, reason: 'GitHub App installation token Draft PR proof' },
      );
      approvedAtMs = Date.now();
      console.log(JSON.stringify({ step: 'approved', taskId, status: approved.status, baseCommit, probePath }));
    } finally {
      tunnel.close();
    }

    const deadline = Date.now() + 900_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20_000));
      tunnel = openSsmTunnel(profile, region, cluster, service, localPort);
      await tunnel.ready;
      try {
        const detail = await apiJson<{ task: DeliveryTask }>(
          `http://127.0.0.1:${localPort}/api/delivery/tasks/${encodeURIComponent(taskId)}`,
          operatorToken,
        );
        const task = detail.task;
        console.log(JSON.stringify({ step: 'poll', status: task.status, iteration: task.currentIteration, attestations: task.attestations.length }));
        if (['draft_pr_published', 'failed', 'cancelled', 'approved', 'rejected'].includes(task.status)) {
          console.log(
            JSON.stringify(
              {
                step: 'final',
                ok: task.status === 'draft_pr_published',
                taskId,
                status: task.status,
                elapsedMs: Date.now() - approvedAtMs,
                prUrl: task.publication?.prUrl ?? null,
                prNumber: task.publication?.prNumber ?? null,
                treeHashMatch: Boolean(task.publication) && task.publication?.verifiedTreeHash === task.publication?.prTreeHash,
                failureReason: task.failureReason ? task.failureReason.slice(0, 500) : null,
              },
              null,
              2,
            ),
          );
          if (task.status !== 'draft_pr_published') process.exitCode = 1;
          return;
        }
      } finally {
        tunnel.close();
      }
    }
    throw new Error('Timed out waiting for the delivery task to finish');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
