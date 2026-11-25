import { createHash, createHmac } from 'node:crypto';
import { assertAwsRegion } from './autonomous-aws-region.js';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';

export interface AwsSecretsManagerConfig {
  region: string;
  allowedRegions?: string[];
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SecretsManagerPort {
  getSecretString(secretId: string, signal?: AbortSignal): Promise<string>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signSecretsManagerRequest(options: {
  region: string;
  host: string;
  target: string;
  body: string;
  credentials: AwsEcsCredentials;
  nowMs: number;
}): Record<string, string> {
  const iso = new Date(options.nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const dateStamp = iso.slice(0, 8);
  const payloadHash = sha256Hex(options.body);
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: options.host,
    'x-amz-date': amzDate,
    'x-amz-target': options.target,
    ...(options.credentials.sessionToken ? { 'x-amz-security-token': options.credentials.sessionToken } : {}),
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]!.trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${options.region}/secretsmanager/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, 'secretsmanager');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createAwsSecretsManagerPort(config: AwsSecretsManagerConfig): SecretsManagerPort {
  assertAwsRegion(config.region, config.allowedRegions);
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;

  return {
    async getSecretString(secretId: string, signal?: AbortSignal): Promise<string> {
      const cleanId = secretId.trim();
      if (!cleanId || cleanId.length > 512 || /[\r\n\0]/.test(cleanId)) {
        throw new Error('Invalid Secrets Manager secretId');
      }
      const credentials = await config.credentials();
      const host = `secretsmanager.${config.region}.amazonaws.com`;
      const body = JSON.stringify({ SecretId: cleanId });
      const headers = signSecretsManagerRequest({
        region: config.region,
        host,
        target: 'secretsmanager.GetSecretValue',
        body,
        credentials,
        nowMs: now(),
      });
      const response = await fetchImpl(`https://${host}/`, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`AWS Secrets Manager GetSecretValue failed with HTTP ${response.status}`);
      }
      const parsed = (await response.json()) as { SecretString?: unknown };
      if (typeof parsed.SecretString !== 'string' || !parsed.SecretString) {
        throw new Error('AWS Secrets Manager returned an empty or non-string SecretString');
      }
      return parsed.SecretString;
    },
  };
}
