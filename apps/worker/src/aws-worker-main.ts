import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryProvider } from '../../../packages/contracts/src/delivery.js';
import { createAwsS3ArtifactsPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { createEcsTaskCredentialsProvider } from '../../../packages/adapters/src/aws-ecs-metadata-creds.js';
import { createAwsSecretsManagerPort } from '../../../packages/adapters/src/aws-secrets-manager.js';
import { processEnvironment, runProcess } from '../../../packages/adapters/src/process.js';
import { materializeProviderAuth, redactWorkerOutput } from './aws-worker-auth.js';
import { runAwsWorkerOnce } from './aws-worker-runtime.js';

interface WorkerSpec {
  taskId: string;
  runId: string;
  iteration: number;
  maxIterations: number;
  provider: DeliveryProvider;
  title: string;
  instructions: string;
  baseCommit: string;
  acceptancePaths: string[];
  testCommand: string[];
  priorVerificationSummary: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function buildWorkerPrompt(spec: WorkerSpec): string {
  const lines = [
    `# HIVEMIND SW Delivery Task (${spec.taskId}, iteration ${spec.iteration}/${spec.maxIterations})`,
    '',
    `Title: ${spec.title}`,
    '',
    '## Instructions',
    spec.instructions,
    '',
    '## Immutable Acceptance Contract (STRICT)',
    '- You MUST NOT modify, delete, or overwrite any of the following pinned acceptance files (the independent verifier will reject your patch immediately):',
    ...spec.acceptancePaths.map((p) => `  - ${p}`),
    `- Fixed independent verification command: ${JSON.stringify(spec.testCommand)}`,
    '- Run relevant checks in this repository before finishing so your patch passes the verification command cleanly.',
    '- Do NOT create git commits or push anything; leave your clean edits in the working tree.',
    '',
    '## Final Response Format (Required for Operator No-Diff Review)',
    'End your final message with a concise structured summary (in Korean if instructions are Korean, otherwise English) containing:',
    '1. **변경 파일별 요약**: each modified/added file and why it was changed',
    '2. **핵심 동작 변화**: externally observable behavior, auth/error handling, and edge cases covered',
    '3. **자체 확인 결과**: exact build/test commands run and their results',
  ];
  if (spec.priorVerificationSummary) {
    lines.push(
      '',
      '## Previous Independent Verifier Failure (Fix this root cause)',
      spec.priorVerificationSummary,
    );
  }
  return lines.join('\n') + '\n';
}

async function fetchWorkerSpec(controlApiUrl: string, workerToken: string, taskId: string, runId: string): Promise<WorkerSpec> {
  const url = new URL(`/api/delivery/tasks/${encodeURIComponent(taskId)}/worker-spec`, controlApiUrl);
  url.searchParams.set('runId', runId);
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${workerToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch worker spec from control plane (HTTP ${res.status})`);
  }
  return (await res.json()) as WorkerSpec;
}

async function reportWorkerCompleted(
  controlApiUrl: string,
  workerToken: string,
  payload: { taskId: string; runId: string; patchS3Key: string; patchSha256: string; summary: string },
): Promise<void> {
  const res = await fetch(
    new URL(`/api/delivery/tasks/${encodeURIComponent(payload.taskId)}/worker-completed`, controlApiUrl),
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        runId: payload.runId,
        patchS3Key: payload.patchS3Key,
        patchSha256: payload.patchSha256,
        summary: payload.summary,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Worker completion handoff failed with HTTP ${res.status}`);
  }
}

async function main(): Promise<void> {
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const bucket = requiredEnv('HIVEMIND_ARTIFACTS_BUCKET');
  const controlApiUrl = requiredEnv('HIVEMIND_CONTROL_API_URL');
  const workerToken = requiredEnv('HIVEMIND_WORKER_TOKEN');
  const taskId = requiredEnv('HIVEMIND_TASK_ID');
  const runId = requiredEnv('HIVEMIND_RUN_ID');
  const iteration = Number(requiredEnv('HIVEMIND_ITERATION'));
  const bundleS3Key = requiredEnv('HIVEMIND_BUNDLE_S3_KEY');
  const bundleSha256 = requiredEnv('HIVEMIND_BUNDLE_SHA256');
  const modelAuthSecretArn = requiredEnv('HIVEMIND_MODEL_AUTH_SECRET_ARN');
  const checkpointS3Key = process.env.HIVEMIND_CHECKPOINT_S3_KEY?.trim() || undefined;
  const spotFlushTimeoutMs = Number(process.env.HIVEMIND_SPOT_FLUSH_TIMEOUT_MS ?? '90000');
  const workRoot = process.env.HIVEMIND_WORK_ROOT?.trim() || undefined;

  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error('Invalid HIVEMIND_ITERATION');
  }

  const credentials = createEcsTaskCredentialsProvider();
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials });
  const secretsManager = createAwsSecretsManagerPort({ region, allowedRegions: [region], credentials });

  const spec = await fetchWorkerSpec(controlApiUrl, workerToken, taskId, runId);
  if (spec.provider !== 'codex' && spec.provider !== 'claude') {
    throw new Error('AWS worker supports only codex or claude providers');
  }

  const secretString = await secretsManager.getSecretString(modelAuthSecretArn, AbortSignal.timeout(15_000));
  const auth = await materializeProviderAuth(spec.provider, secretString, join(workRoot ?? '/tmp/hivemind', 'auth'));

  const spotController = new AbortController();
  const onSigterm = () => spotController.abort(new Error('SIGTERM'));
  process.once('SIGTERM', onSigterm);

  try {
    const outcome = await runAwsWorkerOnce({
      taskId,
      runId,
      iteration,
      baseCommit: spec.baseCommit,
      bundleS3Key,
      bundleSha256,
      checkpointS3Key,
      s3,
      spotSignal: spotController.signal,
      spotFlushTimeoutMs,
      workRoot,
      control: {
        async reportSpotInterrupted(payload) {
          const res = await fetch(
            new URL(`/api/delivery/tasks/${encodeURIComponent(payload.taskId)}/spot-interrupted`, controlApiUrl),
            {
              method: 'POST',
              redirect: 'error',
              headers: {
                authorization: `Bearer ${workerToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                runId: payload.runId,
                checkpointRef: payload.checkpointRef,
                reason: payload.reason,
              }),
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (!res.ok) throw new Error(`Spot interruption report failed with HTTP ${res.status}`);
        },
      },
      executor: {
        async run(ctx) {
          const prompt = buildWorkerPrompt(spec);
          const homeDir = join(ctx.workspacePath, '..', 'home');
          const lastMessageFile = join(ctx.workspacePath, '..', 'last-message.txt');
          const baseEnv = processEnvironment(homeDir, spec.provider === 'codex' ? true : 'claude');
          const env: NodeJS.ProcessEnv = { ...baseEnv, ...auth.env };

          let cmd: string[];
          if (spec.provider === 'codex') {
            // Fargate Firecracker microVM provides the external sandbox; default to danger-full-access inside container.
            const sandboxMode = process.env.HIVEMIND_CODEX_SANDBOX_MODE ?? 'danger-full-access';
            cmd = [
              process.env.HIVEMIND_CODEX_BIN ?? 'codex',
              'exec',
              '--ignore-user-config',
              '--ephemeral',
              '--skip-git-repo-check',
              '--sandbox',
              sandboxMode,
              '--cd',
              ctx.workspacePath,
              '--output-last-message',
              lastMessageFile,
              ...(auth.model ? ['--model', auth.model] : []),
              '-',
            ];
          } else {
            cmd = [
              process.env.HIVEMIND_CLAUDE_BIN ?? 'claude',
              '--print',
              '--permission-mode',
              'acceptEdits',
              '--no-session-persistence',
              '--disable-slash-commands',
              ...(auth.model ? ['--model', auth.model] : []),
            ];
          }

          const res = await runProcess(cmd, {
            cwd: ctx.workspacePath,
            signal: ctx.signal,
            timeoutMs: Number(process.env.HIVEMIND_AGENT_TIMEOUT_MS ?? '600000'),
            input: prompt,
            env,
            maxOutputBytes: 256_000,
          });
          if (res.status !== 'passed') {
            const combined = [res.stderr, res.stdout].filter(Boolean).join('\n--- stdout ---\n');
            const safeErr = redactWorkerOutput(combined, [...auth.redactSecrets, workerToken]).slice(-2500);
            throw new Error(`${spec.provider} CLI failed (${res.status}, exit ${res.exitCode ?? 'null'}): ${safeErr}`);
          }
          let summary = `${spec.provider} iteration ${ctx.iteration} completed.`;
          if (spec.provider === 'codex') {
            const lastMsg = await readFile(lastMessageFile, 'utf8').catch(() => '');
            if (lastMsg.trim()) summary = lastMsg.trim();
          } else if (res.stdout.trim()) {
            summary = res.stdout.trim();
          }
          return {
            summary: redactWorkerOutput(summary, [...auth.redactSecrets, workerToken]).slice(0, 4000),
          };
        },
      },
    });

    if (outcome.kind === 'completed') {
      await reportWorkerCompleted(controlApiUrl, workerToken, {
        taskId,
        runId,
        patchS3Key: outcome.patchS3Key,
        patchSha256: outcome.patchSha256,
        summary: outcome.summary,
      });
    }

    console.log(
      JSON.stringify({
        event: 'hivemind.aws_worker.finished',
        taskId,
        runId,
        kind: outcome.kind,
        ...(outcome.kind === 'completed'
          ? { patchS3Key: outcome.patchS3Key, patchSha256: outcome.patchSha256 }
          : { checkpointS3Key: outcome.checkpointS3Key }),
      }),
    );
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    await auth.cleanup().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactWorkerOutput(message, [process.env.HIVEMIND_WORKER_TOKEN ?? '']));
  process.exitCode = 1;
});
