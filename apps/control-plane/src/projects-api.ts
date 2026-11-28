import type { FastifyInstance } from 'fastify';
import type { ApprovalDecisionRecord } from '../../../packages/contracts/src/approval-policy.js';
import type {
  CreateProjectInput,
  IssueProjectTokenInput,
  UpdateProjectInput,
} from '../../../packages/contracts/src/projects.js';
import { approvalPolicyVersion } from '../../../packages/core/src/approval-policy.js';
import type { ComputeStore } from '../../../packages/core/src/compute.js';
import type { DeliveryStore } from '../../../packages/core/src/delivery.js';
import type { AgentCollabService } from '../../../packages/core/src/agent-collab.js';
import type { AutonomyTriggerStore } from '../../../packages/core/src/autonomy-trigger.js';
import {
  DEFAULT_PROJECT_ID,
  PROJECT_TEMPLATE_PRESETS,
  type ProjectStore,
} from '../../../packages/core/src/projects.js';
import { DomainError } from '../../../packages/core/src/store.js';
import { getPrincipal, requireOperator, requireOperatorOrAgent, type HostAuthContext } from './auth.js';

export interface ProjectsApiOptions {
  auth: HostAuthContext;
  store: ProjectStore;
  computeStore: ComputeStore;
  deliveryStore: DeliveryStore;
  collabService: AgentCollabService;
  autonomyStore: AutonomyTriggerStore;
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectsApiOptions): void {
  const { auth, store, computeStore, deliveryStore, collabService, autonomyStore } = options;
  const operatorOnly = requireOperator(auth);
  const operatorOrAgent = requireOperatorOrAgent(auth);

  app.get('/api/projects/templates', { onRequest: operatorOnly }, async () => ({
    templates: PROJECT_TEMPLATE_PRESETS,
  }));

  app.get('/api/projects', { onRequest: operatorOnly }, async () => ({
    storageBackend: store.storageBackend,
    projects: await store.list(),
    events: await store.events(undefined, 100),
  }));

  /** Allows a project-scoped agent token to inspect ONLY its own project manifest & remaining budget. */
  app.get('/api/projects/me', { onRequest: operatorOrAgent }, async (request) => {
    const principal = getPrincipal(request);
    if (!principal) throw new DomainError('Unauthorized', 401);
    if (principal.role === 'project_agent') {
      const project = await store.get(principal.projectId);
      const ledger = await computeStore.ledger({
        projectId: project.id,
        projectBudgetCaps: { [project.id]: project.budget.computeBudgetCapMicros },
      });
      return { project, ledger };
    }
    if (principal.role === 'legacy_agent') {
      return {
        project: principal.projectId ? await store.find(principal.projectId) : null,
        ledger: await computeStore.ledger(principal.projectId ? { projectId: principal.projectId } : undefined),
      };
    }
    return {
      role: 'operator',
      projects: await store.list(),
    };
  });

  app.post<{ Body: CreateProjectInput }>(
    '/api/projects',
    { onRequest: operatorOnly, bodyLimit: 65536 },
    async (request, reply) => {
      const created = await store.create(request.body);
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id', { onRequest: operatorOnly }, async (request) => {
    const project = await store.get(request.params.id);
    const [events, ledger, deliveryTasks, computeJobs, collabSessions, triggers] = await Promise.all([
      store.events(project.id, 100),
      computeStore.ledger({
        projectId: project.id,
        projectBudgetCaps: { [project.id]: project.budget.computeBudgetCapMicros },
      }),
      deliveryStore.list(project.id),
      computeStore.list(project.id),
      collabService.listSessions(),
      autonomyStore.list(),
    ]);
    return {
      project,
      events,
      ledger,
      counts: {
        deliveryTasks: deliveryTasks.length,
        computeJobs: computeJobs.length,
        collabSessions: collabSessions.filter((s) => (s.projectId ?? DEFAULT_PROJECT_ID) === project.id).length,
        autonomyTriggers: triggers.filter((t) => (t.projectId ?? DEFAULT_PROJECT_ID) === project.id).length,
      },
    };
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectInput }>(
    '/api/projects/:id',
    { onRequest: operatorOnly, bodyLimit: 65536 },
    async (request) => store.update(request.params.id, request.body),
  );

  app.post<{ Params: { id: string }; Body: IssueProjectTokenInput }>(
    '/api/projects/:id/tokens',
    { onRequest: operatorOnly, bodyLimit: 8192 },
    async (request, reply) => {
      const issued = await store.issueToken(request.params.id, request.body);
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(issued);
    },
  );

  app.delete<{ Params: { id: string; tokenId: string }; Body?: { reason?: string } }>(
    '/api/projects/:id/tokens/:tokenId',
    { onRequest: operatorOnly, bodyLimit: 4096 },
    async (request) =>
      store.revokeToken(request.params.id, request.params.tokenId, request.body?.reason ?? 'Revoked by operator'),
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/ledger', { onRequest: operatorOnly }, async (request) => {
    const project = await store.get(request.params.id);
    return computeStore.ledger({
      projectId: project.id,
      projectBudgetCaps: { [project.id]: project.budget.computeBudgetCapMicros },
    });
  });

  /** Returns the project's approval policy and chronological decision evidence across compute & delivery. */
  app.get<{ Params: { id: string }; Querystring: { outcome?: string; gate?: string; limit?: string } }>(
    '/api/projects/:id/approvals',
    { onRequest: operatorOnly },
    async (request) => {
      const project = await store.get(request.params.id);
      const [jobs, tasks] = await Promise.all([computeStore.list(project.id), deliveryStore.list(project.id)]);
      const decisions = collectApprovalDecisions(jobs, tasks, {
        projectId: project.id,
        outcome: request.query.outcome,
        gate: request.query.gate,
        limit: Number(request.query.limit ?? 100),
      });
      return {
        projectId: project.id,
        approvalPolicy: project.approvalPolicy,
        policyVersion: approvalPolicyVersion(project.approvalPolicy),
        decisions,
      };
    },
  );

  /** Host-wide chronological audit trail of all approval policy evaluations and operator decisions. */
  app.get<{ Querystring: { projectId?: string; outcome?: string; gate?: string; limit?: string } }>(
    '/api/approvals',
    { onRequest: operatorOnly },
    async (request) => {
      const projectId = request.query.projectId?.trim() || undefined;
      const [jobs, tasks] = await Promise.all([computeStore.list(projectId), deliveryStore.list(projectId)]);
      const decisions = collectApprovalDecisions(jobs, tasks, {
        projectId,
        outcome: request.query.outcome,
        gate: request.query.gate,
        limit: Number(request.query.limit ?? 150),
      });
      return { decisions };
    },
  );
}

export function collectApprovalDecisions(
  jobs: ReadonlyArray<{ approvalDecisions?: ApprovalDecisionRecord[] }>,
  tasks: ReadonlyArray<{ approvalDecisions?: ApprovalDecisionRecord[] }>,
  filter: { projectId?: string; outcome?: string; gate?: string; limit?: number } = {},
): ApprovalDecisionRecord[] {
  const all: ApprovalDecisionRecord[] = [];
  for (const job of jobs) {
    if (Array.isArray(job.approvalDecisions)) all.push(...job.approvalDecisions);
  }
  for (const task of tasks) {
    if (Array.isArray(task.approvalDecisions)) all.push(...task.approvalDecisions);
  }
  const filtered = all.filter((d) => {
    if (filter.projectId && d.projectId !== filter.projectId) return false;
    if (filter.outcome && d.outcome !== filter.outcome) return false;
    if (filter.gate && d.gate !== filter.gate) return false;
    return true;
  });
  filtered.sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));
  const max = Number.isFinite(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 500) : 150;
  return filtered.slice(0, max);
}
