import { createHash, createHmac } from 'node:crypto';
import { assertAwsRegion } from './autonomous-aws-region.js';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';

export interface AwsS3ArtifactsConfig {
  region: string;
  allowedRegions?: string[];
  bucket: string;
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface S3ObjectPort {
  putObject(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<{ sha256: string; etag?: string }>;
  getObject(key: string, expectedSha256?: string, signal?: AbortSignal): Promise<Uint8Array>;
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HEX64 = /^[a-f0-9]{64}$/i;

function sha256HexBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sha256Base64Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('base64');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function encodeS3Path(key: string): string {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\') || key.includes('\0')) {
    throw new Error(`Unsafe S3 object key: ${key}`);
  }
  return '/' + key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function signS3Request(options: {
  method: 'GET' | 'PUT';
  region: string;
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType?: string;
  credentials: AwsEcsCredentials;
  nowMs: number;
}): { url: string; headers: Record<string, string> } {
  const host = `${options.bucket}.s3.${options.region}.amazonaws.com`;
  const canonicalUri = encodeS3Path(options.key);
  const iso = new Date(options.nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const dateStamp = iso.slice(0, 8);
  const payloadHash = sha256HexBytes(options.body);
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(options.contentType ? { 'content-type': options.contentType } : {}),
    ...(options.method === 'PUT' ? { 'x-amz-checksum-sha256': sha256Base64Bytes(options.body) } : {}),
    ...(options.credentials.sessionToken ? { 'x-amz-security-token': options.credentials.sessionToken } : {}),
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]!.trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [options.method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexBytes(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `https://${host}${canonicalUri}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export function createAwsS3ArtifactsPort(config: AwsS3ArtifactsConfig): S3ObjectPort {
  assertAwsRegion(config.region, config.allowedRegions);
  if (!BUCKET_PATTERN.test(config.bucket)) {
    throw new Error('Invalid S3 bucket name (dots and uppercase are rejected for virtual-host TLS safety)');
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;

  return {
    async putObject(key, body, contentType, signal) {
      const credentials = await config.credentials();
      const signed = signS3Request({
        method: 'PUT',
        region: config.region,
        bucket: config.bucket,
        key,
        body,
        contentType,
        credentials,
        nowMs: now(),
      });
      const response = await fetchImpl(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body: Buffer.from(body),
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`S3 PUT ${key} failed with HTTP ${response.status}`);
      }
      return {
        sha256: sha256HexBytes(body),
        etag: response.headers.get('etag') ?? undefined,
      };
    },

    async getObject(key, expectedSha256, signal) {
      if (expectedSha256 !== undefined && !HEX64.test(expectedSha256)) {
        throw new Error('Invalid expectedSha256');
      }
      const credentials = await config.credentials();
      const signed = signS3Request({
        method: 'GET',
        region: config.region,
        bucket: config.bucket,
        key,
        body: new Uint8Array(0),
        credentials,
        nowMs: now(),
      });
      const response = await fetchImpl(signed.url, {
        method: 'GET',
        headers: signed.headers,
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`S3 GET ${key} failed with HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expectedSha256 !== undefined) {
        const actual = sha256HexBytes(bytes);
        if (actual !== expectedSha256.toLowerCase()) {
          throw new Error(`S3 GET ${key} SHA-256 verification failed`);
        }
      }
      return bytes;
    },
  };
}
