import type { FastifyInstance } from 'fastify';
import type { RequestApprovalInput } from '../../../packages/contracts/src/approval-policy.js';
import type {
  ComputeArtifactReceipt,
  ComputeReleaseDecision,
  CreateComputeJob,
  SubmitComputeReleaseAttestation,
} from '../../../packages/contracts/src/compute.js';
import {
  evaluateComputeLaunchApproval,
  evaluateComputeReleaseApproval,
  makeOperatorDecisionRecord,
} from '../../../packages/core/src/approval-policy.js';
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

  app.post<{ Params: { id: string }; Body: RequestApprovalInput }>(
    '/api/compute/jobs/:id/request-approval',
    { onRequest: canWriteCompute, bodyLimit: 16384 },
    async (request, reply) => {
      const principal = getPrincipal(request);
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      const project = job.projectId !== DEFAULT_PROJECT_ID ? await projects.get(job.projectId) : null;
      if (project) assertProjectCapability(project, 'compute');

      const ledger = await store.ledger(
        project
          ? { projectId: project.id, projectBudgetCaps: { [project.id]: project.budget.computeBudgetCapMicros } }
          : undefined,
      );
      const actorKind = principal?.role === 'operator' ? 'operator' : 'agent';
      const actorId =
        principal?.role === 'project_agent'
          ? `agent:${principal.tokenId}`
          : principal?.role === 'legacy_agent'
            ? 'agent:legacy'
            : 'operator';

      const decision = evaluateComputeLaunchApproval({
        project,
        job,
        approvalFingerprint: String(request.body?.approvalFingerprint ?? ''),
        actorKind,
        actorId,
        agentAssessment: {
          ...(request.body?.recommendedOutcome ? { recommendedOutcome: request.body.recommendedOutcome } : {}),
          ...(request.body?.rationale ? { rationale: request.body.rationale } : {}),
        },
        remainingProjectBudgetMicros: ledger.remainingBudgetMicros,
        nowIso: new Date().toISOString(),
      });

      let updatedJob = await store.recordApprovalDecision(job.id, decision);
      if (decision.outcome === 'auto_approved') {
        const budgetContext = project
          ? {
              projectBudgetCapMicros: project.budget.computeBudgetCapMicros,
              maxSingleJobCostMicros: project.budget.maxSingleJobCostMicros,
            }
          : {};
        const reason = request.body?.rationale?.trim()
          ? `[자동 승인 · 정책 ${decision.policyVersion}] ${request.body.rationale.trim()}`
          : `[자동 승인 · 정책 ${decision.policyVersion}] ${decision.summary}`;
        updatedJob = orchestrator
          ? await orchestrator.approveAndLaunch(
              job.id,
              request.body.approvalFingerprint,
              reason,
              AbortSignal.timeout(30_000),
              budgetContext,
            )
          : await store.approveLaunch(job.id, request.body.approvalFingerprint, reason, budgetContext);
        return reply.code(200).send({ decision, executed: true, job: updatedJob });
      }
      if (decision.outcome === 'manual_approval_required') {
        return reply.code(202).send({ decision, executed: false, job: updatedJob });
      }
      return reply.code(403).send({ error: decision.summary, decision, executed: false, job: updatedJob });
    },
  );

  app.post<{ Params: { id: string }; Body: { approvalFingerprint: string; reason: string } }>(
    '/api/compute/jobs/:id/approve',
    { onRequest: canWriteCompute, bodyLimit: 16384 },
    async (request, reply) => {
      const principal = getPrincipal(request);
      const job = await assertJobVisibleToPrincipal(request.params.id, request);
      const project = job.projectId !== DEFAULT_PROJECT_ID ? await projects.get(job.projectId) : null;
      let budgetContext: { projectBudgetCapMicros?: number; maxSingleJobCostMicros?: number | null } = {};
      if (project) {
        assertProjectCapability(project, 'compute');
        budgetContext = {
          projectBudgetCapMicros: project.budget.computeBudgetCapMicros,
          maxSingleJobCostMicros: project.budget.maxSingleJobCostMicros,
        };
      }

      // Project agents cannot bypass a project's approval policy by calling /approve directly.
      if (principal?.role === 'project_agent') {
        const ledger = await store.ledger(
          project
            ? { projectId: project.id, projectBudgetCaps: { [project.id]: project.budget.computeBudgetCapMicros } }
            : undefined,
        );
        const decision = evaluateComputeLaunchApproval({
          project,
          job,
          approvalFingerprint: String(request.body?.approvalFingerprint ?? ''),
          actorKind: 'agent',
          actorId: `agent:${principal.tokenId}`,
          agentAssessment: { recommendedOutcome: 'auto_approved', rationale: request.body?.reason },
          remainingProjectBudgetMicros: ledger.remainingBudgetMicros,
          nowIso: new Date().toISOString(),
        });
        await store.recordApprovalDecision(job.id, decision);
        if (decision.outcome !== 'auto_approved') {
          return reply.code(403).send({ error: decision.summary, decision });
        }
      } else {
        const decision = makeOperatorDecisionRecord({
          project,
          gate: 'compute_launch',
          targetKind: 'compute_job',
          targetId: job.id,
          targetTitle: job.title,
          projectId: job.projectId,
          approvalFingerprint: job.approvalFingerprint,
          approved: true,
          reason: request.body.reason,
          nowIso: new Date().toISOString(),
        });
        await store.recordApprovalDecision(job.id, decision);
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
      let job = await store.recordReleaseAttestation(request.params.id, request.body, 'independent_verifier');
      const project = job.projectId !== DEFAULT_PROJECT_ID ? await projects.find(job.projectId) : null;
      const projectPrefixes = project ? project.compute.autoPublishHfRepoPrefixes : undefined;
      const autoPublishEligible = store.isAutoPublishEligible(job, projectPrefixes);
      const releaseDecision = evaluateComputeReleaseApproval({
        project,
        job,
        actorKind: 'system_policy',
        actorId: 'system:release_verifier',
        autoPublishEligible,
        nowIso: new Date().toISOString(),
      });
      job = await store.recordApprovalDecision(job.id, releaseDecision);
      const policyAllowsAutoPublish = project ? releaseDecision.outcome === 'auto_approved' : autoPublishEligible;
      if (orchestrator && autoPublishEligible && policyAllowsAutoPublish) {
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
      const current = await store.get(request.params.id);
      const project = current.projectId !== DEFAULT_PROJECT_ID ? await projects.find(current.projectId) : null;
      const result = orchestrator
        ? await orchestrator.approveAndStartPublishRelease(request.params.id, request.body)
        : await store.recordReleaseDecision(request.params.id, request.body);
      const opRecord = makeOperatorDecisionRecord({
        project,
        gate: 'compute_release',
        targetKind: 'compute_job',
        targetId: current.id,
        targetTitle: current.title,
        projectId: current.projectId,
        approvalFingerprint: current.approvalFingerprint,
        approved: request.body.decision === 'approve',
        reason: request.body.reason,
        nowIso: new Date().toISOString(),
      });
      return store.recordApprovalDecision(current.id, opRecord).catch(() => result);
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
