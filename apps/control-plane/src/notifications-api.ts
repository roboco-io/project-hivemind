import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NOTIFICATION_KINDS, type NotificationKind, type NotifierPort } from '../../../packages/adapters/src/aws-sns-notifier.js';
import { assertProjectCapability } from '../../../packages/core/src/projects.js';
import { DomainError, equalSecret } from '../../../packages/core/src/store.js';
import { authenticateRequest, getPrincipal, type HostAuthContext } from './auth.js';

/** Sends at most `limit` notifications per rolling hour; the rest are refused so SMS quotas are not drained. */
export class NotificationGate {
  private sent: number[] = [];
  constructor(
    private readonly notifier: NotifierPort,
    private readonly limit = 30,
    private readonly now: () => number = Date.now,
  ) {}

  async send(kind: NotificationKind, subject: string, message: string): Promise<{ messageId: string } | { skipped: 'rate_limited' }> {
    const at = this.now();
    this.sent = this.sent.filter((t) => at - t < 3_600_000);
    if (this.sent.length >= this.limit) return { skipped: 'rate_limited' };
    this.sent.push(at);
    return this.notifier.notify({ kind, subject, message });
  }

  async sendQuietly(kind: NotificationKind, subject: string, message: string): Promise<void> {
    try {
      await this.send(kind, subject, message);
    } catch (error) {
      console.error(JSON.stringify({ event: 'hivemind.notification.error', kind, message: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
    }
  }
}

/** POST /api/notifications: operator or scoped project agent sends a notification of a known kind. */
export function registerNotificationRoutes(
  app: FastifyInstance,
  options: { gate: NotificationGate; operatorToken: string; agentToken?: string; auth?: HostAuthContext },
): void {
  const allowed = async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.auth) {
      const p = await authenticateRequest(request, options.auth);
      if (p?.role === 'operator' || p?.role === 'legacy_agent') return;
      if (p?.role === 'project_agent') {
        if (!p.scopes.has('notifications:send')) {
          return reply.code(403).send({ error: "Project token lacks required scope 'notifications:send'" });
        }
        return;
      }
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const header = request.headers.authorization ?? '';
    const ok =
      equalSecret(header, `Bearer ${options.operatorToken}`) ||
      (Boolean(options.agentToken) && equalSecret(header, `Bearer ${options.agentToken}`));
    if (!ok) return reply.code(401).send({ error: 'Unauthorized' });
  };

  app.post<{ Body: { kind?: unknown; subject?: unknown; message?: unknown } }>('/api/notifications', { onRequest: allowed, bodyLimit: 16384 }, async (request) => {
    const principal = getPrincipal(request);
    if (principal?.role === 'project_agent') {
      assertProjectCapability(principal.project, 'notifications');
    }
    const { kind, subject, message } = request.body ?? {};
    if (typeof kind !== 'string' || !Object.hasOwn(NOTIFICATION_KINDS, kind)) {
      throw new DomainError(`kind must be one of ${Object.keys(NOTIFICATION_KINDS).join(', ')}`, 400);
    }
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new DomainError('subject must be 1..200 characters', 400);
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new DomainError('message must be 1..4000 characters', 400);
    const effectiveSubject =
      principal?.role === 'project_agent' && !subject.includes(`[${principal.projectId}]`)
        ? `[${principal.projectId}] ${subject}`.slice(0, 200)
        : subject;
    try {
      return await options.gate.send(kind as NotificationKind, effectiveSubject, message);
    } catch {
      throw new DomainError('Notification could not be sent', 502);
    }
  });
}
