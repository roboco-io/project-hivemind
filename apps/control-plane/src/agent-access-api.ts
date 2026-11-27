import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AgentCredentialsUnavailableError,
  type AgentCredentialIssuerPort,
} from '../../../packages/adapters/src/aws-agent-access.js';
import {
  type AgentCredentialCatalogConfig,
  type AgentCredentialRequestInput,
  planAgentCredentials,
} from '../../../packages/core/src/agent-credential-purposes.js';
import { DomainError, equalSecret } from '../../../packages/core/src/store.js';

/** One audit line per request. It never holds credentials or the policy body; only the policy hash. */
export interface AgentCredentialAuditRecord {
  event: 'hivemind.agent_credentials.issued' | 'hivemind.agent_credentials.denied' | 'hivemind.agent_credentials.failed';
  purpose: string | null;
  target: { modelId: string | null } | null;
  policyHash: string | null;
  description: string | null;
  expiration: string | null;
  reason: string | null;
  at: string;
}

export interface AgentCredentialsApiOptions {
  operatorToken: string;
  catalog: AgentCredentialCatalogConfig;
  issuer: AgentCredentialIssuerPort;
  /** Region of the STS endpoint; returned so the client can pin its own calls. */
  region: string;
  audit?: (record: AgentCredentialAuditRecord) => void;
  now?: () => number;
}

/**
 * POST /api/agent-credentials issues short-lived AWS credentials for one purpose from the operator's
 * catalog. The response is the only place the credentials appear.
 */
export function registerAgentCredentialRoutes(app: FastifyInstance, options: AgentCredentialsApiOptions): void {
  const now = options.now ?? Date.now;
  const audit = options.audit ?? ((record) => console.log(JSON.stringify(record)));
  const operatorOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!equalSecret(request.headers.authorization ?? '', `Bearer ${options.operatorToken}`)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.get('/api/agent-credentials/purposes', { onRequest: operatorOnly }, async () => ({
    purposes: options.catalog.enabledPurposes,
    region: options.region,
  }));

  app.post<{ Body: AgentCredentialRequestInput }>(
    '/api/agent-credentials',
    { onRequest: operatorOnly, bodyLimit: 4096 },
    async (request, reply) => {
      const body = (request.body ?? {}) as AgentCredentialRequestInput;
      const base = { at: new Date(now()).toISOString() };
      let plan;
      try {
        plan = planAgentCredentials(options.catalog, body);
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
        const stage = error instanceof AgentCredentialsUnavailableError ? error.stage : 'unknown';
        audit({ ...record, event: 'hivemind.agent_credentials.failed', expiration: null, reason: `STS ${stage} failed` });
        // Never fall back to the parent session: the request fails instead.
        throw new DomainError('Scoped credentials unavailable', 502);
      }
    },
  );
}
