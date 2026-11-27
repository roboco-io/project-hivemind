import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AutonomyTriggerStore } from '../../../packages/core/src/autonomy-trigger.js';
import { equalSecret } from '../../../packages/core/src/store.js';
import type { AutonomyDispatcher } from './autonomy-dispatcher.js';

/** Operator control of the periodic autonomy triggers (issue #20). The agent may only read them. */
export function registerAutonomyRoutes(app: FastifyInstance, options: { store: AutonomyTriggerStore; dispatcher?: AutonomyDispatcher; operatorToken: string; agentToken?: string }): void {
  const { store, dispatcher, operatorToken, agentToken } = options;
  const isOperator = (r: FastifyRequest) => equalSecret(r.headers.authorization ?? '', `Bearer ${operatorToken}`);
  const operatorOnly = async (r: FastifyRequest, reply: FastifyReply) => {
    if (!isOperator(r)) return reply.code(401).send({ error: 'Unauthorized' });
  };
  const operatorOrAgent = async (r: FastifyRequest, reply: FastifyReply) => {
    const agent = Boolean(agentToken) && equalSecret(r.headers.authorization ?? '', `Bearer ${agentToken}`);
    if (!isOperator(r) && !agent) return reply.code(401).send({ error: 'Unauthorized' });
  };

  app.get('/api/autonomy/triggers', { onRequest: operatorOrAgent }, async () => ({
    storageBackend: store.storageBackend,
    triggers: await store.list(),
    events: await store.events(50),
  }));
  app.put<{ Params: { id: string } }>('/api/autonomy/triggers/:id', { onRequest: operatorOnly, bodyLimit: 32768 }, async (request) =>
    store.configure(request.params.id, request.body),
  );
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/autonomy/triggers/:id/enable', { onRequest: operatorOnly, bodyLimit: 8192 }, async (request) =>
    store.setEnabled(request.params.id, true, String(request.body?.reason ?? '')),
  );
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/autonomy/triggers/:id/disable', { onRequest: operatorOnly, bodyLimit: 8192 }, async (request) =>
    store.setEnabled(request.params.id, false, String(request.body?.reason ?? '')),
  );
  // Runs the due triggers now instead of waiting for the timer.
  app.post('/api/autonomy/tick', { onRequest: operatorOnly, bodyLimit: 1024 }, async () =>
    dispatcher ? dispatcher.tick(AbortSignal.timeout(240_000)) : { dispatched: [], skipped: [], note: 'no dispatcher on this Control Plane' },
  );
}
