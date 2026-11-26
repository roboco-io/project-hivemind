import { createHash, createHmac } from 'node:crypto';
import { assertAwsRegion } from './autonomous-aws-region.js';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';

export interface AwsPublicAmiResolverConfig {
  allowedRegions: string[];
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Resolves the latest AMI ID from an AWS-owned public SSM parameter (`/aws/service/...`) in a given region. */
export interface PublicAmiResolverPort {
  resolveAmiId(region: string, parameterName: string, signal?: AbortSignal): Promise<string>;
}

/** Only AWS-owned public parameters are accepted, so an account-local parameter can never redirect the AMI. */
export const PUBLIC_AMI_SSM_PARAMETER_PATTERN = /^\/aws\/service\/[A-Za-z0-9_.\/-]{1,480}$/;
const AMI_ID_PATTERN = /^ami-[0-9a-f]{8,17}$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signSsmRequest(options: {
  region: string;
  host: string;
  body: string;
  credentials: AwsEcsCredentials;
  nowMs: number;
}): Record<string, string> {
  const iso = new Date(options.nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const dateStamp = iso.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: options.host,
    'x-amz-date': amzDate,
    'x-amz-target': 'AmazonSSM.GetParameter',
    ...(options.credentials.sessionToken ? { 'x-amz-security-token': options.credentials.sessionToken } : {}),
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]!.trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(options.body)].join('\n');
  const scope = `${dateStamp}/${options.region}/ssm/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, options.region), 'ssm'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createAwsPublicAmiResolver(config: AwsPublicAmiResolverConfig): PublicAmiResolverPort {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;

  return {
    async resolveAmiId(region: string, parameterName: string, signal?: AbortSignal): Promise<string> {
      assertAwsRegion(region, config.allowedRegions);
      if (!PUBLIC_AMI_SSM_PARAMETER_PATTERN.test(parameterName) || parameterName.includes('..')) {
        throw new Error('AMI SSM parameter must be an AWS-owned public parameter under /aws/service/');
      }
      const credentials = await config.credentials();
      const host = `ssm.${region}.amazonaws.com`;
      const body = JSON.stringify({ Name: parameterName });
      const headers = signSsmRequest({ region, host, body, credentials, nowMs: now() });
      const response = await fetchImpl(`https://${host}/`, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`AWS SSM GetParameter failed with HTTP ${response.status}`);
      }
      const parsed = (await response.json()) as { Parameter?: { Value?: unknown } };
      const value = parsed.Parameter?.Value;
      if (typeof value !== 'string' || !AMI_ID_PATTERN.test(value)) {
        throw new Error('AWS SSM public AMI parameter did not return a valid AMI ID');
      }
      return value;
    },
  };
}
