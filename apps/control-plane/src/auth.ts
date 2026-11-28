import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ProjectPublicView, ProjectTokenScope } from '../../../packages/contracts/src/projects.js';
import type { ProjectStore } from '../../../packages/core/src/projects.js';
import { equalSecret } from '../../../packages/core/src/store.js';

export type RequestPrincipal =
  | { role: 'operator' }
  | { role: 'worker' }
  | { role: 'legacy_agent'; projectId: string | null }
  | { role: 'project_agent'; projectId: string; project: ProjectPublicView; tokenId: string; scopes: ReadonlySet<ProjectTokenScope> };

export interface HostAuthContext {
  operatorToken: string;
  workerToken: string;
  /** Optional host-level legacy agent token (transitions smoothly to per-project tokens). */
  agentToken?: string;
  /** Optional projectId bound to the legacy agent token. */
  legacyAgentProjectId?: string;
  projects: ProjectStore;
}

const PRINCIPAL_KEY = Symbol('hivemind.principal');

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

export async function authenticateRequest(request: FastifyRequest, ctx: HostAuthContext): Promise<RequestPrincipal | null> {
  const cached = (request as unknown as Record<symbol, RequestPrincipal | null | undefined>)[PRINCIPAL_KEY];
  if (cached !== undefined) return cached;

  const raw = extractBearer(request);
  let principal: RequestPrincipal | null = null;
  if (raw) {
    if (equalSecret(raw, ctx.operatorToken)) {
      principal = { role: 'operator' };
    } else if (equalSecret(raw, ctx.workerToken)) {
      principal = { role: 'worker' };
    } else if (ctx.agentToken && equalSecret(raw, ctx.agentToken)) {
      principal = { role: 'legacy_agent', projectId: ctx.legacyAgentProjectId ?? null };
    } else if (raw.startsWith('hmproj_')) {
      const matched = await ctx.projects.authenticateToken(raw);
      if (matched) {
        principal = {
          role: 'project_agent',
          projectId: matched.project.id,
          project: matched.project,
          tokenId: matched.token.tokenId,
          scopes: matched.scopes,
        };
      }
    }
  }
  (request as unknown as Record<symbol, RequestPrincipal | null>)[PRINCIPAL_KEY] = principal;
  return principal;
}

export function getPrincipal(request: FastifyRequest): RequestPrincipal | null {
  return (request as unknown as Record<symbol, RequestPrincipal | null | undefined>)[PRINCIPAL_KEY] ?? null;
}

export function requireOperator(ctx: HostAuthContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticateRequest(request, ctx);
    if (!p || p.role !== 'operator') {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}

export function requireWorker(ctx: HostAuthContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticateRequest(request, ctx);
    if (!p || p.role !== 'worker') {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}

export function requireOperatorOrAgent(
  ctx: HostAuthContext,
  requiredScope?: ProjectTokenScope,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticateRequest(request, ctx);
    if (!p) return reply.code(401).send({ error: 'Unauthorized' });
    if (p.role === 'operator' || p.role === 'legacy_agent') return;
    if (p.role === 'project_agent') {
      if (requiredScope && !p.scopes.has(requiredScope)) {
        return reply.code(403).send({ error: `Project token lacks required scope '${requiredScope}'` });
      }
      return;
    }
    return reply.code(401).send({ error: 'Unauthorized' });
  };
}
