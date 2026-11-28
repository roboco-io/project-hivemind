import { controlFetch } from './control-fetch.js';
import { readFile } from 'node:fs/promises';
import { setUpCollabWorkerOrFailSubtask } from './collab-worker-setup.js';
import { join } from 'node:path';
import type { DeliveryPreflightReport } from '../../../packages/contracts/src/delivery.js';
import { createAwsS3ArtifactsPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { createEcsTaskCredentialsProvider } from '../../../packages/adapters/src/aws-ecs-metadata-creds.js';
import { createAwsSecretsManagerPort } from '../../../packages/adapters/src/aws-secrets-manager.js';
import { processEnvironment, runProcess } from '../../../packages/adapters/src/process.js';
import { materializeProviderAuth, redactWorkerOutput } from './aws-worker-auth.js';
import {
  buildAgentAccessEnv,
  buildWorkerCliCommand,
  buildWorkerPrompt,
  runWorkerPreflight,
  type WorkerPromptSpec,
} from './aws-worker-policy.js';
import { runAwsWorkerOnce } from './aws-worker-runtime.js';

type WorkerSpec = WorkerPromptSpec;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function reportWorkerPreflight(
  controlApiUrl: string,
  workerToken: string,
  taskId: string,
  report: Omit<DeliveryPreflightReport, 'checkedAt'>,
): Promise<void> {
  const res = await controlFetch(
    new URL(`/api/delivery/tasks/${encodeURIComponent(taskId)}/preflight`, controlApiUrl),
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Worker preflight report failed with HTTP ${res.status}`);
  }
}

async function fetchWorkerSpec(controlApiUrl: string, workerToken: string, taskId: string, runId: string): Promise<WorkerSpec> {
  const url = new URL(`/api/delivery/tasks/${encodeURIComponent(taskId)}/worker-spec`, controlApiUrl);
  url.searchParams.set('runId', runId);
  const res = await controlFetch(url, {
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
  payload: {
    taskId: string;
    runId: string;
    patchS3Key: string;
    patchSha256: string;
    summary: string;
    checkpointS3Key?: string;
  },
): Promise<void> {
  const res = await controlFetch(
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
        ...(payload.checkpointS3Key ? { checkpointS3Key: payload.checkpointS3Key } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Worker completion handoff failed with HTTP ${res.status}`);
  }
}

async function runCollabWorkerMode(): Promise<void> {
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const controlApiUrl = requiredEnv('HIVEMIND_CONTROL_API_URL');
  const workerToken = requiredEnv('HIVEMIND_WORKER_TOKEN');
  /** Model Factory agent token (issue #20); given to the model only when the task opted in. Empty when not configured. */
  const agentToken = process.env.HIVEMIND_AGENT_TOKEN?.trim() ?? '';
  const sessionId = requiredEnv('HIVEMIND_COLLAB_SESSION_ID');
  const subtaskId = requiredEnv('HIVEMIND_COLLAB_SUBTASK_ID');
  const agentId = requiredEnv('HIVEMIND_COLLAB_AGENT_ID');
  const modelAuthSecretArn = requiredEnv('HIVEMIND_MODEL_AUTH_SECRET_ARN');
  const workRoot = process.env.HIVEMIND_WORK_ROOT?.trim() || '/tmp/hivemind';

  const credentials = createEcsTaskCredentialsProvider();
  const secretsManager = createAwsSecretsManagerPort({ region, allowedRegions: [region], credentials });

  const snapRes = await controlFetch(new URL(`/api/collab/sessions/${encodeURIComponent(sessionId)}`, controlApiUrl), {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${workerToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!snapRes.ok) throw new Error(`Failed to fetch collab snapshot (HTTP ${snapRes.status})`);
  const snapshot = (await snapRes.json()) as {
    session: { title: string; goal: string; provider: 'claude' | 'codex' };
    subtasks: { id: string; title: string; instructions: string; provider: 'claude' | 'codex' }[];
    messages: { seq: number; sender: string; recipient: string | null; kind: string; body: string }[];
    workLogs: { agentId: string; kind: string; summary: string; s3Uri: string | null }[];
  };
  const subtask = snapshot.subtasks.find((s) => s.id === subtaskId);
  if (!subtask) throw new Error(`Subtask ${subtaskId} not found in session ${sessionId}`);

  const postCollab = async (path: string, body: Record<string, unknown>) => {
    const res = await controlFetch(new URL(path, controlApiUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Collab API ${path} failed with HTTP ${res.status}`);
  };

  const provider = subtask.provider;
  const auth = await setUpCollabWorkerOrFailSubtask(
    async () => {
      const secretString = await secretsManager.getSecretString(modelAuthSecretArn, AbortSignal.timeout(15_000));
      return materializeProviderAuth(provider, secretString, join(workRoot, `collab-auth-${agentId}`));
    },
    (failureReason) =>
      postCollab(`/api/collab/sessions/${encodeURIComponent(sessionId)}/subtasks/${encodeURIComponent(subtaskId)}/finish`, {
        agentId,
        status: 'failed',
        failureReason,
      }),
  );

  try {
    const prompt = [
      `# HIVEMIND Parallel ECS Fargate Spot Agent (${agentId})`,
      `Session: ${snapshot.session.title} (${sessionId})`,
      `Goal: ${snapshot.session.goal}`,
      `Subtask: ${subtask.title} (${subtask.id})`,
      '',
      '## Instructions',
      subtask.instructions,
      '',
      '## Shared Communication Board (Recent Messages)',
      ...snapshot.messages.slice(-25).map((m) => `[#${m.seq} ${m.sender} -> ${m.recipient ?? '@all'} (${m.kind})]: ${m.body}`),
      '',
      '## Shared Work Logs',
      ...snapshot.workLogs.slice(-25).map((l) => `- ${l.agentId} (${l.kind}): ${l.summary}${l.s3Uri ? ` [${l.s3Uri}]` : ''}`),
      '',
      '## Live Collaboration API (Available during your run)',
      `- Post message: POST ${controlApiUrl}/api/collab/sessions/${sessionId}/messages (Bearer $HIVEMIND_WORKER_TOKEN)`,
      `- Append work log: POST ${controlApiUrl}/api/collab/sessions/${sessionId}/work-logs (Bearer $HIVEMIND_WORKER_TOKEN)`,
    ].join('\n');

    const homeDir = join(workRoot, `collab-home-${agentId}`);
    const lastMessageFile = join(workRoot, `collab-last-${agentId}.txt`);
    const baseEnv = processEnvironment(homeDir, provider === 'codex' ? true : 'claude');
    const cliBin = provider === 'codex' ? (process.env.HIVEMIND_CODEX_BIN ?? 'codex') : (process.env.HIVEMIND_CLAUDE_BIN ?? 'claude');
    const { cmd, extraEnv } = buildWorkerCliCommand({
      provider,
      cliBin,
      workspacePath: workRoot,
      lastMessageFile,
      model: auth.model,
      sandboxMode: process.env.HIVEMIND_CODEX_SANDBOX_MODE ?? 'danger-full-access',
    });
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...auth.env,
      ...extraEnv,
      HIVEMIND_CONTROL_API_URL: controlApiUrl,
      HIVEMIND_WORKER_TOKEN: workerToken,
      HIVEMIND_COLLAB_SESSION_ID: sessionId,
      HIVEMIND_COLLAB_SUBTASK_ID: subtaskId,
      HIVEMIND_COLLAB_AGENT_ID: agentId,
    };

    const res = await runProcess(cmd, {
      cwd: workRoot,
      signal: AbortSignal.timeout(Number(process.env.HIVEMIND_AGENT_TIMEOUT_MS ?? '1800000')),
      timeoutMs: Number(process.env.HIVEMIND_AGENT_TIMEOUT_MS ?? '1800000'),
      input: prompt,
      env,
      maxOutputBytes: 256_000,
    });

    if (res.status !== 'passed') {
      const safeErr = redactWorkerOutput(`${res.stderr}\n${res.stdout}`, [...auth.redactSecrets, workerToken, agentToken]).slice(-2000);
      await postCollab(`/api/collab/sessions/${encodeURIComponent(sessionId)}/subtasks/${encodeURIComponent(subtaskId)}/finish`, {
        agentId,
        status: 'failed',
        failureReason: safeErr,
      });
      await postCollab(`/api/collab/sessions/${encodeURIComponent(sessionId)}/messages`, {
        sender: agentId,
        recipient: 'coordinator',
        kind: 'blocker',
        body: `Subtask ${subtaskId} failed: ${safeErr.slice(0, 1000)}`,
      });
      throw new Error(`Collab worker failed: ${safeErr}`);
    }

    let summary = res.stdout.trim();
    if (provider === 'codex') {
      const last = await readFile(lastMessageFile, 'utf8').catch(() => '');
      if (last.trim()) summary = last.trim();
    }
    const cleanSummary = redactWorkerOutput(summary || `Completed subtask ${subtask.title}`, [...auth.redactSecrets, workerToken, agentToken]).slice(0, 8000);

    await postCollab(`/api/collab/sessions/${encodeURIComponent(sessionId)}/work-logs`, {
      subtaskId,
      agentId,
      kind: 'progress',
      summary: cleanSummary.slice(0, 4000),
    });
    await postCollab(`/api/collab/sessions/${encodeURIComponent(sessionId)}/messages`, {
      sender: agentId,
      recipient: 'coordinator',
      kind: 'handoff',
      body: cleanSummary,
    });
    await postCollab(`/api/collab/sessions/${encodeURIComponent(sessionId)}/subtasks/${encodeURIComponent(subtaskId)}/finish`, {
      agentId,
      status: 'completed',
      summary: cleanSummary,
    });
  } finally {
    await auth.cleanup().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.env.HIVEMIND_COLLAB_MODE === 'true') {
    await runCollabWorkerMode();
    return;
  }
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const bucket = requiredEnv('HIVEMIND_ARTIFACTS_BUCKET');
  const controlApiUrl = requiredEnv('HIVEMIND_CONTROL_API_URL');
  const workerToken = requiredEnv('HIVEMIND_WORKER_TOKEN');
  /** Model Factory agent token (issue #20); given to the model only when the task opted in. Empty when not configured. */
  const agentToken = process.env.HIVEMIND_AGENT_TOKEN?.trim() ?? '';
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
      forbiddenPatchValues: [workerToken, agentToken, ...auth.redactSecrets].filter(Boolean),
      taskId,
      runId,
      iteration,
      baseCommit: spec.baseCommit,
      bundleS3Key,
      bundleSha256,
      checkpointS3Key,
      preserveWorkspaceOnRetry: spec.executionPolicy?.preserveWorkspaceOnRetry ?? false,
      s3,
      spotSignal: spotController.signal,
      spotFlushTimeoutMs,
      workRoot,
      control: {
        async reportSpotInterrupted(payload) {
          const res = await controlFetch(
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
          const prompt = buildWorkerPrompt(spec, Boolean(ctx.restoredCheckpointPatch));
          const homeDir = join(ctx.workspacePath, '..', 'home');
          const lastMessageFile = join(ctx.workspacePath, '..', 'last-message.txt');
          const baseEnv = processEnvironment(homeDir, spec.provider === 'codex' ? true : 'claude');
          const cliBin =
            spec.provider === 'codex'
              ? process.env.HIVEMIND_CODEX_BIN ?? 'codex'
              : process.env.HIVEMIND_CLAUDE_BIN ?? 'claude';
          const { cmd, extraEnv } = buildWorkerCliCommand({
            provider: spec.provider,
            cliBin,
            workspacePath: ctx.workspacePath,
            lastMessageFile,
            model: auth.model,
            sandboxMode: process.env.HIVEMIND_CODEX_SANDBOX_MODE ?? 'danger-full-access',
            executionPolicy: spec.executionPolicy,
          });
          // Issue #20: a task that opted in gets the Model Factory agent token, so the model can create training
          // jobs and ask for scoped AWS credentials through the Control Plane. Nothing else gets it.
          const agentAccess = buildAgentAccessEnv(spec.executionPolicy, agentToken, controlApiUrl);
          const env: NodeJS.ProcessEnv = { ...baseEnv, ...auth.env, ...extraEnv, ...agentAccess };

          // Run CLI/auth/git pre-flight BEFORE invoking the model (Lesson #3).
          const preflight = await runWorkerPreflight({
            runId: ctx.runId,
            provider: spec.provider,
            cliBin,
            workspacePath: ctx.workspacePath,
            authReady: true,
            executionPolicy: spec.executionPolicy,
            env,
            signal: ctx.signal,
          });
          await reportWorkerPreflight(controlApiUrl, workerToken, ctx.taskId, preflight);
          if (!preflight.ok) {
            throw new Error(`Worker preflight failed: ${preflight.reason ?? 'unknown preflight failure'}`);
          }

          const configuredTimeout =
            spec.executionPolicy?.maxIterationDurationMs ??
            Number(process.env.HIVEMIND_AGENT_TIMEOUT_MS ?? '600000');

          const res = await runProcess(cmd, {
            cwd: ctx.workspacePath,
            signal: ctx.signal,
            timeoutMs: configuredTimeout,
            input: prompt,
            env,
            maxOutputBytes: 256_000,
          });
          if (res.status !== 'passed') {
            const combined = [res.stderr, res.stdout].filter(Boolean).join('\n--- stdout ---\n');
            const safeErr = redactWorkerOutput(combined, [...auth.redactSecrets, workerToken, agentToken]).slice(-2500);
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
            summary: redactWorkerOutput(summary, [...auth.redactSecrets, workerToken, agentToken]).slice(0, 4000),
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
        ...(outcome.checkpointS3Key ? { checkpointS3Key: outcome.checkpointS3Key } : {}),
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
