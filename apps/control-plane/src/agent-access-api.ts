import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AgentCredentialsUnavailableError,
  type AgentCredentialIssuerPort,
} from '../../../packages/adapters/src/aws-agent-access.js';
import {
  type AgentCredentialCatalogConfig,
  type AgentCredentialProjectScope,
  type AgentCredentialRequestInput,
  planAgentCredentials,
} from '../../../packages/core/src/agent-credential-purposes.js';
import { assertProjectCapability } from '../../../packages/core/src/projects.js';
import { DomainError, equalSecret } from '../../../packages/core/src/store.js';
import { authenticateRequest, getPrincipal, type HostAuthContext } from './auth.js';

export interface AgentCredentialAuditRecord {
  event: 'hivemind.agent_credentials.issued' | 'hivemind.agent_credentials.denied' | 'hivemind.agent_credentials.failed';
  purpose: string | null;
  target: { projectId: string | null; workloadId: string | null; modelId: string | null; s3Prefix: string | null } | null;
  policyHash: string | null;
  description: string | null;
  expiration: string | null;
  reason: string | null;
  at: string;
}

export interface AgentCredentialsApiOptions {
  operatorToken: string;
  agentToken?: string;
  auth?: HostAuthContext;
  catalog: AgentCredentialCatalogConfig;
  issuer: AgentCredentialIssuerPort;
  region: string;
  audit?: (record: AgentCredentialAuditRecord) => void;
  now?: () => number;
}

export function registerAgentCredentialRoutes(app: FastifyInstance, options: AgentCredentialsApiOptions): void {
  const now = options.now ?? Date.now;
  const audit = options.audit ?? ((record) => console.log(JSON.stringify(record)));
  const operatorOrAgent = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.auth) {
      const p = await authenticateRequest(request, options.auth);
      if (p?.role === 'operator' || p?.role === 'legacy_agent') return;
      if (p?.role === 'project_agent') {
        if (!p.scopes.has('credentials:issue')) {
          return reply.code(403).send({ error: "Project token lacks required scope 'credentials:issue'" });
        }
        return;
      }
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const header = request.headers.authorization ?? '';
    const allowed =
      equalSecret(header, `Bearer ${options.operatorToken}`) ||
      (Boolean(options.agentToken) && equalSecret(header, `Bearer ${options.agentToken}`));
    if (!allowed) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.get('/api/agent-credentials/purposes', { onRequest: operatorOrAgent }, async (request) => {
    const principal = getPrincipal(request);
    if (principal?.role === 'project_agent') {
      const allowed = options.catalog.enabledPurposes.filter((p) => principal.project.compute.credentialPurposes.includes(p));
      return { purposes: allowed, region: options.region, projectId: principal.projectId };
    }
    return {
      purposes: options.catalog.enabledPurposes,
      region: options.region,
    };
  });

  app.post<{ Body: AgentCredentialRequestInput }>(
    '/api/agent-credentials',
    { onRequest: operatorOrAgent, bodyLimit: 4096 },
    async (request, reply) => {
      const body = (request.body ?? {}) as AgentCredentialRequestInput;
      const base = { at: new Date(now()).toISOString() };
      const principal = getPrincipal(request);
      let projectScope: AgentCredentialProjectScope | undefined;
      if (principal?.role === 'project_agent') {
        assertProjectCapability(principal.project, 'scoped_credentials');
        projectScope = {
          projectId: principal.project.id,
          allowedPrefixes: principal.project.compute.s3ArtifactPrefixes,
          allowedRegions: principal.project.compute.allowedRegions,
          allowedPurposes: principal.project.compute.credentialPurposes,
        };
      }
      let plan;
      try {
        plan = planAgentCredentials(options.catalog, body, projectScope);
      } catch (error) {
        audit({
          ...base,
          event: 'hivemind.agent_credentials.denied',
          purpose: typeof body.purpose === 'string' ? body.purpose.slice(0, 64) : null,
          target: null,
          policyHash: null,
          description: null,
          expiration: null,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'invalid request',
        });
        throw error;
      }
      const record = {
        ...base,
        purpose: plan.purpose,
        target: plan.target,
        policyHash: plan.policyHash,
        description: plan.description,
      };
      try {
        const issued = await options.issuer.issue(
          { policy: plan.policy, durationSeconds: plan.durationSeconds, description: plan.description },
          AbortSignal.timeout(20_000),
        );
        audit({ ...record, event: 'hivemind.agent_credentials.issued', expiration: issued.expiration, reason: null });
        reply.header('cache-control', 'no-store');
        return {
          purpose: plan.purpose,
          target: plan.target,
          region: options.region,
          policyHash: plan.policyHash,
          description: plan.description,
          credentials: issued,
        };
      } catch (error) {
        audit({
          ...record,
          event: 'hivemind.agent_credentials.failed',
          expiration: null,
          reason:
            error instanceof AgentCredentialsUnavailableError
              ? `STS ${error.stage} failed`
              : error instanceof Error
                ? error.message.slice(0, 200)
                : 'issuer failed',
        });
        if (error instanceof AgentCredentialsUnavailableError) {
          throw new DomainError(error.message, 502);
        }
        throw new DomainError('Scoped AWS credential issuance failed', 502);
      }
    },
  );
}
