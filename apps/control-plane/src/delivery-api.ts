import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreateDeliveryTask,
  DeliveryPreflightReport,
  DraftPrPublication,
  HumanDeliveryDecision,
  VerificationAttestation,
} from '../../../packages/contracts/src/delivery.js';
import { DeliveryStore } from '../../../packages/core/src/delivery.js';
import { DomainError, equalSecret } from '../../../packages/core/src/store.js';
import type { DeliveryOrchestrator } from './delivery-orchestrator.js';

export interface DeliveryApiOptions {
  store: DeliveryStore;
  operatorToken: string;
  workerToken: string;
  orchestrator?: DeliveryOrchestrator;
  /** Model Factory agent token: may read only the tasks an autonomy trigger sends (issue #20). */
  agentToken?: string;
  /** Repository and branch prefix of each autonomy trigger; a task matching one is readable by the agent. */
  agentReadableScopes?: () => Promise<Array<{ repository: string; branchPrefix: string }>>;
}

export function registerDeliveryRoutes(app: FastifyInstance, options: DeliveryApiOptions): void {
  const { store, operatorToken, workerToken, orchestrator, agentToken, agentReadableScopes } = options;

  const authorize = (role: 'operator' | 'worker') => async (request: FastifyRequest, reply: FastifyReply) => {
    const expected = role === 'operator' ? operatorToken : workerToken;
    if (!equalSecret(request.headers.authorization ?? '', `Bearer ${expected}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  const operatorOnly = authorize('operator');
  const workerOnly = authorize('worker');
  const isAgent = (request: FastifyRequest) =>
    Boolean(agentToken && agentReadableScopes) && equalSecret(request.headers.authorization ?? '', `Bearer ${agentToken}`);
  const operatorOrAgentRead = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAgent(request) && !equalSecret(request.headers.authorization ?? '', `Bearer ${operatorToken}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };
  /** The agent sees a task only when an autonomy trigger with the same repository and branch prefix exists. */
  const agentFilter = async () => {
    const scopes = await agentReadableScopes!();
    return (task: Awaited<ReturnType<DeliveryStore['get']>>) =>
      scopes.some((s) => s.repository === task.delivery.repository && s.branchPrefix === task.delivery.branchPrefix);
  };

  app.get('/api/delivery/tasks', { onRequest: operatorOrAgentRead }, async (request) => {
    const tasks = await store.list();
    const events = await store.events();
    if (!isAgent(request)) return { storageBackend: store.storageBackend, tasks, events };
    const readable = await agentFilter();
    const visible = tasks.filter(readable);
    const ids = new Set(visible.map((t) => t.id));
    return { storageBackend: store.storageBackend, tasks: visible, events: events.filter((e) => ids.has(e.taskId)) };
  });

  app.get<{
    Querystring: {
      workloadClass?: string;
      minPlacementScore?: string;
      maxHourlyPriceUsd?: string;
      trendWindowHours?: string;
    };
  }>('/api/delivery/spot-placement', { onRequest: operatorOnly }, async (request) => {
    if (!orchestrator) {
      throw new DomainError('AWS Spot placement advisor is unavailable in local mock mode', 503);
    }
    const { workloadClass, minPlacementScore, maxHourlyPriceUsd, trendWindowHours } = request.query;
    return orchestrator.evaluateSpotPlacement(
      {
        ...(workloadClass ? { workloadClass } : {}),
        ...(minPlacementScore !== undefined ? { minPlacementScore: Number(minPlacementScore) } : {}),
        ...(maxHourlyPriceUsd !== undefined ? { maxHourlyPriceUsd: Number(maxHourlyPriceUsd) } : {}),
        ...(trendWindowHours !== undefined ? { trendWindowHours: Number(trendWindowHours) } : {}),
      },
      AbortSignal.timeout(20_000),
    );
  });

  app.post('/api/delivery/reconcile', { onRequest: operatorOnly, bodyLimit: 1024 }, async () => {
    if (!orchestrator) {
      throw new DomainError('Delivery orchestrator is unavailable in local mock mode', 503);
    }
    return orchestrator.reconcileRunningTasks(AbortSignal.timeout(30_000));
  });

  app.get<{ Params: { id: string } }>('/api/delivery/tasks/:id', { onRequest: operatorOrAgentRead }, async (request) => {
    const task = await store.get(request.params.id);
    // Same answer as a missing task, so the agent cannot probe for other tasks.
    if (isAgent(request) && !(await agentFilter())(task)) throw new DomainError('Delivery task not found', 404);
    return { task, events: await store.events(request.params.id) };
  });

  app.post<{ Body: CreateDeliveryTask }>(
    '/api/delivery/tasks',
    { onRequest: operatorOnly, bodyLimit: 131072 },
    async (request, reply) => {
      const created = await store.create(request.body);
      if (orchestrator) {
        await orchestrator.uploadAcceptanceSpec(created, AbortSignal.timeout(30_000));
      }
      return reply.code(201).send(created);
    },
  );

  app.post<{ Params: { id: string }; Body: { approvalFingerprint: string; reason: string } }>(
    '/api/delivery/tasks/:id/approve',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => {
      const approved = await store.approve(request.params.id, request.body.approvalFingerprint, request.body.reason);
      if (orchestrator && approved.bundle?.s3Key) {
        const dispatched = await orchestrator.dispatchWorker(approved.id, AbortSignal.timeout(30_000));
        console.log(
          JSON.stringify({
            event: 'hivemind.delivery.worker_dispatched',
            taskId: approved.id,
            runId: dispatched.runId,
            iteration: dispatched.task.currentIteration,
            ecsTaskArn: dispatched.ecsTaskArn,
          }),
        );
        return dispatched.task;
      }
      return approved;
    },
  );

  app.post<{ Params: { id: string }; Body: DraftPrPublication }>(
    '/api/delivery/tasks/:id/publish-draft-pr',
    { onRequest: operatorOnly, bodyLimit: 32768 },
    async (request) => await store.recordDraftPrPublication(request.params.id, request.body),
  );

  app.post<{ Params: { id: string }; Body: Omit<HumanDeliveryDecision, 'decidedAt'> }>(
    '/api/delivery/tasks/:id/human-decision',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => await store.recordHumanDecision(request.params.id, request.body),
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/delivery/tasks/:id/cancel',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => {
      // With an orchestrator, cancelling also stops the ECS task that executes the run.
      if (!orchestrator) return store.cancel(request.params.id, request.body.reason);
      const cancelled = await orchestrator.cancelTask(request.params.id, request.body.reason);
      return { ...cancelled.task, stoppedEcsTask: cancelled.stoppedEcsTask, stopError: cancelled.stopError };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { runId?: string } }>(
    '/api/delivery/tasks/:id/worker-spec',
    { onRequest: workerOnly },
    async (request) => {
      const task = await store.get(request.params.id);
      const runId = request.query.runId?.trim();
      if (!runId || task.status !== 'running' || task.activeRunId !== runId) {
        throw new DomainError('Active run mismatch for worker spec', 409);
      }
      return {
        taskId: task.id,
        runId,
        iteration: task.currentIteration,
        maxIterations: task.maxIterations,
        provider: task.provider,
        title: task.title,
        instructions: task.instructions,
        baseCommit: task.acceptance.baseCommit,
        acceptancePaths: task.acceptance.files.map((file) => file.path),
        testCommand: task.acceptance.testCommand,
        executionPolicy: task.executionPolicy,
        priorVerificationSummary:
          task.latestAttestation && !task.latestAttestation.checksPassed
            ? task.latestAttestation.summary
            : null,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: Omit<DeliveryPreflightReport, 'checkedAt'> }>(
    '/api/delivery/tasks/:id/preflight',
    { onRequest: workerOnly, bodyLimit: 16384 },
    async (request) => await store.recordPreflight(request.params.id, request.body),
  );

  app.post<{ Params: { id: string }; Body: { workerId: string; runId: string } }>(
    '/api/delivery/tasks/:id/start',
    { onRequest: workerOnly, bodyLimit: 16384 },
    async (request) => await store.startIteration(request.params.id, request.body.workerId, request.body.runId),
  );

  app.post<{
    Params: { id: string };
    Body: { runId: string; patchS3Key: string; patchSha256: string; summary?: string; checkpointS3Key?: string };
  }>(
    '/api/delivery/tasks/:id/worker-completed',
    { onRequest: workerOnly, bodyLimit: 32768 },
    async (request) => {
      const task = await store.get(request.params.id);
      if (task.status !== 'running' || task.activeRunId !== request.body.runId) {
        throw new DomainError('Active run mismatch for worker completion', 409);
      }
      if (request.body.summary?.trim() || request.body.checkpointS3Key?.trim()) {
        await store.recordWorkerSummary(
          task.id,
          request.body.runId,
          request.body.summary?.trim() || 'Worker execution completed',
          request.body.checkpointS3Key,
        );
      }
      if (!orchestrator) {
        return { ok: true, task: await store.get(task.id) };
      }
      const dispatched = await orchestrator.recordWorkerCompletion(
        task.id,
        request.body.runId,
        request.body.patchS3Key,
        request.body.patchSha256,
        AbortSignal.timeout(30_000),
      );
      console.log(
        JSON.stringify({
          event: 'hivemind.delivery.verifier_dispatched',
          taskId: task.id,
          runId: request.body.runId,
          iteration: task.currentIteration,
          ecsTaskArn: dispatched.ecsTaskArn,
        }),
      );
      return { ok: true, verifierTaskArn: dispatched.ecsTaskArn };
    },
  );

  app.post<{ Params: { id: string }; Body: { runId: string; checkpointRef: string; reason: string } }>(
    '/api/delivery/tasks/:id/spot-interrupted',
    { onRequest: workerOnly, bodyLimit: 16384 },
    async (request) => {
      if (orchestrator) {
        const result = await orchestrator.handleSpotInterruption(
          request.params.id,
          request.body.runId,
          request.body.checkpointRef,
          request.body.reason,
          AbortSignal.timeout(30_000),
        );
        console.log(
          JSON.stringify({
            event: 'hivemind.delivery.spot_handled',
            taskId: request.params.id,
            status: result.task.status,
            redispatchedTaskArn: result.redispatched?.ecsTaskArn ?? null,
          }),
        );
        return result.task;
      }
      return await store.recordSpotInterruption(
        request.params.id,
        request.body.runId,
        request.body.checkpointRef,
        request.body.reason,
      );
    },
  );

  app.post<{ Params: { id: string }; Body: VerificationAttestation }>(
    '/api/delivery/tasks/:id/verify',
    { onRequest: workerOnly, bodyLimit: 65536 },
    async (request) => {
      if (orchestrator) {
        const task = await store.get(request.params.id);
        if (!task.activeRunId || request.body.runId !== task.activeRunId) {
          throw new DomainError('Verification must match the active running iteration', 409);
        }
        const patchS3Key = `patches/${task.id}/${task.activeRunId}.patch`;
        const result = await orchestrator.handleVerification(
          task.id,
          request.body,
          patchS3Key,
          AbortSignal.timeout(90_000),
        );
        console.log(
          JSON.stringify({
            event: 'hivemind.delivery.verification_handled',
            taskId: request.params.id,
            status: result.task.status,
            prUrl: result.publication?.prUrl ?? null,
            retriedTaskArn: result.retried?.ecsTaskArn ?? null,
          }),
        );
        return result.task;
      }
      return await store.recordVerification(request.params.id, request.body);
    },
  );
}
