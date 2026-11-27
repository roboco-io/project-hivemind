import { createHash, createHmac } from 'node:crypto';
import { assertAwsRegion } from './autonomous-aws-region.js';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';
import { bounded, parseXml, responseBody } from './aws-sts-protocol.js';

/** Temporary credentials handed to an agent. They are returned to the caller only, never stored or logged. */
export interface IssuedAgentCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601 expiry reported by STS. */
  expiration: string;
}

export interface AgentCredentialIssueRequest {
  policy: string;
  durationSeconds: number;
  description: string;
}

export interface AgentCredentialIssuerPort {
  issue(request: AgentCredentialIssueRequest, signal?: AbortSignal): Promise<IssuedAgentCredentials>;
}

export interface AwsAgentCredentialIssuerOptions {
  /** Region whose STS endpoint is used. GetScopedCredentials is not served by the global endpoint. */
  region: string;
  allowedRegions?: readonly string[];
  /** Dedicated parent role. Its permissions bound every issued credential. */
  parentRoleArn: string;
  /** Credentials of the Control Plane task, used only to assume the parent role. */
  baseCredentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetch?: typeof fetch;
  now?: () => number;
}

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]{1,128}$/;
const ACCESS_KEY = /^ASIA[A-Z0-9]{12,124}$/;
const SECRET_KEY = /^[A-Za-z0-9/+=]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** A parent session is reused while it has at least this long left, so a 900-second child always fits. */
const PARENT_MIN_REMAINING_MS = 20 * 60_000;
const PARENT_SESSION_SECONDS = 3600;

/** Thrown for every STS failure. It carries no AWS text, so no credential or request detail can leak. */
export class AgentCredentialsUnavailableError extends Error {
  constructor(readonly stage: 'assume_parent' | 'scope_down') {
    super('Scoped credentials unavailable');
  }
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function stsCall(
  options: { region: string; fetch: typeof fetch; nowMs: number },
  credentials: AwsEcsCredentials,
  params: Record<string, string>,
  rootName: string,
): Promise<Map<string, string>> {
  const body = new URLSearchParams(params).toString();
  const host = `sts.${options.region}.amazonaws.com`;
  const stamp = new Date(options.nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${options.region}/sts/aws4_request`;
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    host,
    'x-amz-date': stamp,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
  const keys = Object.keys(headers).sort();
  const signedHeaders = keys.join(';');
  const canonical = ['POST', '/', '', keys.map((k) => `${k}:${headers[k]}\n`).join(''), signedHeaders, sha(body)].join('\n');
  const hmac = (key: string | Uint8Array, value: string) => createHmac('sha256', key).update(value).digest();
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [options.region, 'sts', 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', stamp, scope, sha(canonical)].join('\n')).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const signal = AbortSignal.timeout(10_000);
  const response = await bounded(
    options.fetch(`https://${host}/`, { method: 'POST', headers, body, signal, redirect: 'manual' }),
    signal,
  );
  return parseXml(await bounded(responseBody(response, signal), signal), rootName);
}

function credentialsFrom(values: Map<string, string>, base: string): IssuedAgentCredentials {
  const get = (name: string) => values.get(`${base}Credentials/${name}`) ?? '';
  const issued = {
    accessKeyId: get('AccessKeyId'),
    secretAccessKey: get('SecretAccessKey'),
    sessionToken: get('SessionToken'),
    expiration: get('Expiration'),
  };
  if (
    !ACCESS_KEY.test(issued.accessKeyId) ||
    !SECRET_KEY.test(issued.secretAccessKey) ||
    issued.sessionToken.length < 16 ||
    issued.sessionToken.length > 65536 ||
    !ISO.test(issued.expiration)
  ) {
    throw new Error('Malformed STS credentials');
  }
  return issued;
}

/**
 * Issues agent credentials in two STS steps. The Control Plane task assumes the dedicated parent role,
 * then calls GetScopedCredentials with that session and the purpose policy. The parent session is kept
 * in memory only and is never returned: when the scope-down step fails the issuer throws.
 */
export function createAwsAgentCredentialIssuer(options: AwsAgentCredentialIssuerOptions): AgentCredentialIssuerPort {
  assertAwsRegion(options.region, options.allowedRegions ? [...options.allowedRegions] : undefined);
  if (!ROLE_ARN.test(options.parentRoleArn)) throw new Error('Invalid parent role ARN for agent credentials');
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let parent: { credentials: AwsEcsCredentials; arn: string; expiresAtMs: number } | null = null;

  async function parentSession(): Promise<NonNullable<typeof parent>> {
    if (parent && parent.expiresAtMs - now() >= PARENT_MIN_REMAINING_MS) return parent;
    try {
      const base = await options.baseCredentials();
      const values = await stsCall(
        { region: options.region, fetch: fetcher, nowMs: now() },
        base,
        {
          Action: 'AssumeRole',
          Version: '2011-06-15',
          RoleArn: options.parentRoleArn,
          RoleSessionName: `hivemind-agent-parent-${now()}`,
          DurationSeconds: String(PARENT_SESSION_SECONDS),
        },
        'AssumeRoleResponse',
      );
      const result = 'AssumeRoleResponse/AssumeRoleResult/';
      const issued = credentialsFrom(values, result);
      const arn = values.get(`${result}AssumedRoleUser/Arn`) ?? '';
      if (!/^arn:aws:sts::\d{12}:assumed-role\//.test(arn)) throw new Error('Malformed AssumeRole user');
      parent = {
        credentials: { accessKeyId: issued.accessKeyId, secretAccessKey: issued.secretAccessKey, sessionToken: issued.sessionToken },
        arn,
        expiresAtMs: Date.parse(issued.expiration),
      };
      return parent;
    } catch {
      parent = null;
      throw new AgentCredentialsUnavailableError('assume_parent');
    }
  }

  return {
    async issue(request) {
      if (request.policy.length < 1 || request.policy.length > 2048) throw new AgentCredentialsUnavailableError('scope_down');
      const session = await parentSession();
      const startedMs = now();
      // A child cannot outlive its parent; keep a 30-second margin for clock skew.
      const durationSeconds = Math.min(request.durationSeconds, Math.floor((session.expiresAtMs - startedMs) / 1000) - 30);
      try {
        if (durationSeconds < 60) throw new Error('Parent session too short');
        const values = await stsCall(
          { region: options.region, fetch: fetcher, nowMs: startedMs },
          session.credentials,
          {
            Action: 'GetScopedCredentials',
            Version: '2011-06-15',
            Policy: request.policy,
            DurationSeconds: String(durationSeconds),
            ScopedSessionDescription: request.description,
          },
          'GetScopedCredentialsResponse',
        );
        const result = 'GetScopedCredentialsResponse/GetScopedCredentialsResult/';
        const issued = credentialsFrom(values, result);
        const sessionArn = values.get(`${result}SessionInfo/Arn`);
        if (sessionArn !== undefined && sessionArn !== session.arn) throw new Error('Scoped session belongs to another principal');
        if (issued.accessKeyId === session.credentials.accessKeyId) throw new Error('STS returned the parent key');
        const expiresMs = Date.parse(issued.expiration);
        if (!(expiresMs > now() && expiresMs <= startedMs + durationSeconds * 1000 + 5_000)) {
          throw new Error('Scoped credentials expire later than requested');
        }
        return issued;
      } catch {
        throw new AgentCredentialsUnavailableError('scope_down');
      }
    },
  };
}
