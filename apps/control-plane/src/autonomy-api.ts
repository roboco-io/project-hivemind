import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AutonomyTriggerStore } from '../../../packages/core/src/autonomy-trigger.js';
import {
  assertProjectCapability,
  assertProjectRepository,
  DEFAULT_PROJECT_ID,
  type ProjectStore,
} from '../../../packages/core/src/projects.js';
import { equalSecret } from '../../../packages/core/src/store.js';
import { authenticateRequest, getPrincipal, type HostAuthContext } from './auth.js';
import type { AutonomyDispatcher } from './autonomy-dispatcher.js';

/** Operator control of periodic autonomy triggers. Project agents may only read their own project's triggers. */
export function registerAutonomyRoutes(
  app: FastifyInstance,
  options: { store: AutonomyTriggerStore; projects?: ProjectStore; auth?: HostAuthContext; dispatcher?: AutonomyDispatcher; operatorToken: string; agentToken?: string },
): void {
  const { store, projects, auth, dispatcher, operatorToken, agentToken } = options;
  const isOperator = (r: FastifyRequest) => equalSecret(r.headers.authorization ?? '', `Bearer ${operatorToken}`);
  const operatorOnly = async (r: FastifyRequest, reply: FastifyReply) => {
    if (!isOperator(r)) return reply.code(401).send({ error: 'Unauthorized' });
  };
  const operatorOrAgent = async (r: FastifyRequest, reply: FastifyReply) => {
    if (auth) {
      const p = await authenticateRequest(r, auth);
      if (p?.role === 'operator' || p?.role === 'legacy_agent') return;
      if (p?.role === 'project_agent') {
        if (!p.scopes.has('autonomy:read')) return reply.code(403).send({ error: "Project token lacks required scope 'autonomy:read'" });
        return;
      }
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const agent = Boolean(agentToken) && equalSecret(r.headers.authorization ?? '', `Bearer ${agentToken}`);
    if (!isOperator(r) && !agent) return reply.code(401).send({ error: 'Unauthorized' });
  };

  app.get<{ Querystring: { projectId?: string } }>('/api/autonomy/triggers', { onRequest: operatorOrAgent }, async (request) => {
    const principal = getPrincipal(request);
    const filterProject =
      principal?.role === 'project_agent'
        ? principal.projectId
        : request.query.projectId?.trim() || undefined;
    const allTriggers = await store.list();
    const triggers = filterProject
      ? allTriggers.filter((t) => (t.projectId ?? DEFAULT_PROJECT_ID) === filterProject)
      : allTriggers;
    const ids = new Set(triggers.map((t) => t.id));
    const events = (await store.events(50)).filter((e) => !filterProject || ids.has(e.triggerId));
    return {
      storageBackend: store.storageBackend,
      triggers,
      events,
    };
  });
  app.put<{ Params: { id: string } }>('/api/autonomy/triggers/:id', { onRequest: operatorOnly, bodyLimit: 32768 }, async (request) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (projects && typeof body?.projectId === 'string' && body.projectId !== DEFAULT_PROJECT_ID) {
      const project = await projects.get(body.projectId);
      assertProjectCapability(project, 'autonomy_triggers');
      if (typeof body.repository === 'string') {
        assertProjectRepository(project, body.repository);
      }
    }
    return store.configure(request.params.id, request.body);
  });
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/autonomy/triggers/:id/enable', { onRequest: operatorOnly, bodyLimit: 8192 }, async (request) =>
    store.setEnabled(request.params.id, true, String(request.body?.reason ?? '')),
  );
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/autonomy/triggers/:id/disable', { onRequest: operatorOnly, bodyLimit: 8192 }, async (request) =>
    store.setEnabled(request.params.id, false, String(request.body?.reason ?? '')),
  );
  app.post('/api/autonomy/tick', { onRequest: operatorOnly, bodyLimit: 1024 }, async () =>
    dispatcher ? dispatcher.tick(AbortSignal.timeout(240_000)) : { dispatched: [], skipped: [], note: 'no dispatcher on this Control Plane' },
  );
}
