import type { FastifyInstance } from 'fastify';
import type {
  ComputeArtifactReceipt,
  ComputeReleaseDecision,
  CreateComputeJob,
  SubmitComputeReleaseAttestation,
} from '../../../packages/contracts/src/compute.js';
import type { ComputeStore } from '../../../packages/core/src/compute.js';
import {
  assertProjectCapability,
  assertProjectComputePrefix,
  assertProjectRegions,
  assertProjectRepository,
  DEFAULT_PROJECT_ID,
  type ProjectStore,
} from '../../../packages/core/src/projects.js';
import { DomainError } from '../../../packages/core/src/store.js';
import {
  getPrincipal,
  requireOperator,
  requireOperatorOrAgent,
  requireWorker,
  type HostAuthContext,
} from './auth.js';
import type { ComputeOrchestrator } from './compute-orchestrator.js';

export interface ComputeApiOptions {
  auth: HostAuthContext;
  store: ComputeStore;
  projects: ProjectStore;
  orchestrator?: ComputeOrchestrator;
}

export function registerComputeRoutes(app: FastifyInstance, options: ComputeApiOptions): void {
  const { auth, store, projects, orchestrator } = options;

  const operatorOnly = requireOperator(auth);
  const workerOnly = requireWorker(auth);
  const canReadCompute = requireOperatorOrAgent(auth, 'compute:read');
  const canWriteCompute = requireOperatorOrAgent(auth, 'compute:write');

  const resolveProjectBudgetCaps = async (): Promise<Record<string, number>> => {
    const all = await projects.list();
    return Object.fromEntries(all.map((p) => [p.id, p.budget.computeBudgetCapMicros]));
  };

  const assertJobVisibleToPrincipal = async (jobId: string, request: Parameters<typeof getPrincipal>[0]) => {
    const principal = getPrincipal(request);
    const job = await store.get(jobId);
    if (principal?.role === 'project_agent' && job.projectId !== principal.projectId) {
      // Same 404 as a missing job so another project cannot probe job IDs.
      throw new DomainError('Compute job not found', 404);
    }
    return job;
  };

  app.get<{ Querystring: { projectId?: string } }>(
    '/api/compute/jobs',
    { onRequest: canReadCompute },
    async (request) => {
      const principal = getPrincipal(request);
      const effectiveProjectId =
        principal?.role === 'project_agent'
          ? principal.projectId
          : request.query.projectId?.trim() || undefined;
      const [jobs, allEvents] = await Promise.all([
        store.list(effectiveProjectId),
        store.events(undefined, effectiveProjectId),
      ]);
      const jobIds = new Set(jobs.map((j) => j.id));
      const events = effectiveProjectId ? allEvents.filter((e) => jobIds.has(e.jobId)) : allEvents;
      return {
        storageBackend: store.storageBackend,
        jobs,
        events,
      };
    },
  );

  app.get<{ Querystring: { projectId?: string } }>(
    '/api/compute/ledger',
    { onRequest: canReadCompute },
    async (request) => {
      const principal = getPrincipal(request);
      const effectiveProjectId =
        principal?.role === 'project_agent'
          ? principal.projectId
          : request.query.projectId?.trim() || undefined;
      const projectBudgetCaps = await resolveProjectBudgetCaps();
      return store.ledger({
        ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
        projectBudgetCaps,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/compute/jobs/:id',
    { onRequest: canReadCompute },
    async (request) => {
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      return {
        job,
        events: await store.events(job.id),
      };
    },
  );

  app.post<{ Body: CreateComputeJob }>(
    '/api/compute/jobs',
    { onRequest: canWriteCompute, bodyLimit: 131072 },
    async (request, reply) => {
      const principal = getPrincipal(request);
      const body = request.body;
      let targetProjectId = body.projectId;
      if (principal?.role === 'project_agent') {
        if (targetProjectId && targetProjectId !== principal.projectId) {
          throw new DomainError(`Project token for '${principal.projectId}' cannot register jobs under '${targetProjectId}'`, 403);
        }
        targetProjectId = principal.projectId;
      }

      let policyContext: Parameters<ComputeStore['create']>[1] = {};
      if (targetProjectId && targetProjectId !== DEFAULT_PROJECT_ID) {
        const project = await projects.get(targetProjectId);
        assertProjectCapability(project, 'compute');
        if (body.releasePolicy?.mode === 'hf_release') {
          assertProjectCapability(project, 'hf_release');
        }
        assertProjectRepository(project, body.repository);
        assertProjectComputePrefix(project, body.compute.s3ArtifactPrefix);
        if (body.compute.inputs?.s3Prefix) {
          assertProjectComputePrefix(project, body.compute.inputs.s3Prefix);
        }
        const requestedRegions = [body.compute.region, ...(body.compute.candidateRegions ?? [])];
        assertProjectRegions(project, requestedRegions);
        policyContext = {
          allowedS3Prefixes: project.compute.s3ArtifactPrefixes,
          autoPublishRepoPrefixes: project.compute.autoPublishHfRepoPrefixes,
          maxLifetimeMs: project.compute.maxLifetimeMs,
          maxSingleJobCostMicros: project.budget.maxSingleJobCostMicros,
        };
      }

      const created = await store.create(
        { ...body, ...(targetProjectId ? { projectId: targetProjectId } : {}) },
        policyContext,
      );
      const job = orchestrator ? await orchestrator.planAtRegistration(created, AbortSignal.timeout(20_000)) : created;
      return reply.code(201).send(job);
    },
  );

  app.post<{ Params: { id: string }; Body: { approvalFingerprint: string; reason: string } }>(
    '/api/compute/jobs/:id/approve',
    { onRequest: canWriteCompute, bodyLimit: 16384 },
    async (request) => {
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      let budgetContext: { projectBudgetCapMicros?: number; maxSingleJobCostMicros?: number | null } = {};
      if (job.projectId !== DEFAULT_PROJECT_ID) {
        const project = await projects.get(job.projectId);
        assertProjectCapability(project, 'compute');
        budgetContext = {
          projectBudgetCapMicros: project.budget.computeBudgetCapMicros,
          maxSingleJobCostMicros: project.budget.maxSingleJobCostMicros,
        };
      }
      if (orchestrator) {
        return orchestrator.approveAndLaunch(
          job.id,
          request.body.approvalFingerprint,
          request.body.reason,
          AbortSignal.timeout(30_000),
          budgetContext,
        );
      }
      return store.approveLaunch(job.id, request.body.approvalFingerprint, request.body.reason, budgetContext);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/compute/jobs/:id/wake',
    { onRequest: canWriteCompute, bodyLimit: 8192 },
    async (request) => {
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      if (!orchestrator) {
        throw new DomainError('Compute EC2 wake orchestrator is unavailable in local mock mode', 503);
      }
      return orchestrator.wakeJob(job.id, AbortSignal.timeout(30_000));
    },
  );

  app.post<{ Params: { id: string }; Body: ComputeArtifactReceipt }>(
    '/api/compute/jobs/:id/receipt',
    { onRequest: operatorOnly, bodyLimit: 131072 },
    async (request) => store.recordArtifactReceipt(request.params.id, request.body),
  );

  app.post<{ Params: { id: string }; Body: SubmitComputeReleaseAttestation }>(
    '/api/compute/jobs/:id/verify-release',
    { onRequest: operatorOnly, bodyLimit: 32768 },
    async (request) => store.recordReleaseAttestation(request.params.id, request.body, 'operator_self_reported'),
  );

  app.post<{ Params: { id: string } }>(
    '/api/compute/jobs/:id/dispatch-verifier',
    { onRequest: canWriteCompute, bodyLimit: 1024 },
    async (request) => {
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      if (!orchestrator) {
        throw new DomainError('Independent release verifier is unavailable in local mode', 503);
      }
      try {
        return await orchestrator.dispatchReleaseVerifier(job.id, AbortSignal.timeout(30_000));
      } catch (error) {
        if (error instanceof DomainError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new DomainError(message, /not configured/.test(message) ? 503 : 409);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: SubmitComputeReleaseAttestation }>(
    '/api/compute/jobs/:id/verifier-attestation',
    { onRequest: workerOnly, bodyLimit: 32768 },
    async (request) => {
      const job = await store.recordReleaseAttestation(request.params.id, request.body, 'independent_verifier');
      const projectPrefixes =
        job.projectId !== DEFAULT_PROJECT_ID ? await projects.autoPublishPrefixesFor(job.projectId) : undefined;
      if (orchestrator && store.isAutoPublishEligible(job, projectPrefixes)) {
        void orchestrator.autoReleaseIfEligible(job.id, AbortSignal.timeout(60_000)).catch((error) => {
          console.error(JSON.stringify({ event: 'hivemind.compute_auto_publish.error', jobId: job.id, message: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
        });
      }
      return job;
    },
  );

  app.post<{ Params: { id: string }; Body: Omit<ComputeReleaseDecision, 'decidedAt'> }>(
    '/api/compute/jobs/:id/approve-release',
    { onRequest: operatorOnly, bodyLimit: 16384 },
    async (request) => {
      if (orchestrator) {
        return orchestrator.approveAndStartPublishRelease(request.params.id, request.body);
      }
      return store.recordReleaseDecision(request.params.id, request.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/compute/jobs/:id/publish-release',
    { onRequest: operatorOnly, bodyLimit: 1024 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Release publication is unavailable in local mode', 503);
      }
      return orchestrator.startPublishRelease(request.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/compute/jobs/:id/cancel',
    { onRequest: canWriteCompute, bodyLimit: 16384 },
    async (request) => {
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      if (orchestrator) {
        return orchestrator.cancelJob(job.id, request.body.reason, AbortSignal.timeout(30_000));
      }
      return store.cancel(job.id, request.body.reason);
    },
  );

  app.post<{ Body: { region: string } }>(
    '/api/compute/sweep-expired',
    { onRequest: operatorOnly, bodyLimit: 4096 },
    async (request) => {
      if (!orchestrator) {
        throw new DomainError('Compute TTL Guard sweep is unavailable in local mock mode', 503);
      }
      const region = String(request.body?.region ?? '').trim().toLowerCase();
      if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) {
        throw new DomainError('Valid AWS region is required for sweep-expired', 400);
      }
      return orchestrator.sweepExpired(region, AbortSignal.timeout(30_000));
    },
  );
}
