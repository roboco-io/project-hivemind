import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveryTask } from '../packages/contracts/src/delivery.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { captureAcceptanceTestSpec, createPinnedGitBundle } from '../packages/adapters/src/git-bundle.js';

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

function openSsmTunnel(
  profile: string,
  region: string,
  cluster: string,
  service: string,
  localPort: number,
): { close: () => void; ready: Promise<void> } {
  const listed = awsJson(profile, region, [
    'ecs',
    'list-tasks',
    '--cluster',
    cluster,
    '--service-name',
    service,
    '--desired-status',
    'RUNNING',
  ]) as { taskArns?: string[] };
  const taskArn = listed.taskArns?.[0];
  if (!taskArn) throw new Error(`No RUNNING ControlPlaneService task in ${cluster}`);
  const described = awsJson(profile, region, ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]) as {
    tasks?: { containers?: { name?: string; runtimeId?: string }[] }[];
  };
  const runtimeId = described.tasks?.[0]?.containers?.find((c) => c.name === 'control-plane')?.runtimeId;
  const taskId = taskArn.split('/').pop();
  if (!taskId || !runtimeId) throw new Error('Control plane task missing runtimeId for SSM Exec');

  const target = `ecs:${cluster}_${taskId}_${runtimeId}`;
  const child = spawn(
    'aws',
    [
      '--profile',
      profile,
      '--region',
      region,
      'ssm',
      'start-session',
      '--target',
      target,
      '--document-name',
      'AWS-StartPortForwardingSession',
      '--parameters',
      JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(localPort)] }),
    ],
    { stdio: 'ignore' },
  );

  const ready = (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        // Tunnel still opening.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    child.kill('SIGTERM');
    throw new Error('Timed out waiting for SSM tunnel to ControlPlaneService');
  })();

  return {
    ready,
    close: () => {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
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

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const outputsPath = process.env.HIVEMIND_CDK_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json';
  const rawOutputs = JSON.parse(readFileSync(outputsPath, 'utf8')) as Record<string, Record<string, string>>;
  const outputs = rawOutputs.HivemindAwsRuntimeStack;
  if (!outputs) throw new Error('Missing HivemindAwsRuntimeStack outputs');

  const cluster = outputs.ClusterName!;
  const service = outputs.ControlPlaneServiceName!;
  const bucket = outputs.ArtifactsBucketName!;
  const operatorSecretArn = outputs.OperatorTokenSecretArn!;
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14311');
  const baseBranch = process.env.HIVEMIND_BASE_BRANCH ?? 'main';
  const provider = (process.env.HIVEMIND_PROVIDER ?? 'codex') as 'codex' | 'claude';

  const repoRoot = process.cwd();
  const baseCommit = execFileSync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const operatorToken = getOperatorToken(profile, region, operatorSecretArn);
  const credentials = () => loadAwsProfileCredentials(profile, region);
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials });
  const signal = new AbortController().signal;

  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-m1-live-'));
  try {
    // 1. Package real project-hivemind repository at origin/main into pinned git bundle and upload to KMS S3.
    const bundlePath = join(scratch, 'project-hivemind.bundle');
    const manifest = await createPinnedGitBundle(repoRoot, baseCommit, bundlePath, signal);
    const bundleS3Key = `bundles/m1-${Date.now()}-${baseCommit.slice(0, 12)}.bundle`;
    await s3.putObject(bundleS3Key, readFileSync(bundlePath), 'application/octet-stream', signal);

    // 2. Capture immutable acceptance spec pinned at origin/main (worker cannot modify tests/api.test.ts or contracts).
    // Keep testCommand arg strictly under 1000 chars per DeliveryStore policy (~840 chars).
    const acceptanceScript = [
      "import a from 'node:assert/strict';import {execFileSync as x} from 'node:child_process';",
      "x('tsc');x('node',['--test','dist/tests/api.test.js']);",
      "const {buildApp}=await import('./dist/apps/control-plane/src/app.js');const s=buildApp();",
      "try{const H=v=>({authorization:'Bearer '+v}),O=H('local-development-only'),W=H('local-worker-only');",
      "const q=(u,h,b)=>s.inject({method:b?'POST':'GET',url:u,headers:h,payload:b});",
      "const p={title:'A',instructions:'ok',budgetMicros:5e3,provider:'mock',runtime:'local'};",
      "const t=(await q('/api/tasks',O,p)).json();await q('/api/tasks',O,{...p,title:'B'});",
      "const u=`/api/tasks/${t.id}`;",
      "a.equal((await q(u)).statusCode,401);a.equal((await q(u,W)).statusCode,401);",
      "a.equal((await q('/api/tasks/no',O)).statusCode,404);",
      "const r=await q(u,O);a.equal(r.statusCode,200);const b=r.json();",
      "a.equal(b.task.id,t.id);a.ok(b.events.length>0&&b.events.every(e=>e.taskId===t.id)&&!JSON.stringify(b).includes('local-worker-only'));",
      "}finally{await s.close();}",
    ].join('');
    if (acceptanceScript.length > 980) throw new Error(`acceptanceScript too long: ${acceptanceScript.length}`);

    const acceptance = await captureAcceptanceTestSpec(
      repoRoot,
      baseCommit,
      ['tests/api.test.ts', 'packages/contracts/src/index.ts'],
      ['node', '--input-type=module', '-e', acceptanceScript],
      signal,
    );

    console.log(
      JSON.stringify({
        step: 'bundle_and_acceptance_prepared',
        baseBranch,
        baseCommit,
        fileCount: manifest.fileCount,
        bundleSizeBytes: manifest.sizeBytes,
        bundleS3Key,
        acceptanceDigest: acceptance.digest,
      }),
    );

    // 3. Open SSM tunnel ONLY to create + approve the task, then CLOSE THE TUNNEL to prove unattended AWS execution!
    let tunnel = openSsmTunnel(profile, region, cluster, service, localPort);
    await tunnel.ready;
    let taskId: string;
    let approvedAtMs: number;
    try {
      const created = await apiJson<DeliveryTask>(`http://127.0.0.1:${localPort}/api/delivery/tasks`, operatorToken, {
        title: 'Add operator-only GET /api/tasks/:id detail endpoint',
        instructions: [
          'Implement an operator-authenticated `GET /api/tasks/:id` endpoint in `apps/control-plane/src/app.ts` (and helper method on `HiveStore` in `packages/core/src/store.ts` if appropriate).',
          'Requirements:',
          '1. Require operator authentication (`preHandler: operator`); unauthenticated or worker requests must return HTTP 401.',
          '2. Return HTTP 404 when no task with `:id` exists (using `DomainError` 404 or equivalent).',
          '3. Return HTTP 200 with JSON `{ task, events }` where `task` is the matching task and `events` is the array of events whose `taskId === task.id`.',
          '4. Never expose worker/operator tokens or alter existing `/api/state`, `/api/tasks` POST, or `tests/api.test.ts`.',
          '5. Do NOT modify `tests/api.test.ts` or `packages/contracts/src/index.ts` (they are pinned immutable acceptance files).',
        ].join('\n'),
        provider,
        maxIterations: 3,
        budgetMicros: 500_000,
        acceptance,
        delivery: {
          mode: 'draft_pr',
          repository: 'roboco-io/project-hivemind',
          baseBranch,
          branchPrefix: 'hivemind/',
          autoMerge: false,
        },
        bundle: { ...manifest, s3Key: bundleS3Key },
        spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
      });
      taskId = created.id;

      const approved = await apiJson<DeliveryTask>(
        `http://127.0.0.1:${localPort}/api/delivery/tasks/${encodeURIComponent(taskId)}/approve`,
        operatorToken,
        {
          approvalFingerprint: created.approvalFingerprint,
          reason: 'Milestone 1 live unattended AWS Fargate Spot verification',
        },
      );
      approvedAtMs = Date.now();
      console.log(
        JSON.stringify({
          step: 'approved_and_closing_ssm_tunnel',
          taskId,
          status: approved.status,
          activeRunId: approved.activeRunId,
          approvalFingerprint: created.approvalFingerprint,
        }),
      );
    } finally {
      tunnel.close();
    }

    // 4. Wait with SSM tunnel CLOSED while AWS Fargate Spot Worker -> Verifier -> Control Plane Draft PR run unattended.
    // Poll ECS cluster tasks only via AWS read-only DescribeTasks/ListTasks until both worker & verifier finish.
    console.log(JSON.stringify({ step: 'tunnel_closed_waiting_unattended_aws', taskId }));
    const deadline = Date.now() + 900_000;
    let sawRunningWorkerOrVerifier = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      const running = awsJson(profile, region, [
        'ecs',
        'list-tasks',
        '--cluster',
        cluster,
        '--desired-status',
        'RUNNING',
      ]) as { taskArns?: string[] };
      const pending = awsJson(profile, region, [
        'ecs',
        'list-tasks',
        '--cluster',
        cluster,
        '--desired-status',
        'PENDING',
      ]) as { taskArns?: string[] };
      const activeCount = (running.taskArns?.length ?? 0) + (pending.taskArns?.length ?? 0);
      // ControlPlaneService itself is 1 RUNNING task; >1 means Fargate Spot worker/verifier is active.
      if (activeCount > 1) {
        sawRunningWorkerOrVerifier = true;
      } else if (sawRunningWorkerOrVerifier || Date.now() - approvedAtMs > 45_000) {
        // Re-open SSM tunnel briefly to inspect task status in ControlPlaneService.
        tunnel = openSsmTunnel(profile, region, cluster, service, localPort);
        await tunnel.ready;
        try {
          const detail = await apiJson<{ task: DeliveryTask; events: unknown[] }>(
            `http://127.0.0.1:${localPort}/api/delivery/tasks/${encodeURIComponent(taskId)}`,
            operatorToken,
          );
          console.log(
            JSON.stringify({
              step: 'poll_status',
              taskId,
              status: detail.task.status,
              iteration: detail.task.currentIteration,
              attestations: detail.task.attestations.length,
              prUrl: detail.task.publication?.prUrl ?? null,
              failureReason: detail.task.failureReason,
            }),
          );
          if (['draft_pr_published', 'failed', 'cancelled', 'approved', 'rejected'].includes(detail.task.status)) {
            console.log(
              JSON.stringify(
                {
                  step: 'milestone1_final_result',
                  elapsedMs: Date.now() - approvedAtMs,
                  task: detail.task,
                  events: detail.events,
                },
                null,
                2,
              ),
            );
            if (detail.task.status !== 'draft_pr_published') {
              throw new Error(`Milestone 1 ended in status ${detail.task.status}: ${detail.task.failureReason ?? 'unknown'}`);
            }
            return;
          }
        } finally {
          tunnel.close();
        }
      }
    }
    throw new Error('Timed out waiting for unattended AWS Milestone 1 completion');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
