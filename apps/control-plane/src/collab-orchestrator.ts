import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CollabProvider,
  CollabSession,
  CollabSubtask,
} from '../../../packages/contracts/src/agent-collab.js';
import type { SpotPlacementFeedPort } from '../../../packages/adapters/src/spot-placement-feed.js';
import { processEnvironment, runProcess } from '../../../packages/adapters/src/process.js';
import type { AgentCollabService } from '../../../packages/core/src/agent-collab.js';
import { selectOptimalSpotPlacement } from '../../../packages/core/src/multi-region.js';
import { materializeProviderAuth, redactWorkerOutput } from '../../worker/src/aws-worker-auth.js';

export interface CollabWorkerLauncherPort {
  launchCollabWorker(
    input: {
      sessionId: string;
      subtaskId: string;
      agentId: string;
      provider: CollabProvider;
      targetRegion: string;
      targetAzId?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<{ taskArn: string; region: string }>;
}

export interface RunEmbeddedOrchestratorInput {
  sessionId: string;
  provider?: CollabProvider;
  model?: string;
  prompt?: string;
  /** Local Claude/Codex auth secret JSON or token passed ephemerally by the operator over SSM tunnel. NEVER persisted or logged. */
  localAuthSecret: string;
  timeoutMs?: number;
}

export interface EmbeddedAgentRunnerPort {
  run(input: {
    provider: CollabProvider;
    prompt: string;
    model?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ status: 'passed' | 'failed'; summary: string; error?: string }>;
}

export interface CollabOrchestratorOptions {
  service: AgentCollabService;
  controlApiUrl: string;
  workerToken: string;
  workerLauncher?: CollabWorkerLauncherPort;
  spotFeed?: SpotPlacementFeedPort;
  embeddedRunner?: EmbeddedAgentRunnerPort;
  workRoot?: string;
  redactSecrets?: string[];
  now?: () => number;
}

function buildEmbeddedOrchestratorPrompt(
  session: CollabSession,
  subtasks: CollabSubtask[],
  controlApiUrl: string,
  extraPrompt?: string,
): string {
  const lines = [
    `# HIVEMIND Control Plane Embedded Orchestrator (${session.id})`,
    '',
    `Title: ${session.title}`,
    `Goal: ${session.goal}`,
    `Max Parallel ECS Fargate Spot Workers: ${session.maxParallelWorkers}`,
    `Allowed AWS Regions: ${session.allowedRegions.join(', ')}`,
    '',
    '## Shared Collaboration API (Aurora DSQL / SQLite backed)',
    `- Base URL: ${controlApiUrl}`,
    '- Auth header: `Authorization: Bearer $HIVEMIND_WORKER_TOKEN`',
    `- List/create DAG subtasks: GET/POST ${controlApiUrl}/api/collab/sessions/${session.id}/subtasks`,
    `- Fan out ready subtasks onto parallel ECS Fargate Spot workers: POST ${controlApiUrl}/api/collab/sessions/${session.id}/fan-out`,
    `- Read/post shared agent communication board: GET/POST ${controlApiUrl}/api/collab/sessions/${session.id}/messages`,
    `- Read/append shared work logs & S3 artifact refs: GET/POST ${controlApiUrl}/api/collab/sessions/${session.id}/work-logs`,
    '',
    `Current subtasks (${subtasks.length}): ${JSON.stringify(subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status, dependsOn: s.dependsOn })))}`,
  ];
  if (extraPrompt?.trim()) {
    lines.push('', '## Operator Turn Prompt', extraPrompt.trim());
  }
  return lines.join('\n') + '\n';
}

export class CollabOrchestrator {
  private readonly now: () => number;
  private readonly workRoot: string;

  constructor(private readonly options: CollabOrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.workRoot = options.workRoot ?? tmpdir();
  }

  /**
   * Runs Claude Code or Codex directly inside the Control Plane ECS container using an ephemeral
   * operator-supplied local token while strictly stripping AWS IAM, GitHub, HF, Operator, and DSQL credentials
   * from the child process environment.
   */
  async runEmbeddedOrchestrator(
    input: RunEmbeddedOrchestratorInput,
    signal?: AbortSignal,
  ): Promise<CollabSession> {
    const session = await this.options.service.getSession(input.sessionId);
    const provider = input.provider ?? session.provider;
    const rawSecret = input.localAuthSecret?.trim();
    if (!rawSecret) {
      throw new Error('localAuthSecret is required to run the embedded Control Plane orchestrator');
    }

    const runId = `orch-${randomUUID()}`;
    const startedAt = new Date(this.now()).toISOString();
    await this.options.service.updateOrchestratorRun(session.id, {
      runId,
      provider,
      model: input.model ?? null,
      status: 'running',
      startedAt,
      finishedAt: null,
      summary: null,
      error: null,
    });

    const scratch = await mkdtemp(join(this.workRoot, 'hivemind-cp-agent-'));
    const homeDir = join(scratch, 'home');
    const authDir = join(scratch, 'auth');
    const lastMessageFile = join(scratch, 'last-message.txt');
    const auth = await materializeProviderAuth(provider, rawSecret, authDir);
    const allRedact = [
      ...(this.options.redactSecrets ?? []),
      ...auth.redactSecrets,
      this.options.workerToken,
      rawSecret,
    ];

    try {
      const subtasks = await this.options.service.listSubtasks(session.id);
      const prompt = buildEmbeddedOrchestratorPrompt(session, subtasks, this.options.controlApiUrl, input.prompt);
      const safeBaseEnv = processEnvironment(homeDir, provider === 'codex' ? true : 'claude');
      // Explicitly strip any AWS/Control-Plane secrets so embedded agent can ONLY talk via local HTTP collaboration API.
      const env: NodeJS.ProcessEnv = {
        ...safeBaseEnv,
        ...auth.env,
        HIVEMIND_CONTROL_API_URL: this.options.controlApiUrl,
        HIVEMIND_WORKER_TOKEN: this.options.workerToken,
        HIVEMIND_COLLAB_SESSION_ID: session.id,
      };
      for (const forbidden of [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
        'AWS_CONTAINER_CREDENTIALS_FULL_URI',
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'HIVEMIND_OPERATOR_TOKEN',
        'HIVEMIND_GITHUB_SECRET_ARN',
        'HIVEMIND_HF_RELEASE_SECRET_ARN',
        'HIVEMIND_DSQL_ENDPOINT',
      ]) {
        delete env[forbidden];
      }

      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 600_000, 10_000), 7_200_000);
      let outcome: { status: 'passed' | 'failed'; summary: string; error?: string };

      if (this.options.embeddedRunner) {
        outcome = await this.options.embeddedRunner.run({
          provider,
          prompt,
          model: input.model ?? auth.model,
          cwd: scratch,
          env,
          timeoutMs,
          signal,
        });
      } else {
        const model = input.model ?? auth.model;
        const cmd =
          provider === 'codex'
            ? [
                process.env.HIVEMIND_CODEX_BIN ?? 'codex',
                'exec',
                '--ignore-user-config',
                '--ephemeral',
                '--skip-git-repo-check',
                '--sandbox',
                'danger-full-access',
                '--cd',
                scratch,
                '--output-last-message',
                lastMessageFile,
                ...(model ? ['--model', model] : []),
                '-',
              ]
            : [
                process.env.HIVEMIND_CLAUDE_BIN ?? 'claude',
                '--print',
                '--permission-mode',
                'acceptEdits',
                '--no-session-persistence',
                '--disable-slash-commands',
                ...(model ? ['--model', model] : []),
              ];
        const res = await runProcess(cmd, {
          cwd: scratch,
          signal: signal ?? AbortSignal.timeout(timeoutMs),
          timeoutMs,
          input: prompt,
          env,
          maxOutputBytes: 256_000,
        });
        if (res.status !== 'passed') {
          const combined = [res.stderr, res.stdout].filter(Boolean).join('\n');
          outcome = {
            status: 'failed',
            summary: '',
            error: redactWorkerOutput(combined, allRedact).slice(-2000),
          };
        } else {
          let summary = res.stdout.trim();
          if (provider === 'codex') {
            const last = await readFile(lastMessageFile, 'utf8').catch(() => '');
            if (last.trim()) summary = last.trim();
          }
          outcome = {
            status: 'passed',
            summary: redactWorkerOutput(summary || 'Embedded orchestrator completed', allRedact).slice(0, 8000),
          };
        }
      }

      const finishedAt = new Date(this.now()).toISOString();
      const updated = await this.options.service.updateOrchestratorRun(session.id, {
        runId,
        provider,
        model: input.model ?? auth.model ?? null,
        status: outcome.status === 'passed' ? 'completed' : 'failed',
        startedAt,
        finishedAt,
        summary: outcome.status === 'passed' ? redactWorkerOutput(outcome.summary, allRedact) : null,
        error: outcome.status === 'failed' ? redactWorkerOutput(outcome.error ?? 'Embedded agent failed', allRedact) : null,
      });

      await this.options.service.postMessage(session.id, {
        sender: 'coordinator',
        recipient: null,
        kind: outcome.status === 'passed' ? 'decision' : 'blocker',
        body:
          outcome.status === 'passed'
            ? redactWorkerOutput(outcome.summary, allRedact)
            : `Embedded orchestrator failed: ${redactWorkerOutput(outcome.error ?? 'unknown error', allRedact)}`,
      });

      return updated;
    } finally {
      await auth.cleanup().catch(() => undefined);
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Fans out all DAG-ready subtasks onto parallel ECS Fargate Spot workers across the best available region(s),
   * bounded by `session.maxParallelWorkers`.
   */
  async fanOutReadySubtasks(
    sessionId: string,
    options?: { workloadClass?: string },
    signal?: AbortSignal,
  ): Promise<{ dispatched: CollabSubtask[]; skippedReason?: string }> {
    const session = await this.options.service.getSession(sessionId);
    const allSubtasks = await this.options.service.listSubtasks(sessionId);
    const runningCount = allSubtasks.filter((s) => s.status === 'running').length;
    const availableSlots = Math.max(0, session.maxParallelWorkers - runningCount);
    if (availableSlots === 0) {
      return { dispatched: [], skippedReason: `Parallel worker cap (${session.maxParallelWorkers}) already reached` };
    }

    const ready = await this.options.service.listReadySubtasks(sessionId);
    if (ready.length === 0) {
      return { dispatched: [], skippedReason: 'No DAG-ready subtasks available' };
    }

    const batch = ready.slice(0, availableSlots);
    const primaryRegion = session.allowedRegions[0] ?? 'ap-northeast-2';
    const snapshot = this.options.spotFeed ? await this.options.spotFeed.getSnapshot(signal).catch(() => null) : null;
    const placement = selectOptimalSpotPlacement(
      snapshot,
      {
        primaryRegion,
        allowedRegions: session.allowedRegions,
        workloadClass: options?.workloadClass ?? 'c.xlarge-arm',
      },
      this.now(),
    );

    const dispatched: CollabSubtask[] = [];
    for (const subtask of batch) {
      const agentId = `spot-agent-${subtask.id.slice(4, 12)}`;
      let ecsTaskArn: string | null = null;
      let targetRegion = placement.selectedRegion;

      if (this.options.workerLauncher) {
        const launched = await this.options.workerLauncher.launchCollabWorker(
          {
            sessionId: session.id,
            subtaskId: subtask.id,
            agentId,
            provider: subtask.provider,
            targetRegion: placement.selectedRegion,
            targetAzId: placement.selectedAzId,
          },
          signal,
        );
        ecsTaskArn = launched.taskArn;
        targetRegion = launched.region;
      }

      const claimed = await this.options.service.claimSubtask(session.id, subtask.id, {
        agentId,
        region: targetRegion,
        ecsTaskArn,
      });
      dispatched.push(claimed);

      await this.options.service.postMessage(session.id, {
        sender: 'coordinator',
        recipient: agentId,
        kind: 'handoff',
        body: `Dispatched subtask "${claimed.title}" (${claimed.id}) on Fargate Spot in ${targetRegion}`,
      });
    }

    return { dispatched };
  }
}
