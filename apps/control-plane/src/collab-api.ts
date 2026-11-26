import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AppendCollabWorkLog,
  CollabProvider,
  CreateCollabSession,
  CreateCollabSubtask,
  PostCollabMessage,
} from '../../../packages/contracts/src/agent-collab.js';
import type { AgentCollabService } from '../../../packages/core/src/agent-collab.js';
import { DomainError, equalSecret } from '../../../packages/core/src/store.js';
import type { CollabOrchestrator } from './collab-orchestrator.js';

export interface CollabApiOptions {
  service: AgentCollabService;
  operatorToken: string;
  workerToken: string;
  orchestrator?: CollabOrchestrator;
}

export function registerCollabRoutes(app: FastifyInstance, options: CollabApiOptions): void {
  const { service, operatorToken, workerToken, orchestrator } = options;

  const operatorOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!equalSecret(request.headers.authorization ?? '', `Bearer ${operatorToken}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  const operatorOrWorker = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization ?? '';
    if (!equalSecret(auth, `Bearer ${operatorToken}`) && !equalSecret(auth, `Bearer ${workerToken}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.get('/api/collab/sessions', { onRequest: operatorOnly }, async () => ({
    storageBackend: service.storageBackend,
    sessions: await service.listSessions(),
  }));

  app.post<{ Body: CreateCollabSession }>(
    '/api/collab/sessions',
    { onRequest: operatorOnly, bodyLimit: 65536 },
    async (request, reply) => reply.code(201).send(await service.createSession(request.body)),
  );

  app.get<{ Params: { id: string } }>(
    '/api/collab/sessions/:id',
    { onRequest: operatorOrWorker },
    async (request) => service.getSnapshot(request.params.id),
  );

  app.post<{ Params: { id: string }; Body: { status: 'completed' | 'failed' | 'cancelled' } }>(
    '/api/collab/sessions/:id/complete',
    { onRequest: operatorOnly, bodyLimit: 8192 },
    async (request) => {
      // With an orchestrator, ending as failed/cancelled also stops the workers of running subtasks.
      if (!orchestrator) return service.completeSession(request.params.id, request.body.status);
      const ended = await orchestrator.endSession(request.params.id, request.body.status, AbortSignal.timeout(30_000));
      return { ...ended.session, stoppedWorkers: ended.stoppedWorkers, stopErrors: ended.stopErrors };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/collab/sessions/:id/reconcile',
    { onRequest: operatorOnly, bodyLimit: 1024 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Collab orchestrator is not configured', 503);
      }
      return orchestrator.reconcileRunningSubtasks(request.params.id, AbortSignal.timeout(30_000));
    },
  );

  app.post<{
    Params: { id: string };
    Body: { provider?: CollabProvider; model?: string; prompt?: string; localAuthSecret: string; timeoutMs?: number };
  }>(
    '/api/collab/sessions/:id/run-orchestrator',
    { onRequest: operatorOnly, bodyLimit: 65536 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Embedded Control Plane orchestrator is not configured', 503);
      }
      return orchestrator.runEmbeddedOrchestrator(
        {
          sessionId: request.params.id,
          provider: request.body.provider,
          model: request.body.model,
          prompt: request.body.prompt,
          localAuthSecret: request.body.localAuthSecret,
          timeoutMs: request.body.timeoutMs,
        },
        AbortSignal.timeout(Math.min(request.body.timeoutMs ?? 600_000, 7_200_000)),
      );
    },
  );

  app.post<{ Params: { id: string }; Body: CreateCollabSubtask }>(
    '/api/collab/sessions/:id/subtasks',
    { onRequest: operatorOrWorker, bodyLimit: 65536 },
    async (request, reply) => reply.code(201).send(await service.createSubtask(request.params.id, request.body)),
  );

  app.get<{ Params: { id: string } }>(
    '/api/collab/sessions/:id/subtasks',
    { onRequest: operatorOrWorker },
    async (request) => ({ subtasks: await service.listSubtasks(request.params.id) }),
  );

  app.post<{ Params: { id: string }; Body?: { workloadClass?: string } }>(
    '/api/collab/sessions/:id/fan-out',
    { onRequest: operatorOrWorker, bodyLimit: 8192 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Parallel ECS fan-out orchestrator is not configured', 503);
      }
      return orchestrator.fanOutReadySubtasks(request.params.id, request.body, AbortSignal.timeout(30_000));
    },
  );

  app.post<{
    Params: { id: string; subtaskId: string };
    Body: { agentId: string; region?: string; ecsTaskArn?: string };
  }>(
    '/api/collab/sessions/:id/subtasks/:subtaskId/claim',
    { onRequest: operatorOrWorker, bodyLimit: 8192 },
    async (request) =>
      service.claimSubtask(request.params.id, request.params.subtaskId, {
        agentId: request.body.agentId,
        region: request.body.region,
        ecsTaskArn: request.body.ecsTaskArn,
      }),
  );

  app.post<{
    Params: { id: string; subtaskId: string };
    Body: { agentId: string; status: 'completed' | 'failed'; summary?: string; failureReason?: string };
  }>(
    '/api/collab/sessions/:id/subtasks/:subtaskId/finish',
    { onRequest: operatorOrWorker, bodyLimit: 32768 },
    async (request) => service.finishSubtask(request.params.id, request.params.subtaskId, request.body),
  );

  app.get<{
    Params: { id: string };
    Querystring: { afterSeq?: string; recipient?: string; threadId?: string; limit?: string };
  }>(
    '/api/collab/sessions/:id/messages',
    { onRequest: operatorOrWorker },
    async (request) => ({
      messages: await service.listMessages(request.params.id, {
        ...(request.query.afterSeq !== undefined ? { afterSeq: Number(request.query.afterSeq) } : {}),
        ...(request.query.recipient ? { recipient: request.query.recipient } : {}),
        ...(request.query.threadId ? { threadId: request.query.threadId } : {}),
        ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
      }),
    }),
  );

  app.post<{ Params: { id: string }; Body: PostCollabMessage }>(
    '/api/collab/sessions/:id/messages',
    { onRequest: operatorOrWorker, bodyLimit: 32768 },
    async (request, reply) => reply.code(201).send(await service.postMessage(request.params.id, request.body)),
  );

  app.get<{ Params: { id: string }; Querystring: { subtaskId?: string } }>(
    '/api/collab/sessions/:id/work-logs',
    { onRequest: operatorOrWorker },
    async (request) => ({
      workLogs: await service.listWorkLogs(request.params.id, request.query.subtaskId),
    }),
  );

  app.post<{ Params: { id: string }; Body: AppendCollabWorkLog }>(
    '/api/collab/sessions/:id/work-logs',
    { onRequest: operatorOrWorker, bodyLimit: 32768 },
    async (request, reply) => reply.code(201).send(await service.appendWorkLog(request.params.id, request.body)),
  );
}
