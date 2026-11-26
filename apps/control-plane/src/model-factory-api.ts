import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreateModelFactoryJob,
  ModelArtifactReceipt,
  ModelReleaseDecision,
  SubmitModelReleaseAttestation,
} from '../../../packages/contracts/src/model-factory.js';
import type { ModelFactoryStore } from '../../../packages/core/src/model-factory.js';
import { DomainError, equalSecret } from '../../../packages/core/src/store.js';
import type { ModelFactoryOrchestrator } from './model-factory-orchestrator.js';

export interface ModelFactoryApiOptions {
  store: ModelFactoryStore;
  operatorToken: string;
  workerToken?: string;
  orchestrator?: ModelFactoryOrchestrator;
}

export function registerModelFactoryRoutes(app: FastifyInstance, options: ModelFactoryApiOptions): void {
  const { store, operatorToken, workerToken, orchestrator } = options;

  const operatorOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!equalSecret(request.headers.authorization ?? '', `Bearer ${operatorToken}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  const workerOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!workerToken || !equalSecret(request.headers.authorization ?? '', `Bearer ${workerToken}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.get('/api/model-factory/jobs', { onRequest: operatorOnly }, async () => ({
    storageBackend: store.storageBackend,
    jobs: await store.list(),
    events: await store.events(),
  }));

  app.get('/api/model-factory/ledger', { onRequest: operatorOnly }, async () => store.ledger());

  app.get<{ Params: { id: string } }>('/api/model-factory/jobs/:id', { onRequest: operatorOnly }, async (request) => ({
    job: await store.get(request.params.id),
    events: await store.events(request.params.id),
  }));

  app.post<{ Body: CreateModelFactoryJob }>(
    '/api/model-factory/jobs',
    { onRequest: operatorOnly, bodyLimit: 131072 },
    async (request, reply) => reply.code(201).send(await store.create(request.body)),
  );

  app.post<{ Params: { id: string }; Body: { approvalFingerprint: string; reason: string } }>(
    '/api/model-factory/jobs/:id/approve-training',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => {
      if (orchestrator) {
        return orchestrator.approveAndLaunchTraining(
          request.params.id,
          request.body.approvalFingerprint,
          request.body.reason,
          AbortSignal.timeout(30_000),
        );
      }
      return store.approveTraining(request.params.id, request.body.approvalFingerprint, request.body.reason);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/model-factory/jobs/:id/wake',
    { onRequest: operatorOnly, bodyLimit: 8192 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Model factory EC2 wake orchestrator is unavailable in local mock mode', 503);
      }
      return orchestrator.wakeJob(request.params.id, AbortSignal.timeout(30_000));
    },
  );

  app.post<{ Params: { id: string }; Body: ModelArtifactReceipt }>(
    '/api/model-factory/jobs/:id/receipt',
    { onRequest: operatorOnly, bodyLimit: 131072 },
    async (request) => store.recordArtifactReceipt(request.params.id, request.body),
  );

  // Operator self-reported attestation: ALWAYS stamped with attestationSource='operator_self_reported' + explicit disclaimer.
  app.post<{ Params: { id: string }; Body: SubmitModelReleaseAttestation }>(
    '/api/model-factory/jobs/:id/verify-release',
    { onRequest: operatorOnly, bodyLimit: 32768 },
    async (request) => store.recordReleaseAttestation(request.params.id, request.body, 'operator_self_reported'),
  );

  // Starts the independent verifier task. Its report arrives on /verifier-attestation below.
  app.post<{ Params: { id: string } }>(
    '/api/model-factory/jobs/:id/dispatch-verifier',
    { onRequest: operatorOnly, bodyLimit: 1024 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Independent release verifier is unavailable in local mode', 503);
      }
      try {
        return await orchestrator.dispatchReleaseVerifier(request.params.id, AbortSignal.timeout(30_000));
      } catch (error) {
        if (error instanceof DomainError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new DomainError(message, /not configured/.test(message) ? 503 : 409);
      }
    },
  );

  // Independent verifier attestation: authenticated strictly with workerToken (never operatorToken).
  app.post<{ Params: { id: string }; Body: SubmitModelReleaseAttestation }>(
    '/api/model-factory/jobs/:id/verifier-attestation',
    { onRequest: workerOnly, bodyLimit: 32768 },
    async (request) => store.recordReleaseAttestation(request.params.id, request.body, 'independent_verifier'),
  );

  app.post<{ Params: { id: string }; Body: Omit<ModelReleaseDecision, 'decidedAt'> }>(
    '/api/model-factory/jobs/:id/approve-release',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => {
      if (orchestrator) {
        return orchestrator.approveAndPublishRelease(request.params.id, request.body, AbortSignal.timeout(60_000));
      }
      return store.recordReleaseDecision(request.params.id, request.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/model-factory/jobs/:id/cancel',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => {
      if (orchestrator) {
        return orchestrator.cancelJob(request.params.id, request.body.reason, AbortSignal.timeout(30_000));
      }
      return store.cancel(request.params.id, request.body.reason);
    },
  );

  app.post<{ Body: { region?: string } }>(
    '/api/model-factory/sweep-expired',
    { onRequest: operatorOnly, bodyLimit: 8192 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Model factory EC2 sweep orchestrator is unavailable in local mock mode', 503);
      }
      if (request.body?.region) {
        return orchestrator.sweepExpired(request.body.region, AbortSignal.timeout(30_000));
      }
      return orchestrator.wakeDueJobs(AbortSignal.timeout(60_000));
    },
  );
}
