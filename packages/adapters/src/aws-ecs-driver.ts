import { createHash, createHmac } from 'node:crypto';
import type { RuntimeDriver, Task } from '../../contracts/src/index.js';
import { assertAwsRegion } from './autonomous-aws-region.js';

export interface AwsEcsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsEcsDriverConfig {
  region: string;
  allowedRegions?: string[];
  clusterArn: string;
  workerTaskDefinition: string;
  verifierTaskDefinition: string;
  workerContainerName?: string;
  verifierContainerName?: string;
  subnets: string[];
  securityGroups: string[];
  /** Set 'ENABLED' for NAT-free public subnets paired with a zero-ingress Worker Security Group. Defaults to 'DISABLED'. */
  assignPublicIp?: 'ENABLED' | 'DISABLED';
  controlApiUrl: string;
  /** When true, permits http:// controlApiUrl strictly for RFC1918 VPC private IPs or *.internal hosts. */
  allowVpcInternalHttp?: boolean;
  artifactsBucket: string;
  allowOnDemandFallback?: boolean;
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface LaunchEcsWorkloadInput {
  kind: 'worker' | 'verifier';
  taskId: string;
  runId: string;
  iteration: number;
  bundleS3Key: string;
  bundleSha256: string;
  acceptanceDigest: string;
  patchS3Key?: string;
  checkpointS3Key?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signAwsJsonRequest(options: {
  service: string;
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
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${options.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, options.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function assertSafeValue(value: string, name: string): string {
  if (!value || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid ECS parameter: ${name}`);
  }
  return value;
}

function isPrivateVpcHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith('.internal')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface EcsTaskStatus {
  /** ECS lastStatus, for example PROVISIONING, PENDING, RUNNING, DEPROVISIONING, STOPPED. */
  lastStatus: string;
  stopCode: string | null;
  stoppedReason: string | null;
  exitCode: number | null;
}

export class AwsEcsFargateSpotDriver implements RuntimeDriver {
  readonly runtime = 'ecs' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: AwsEcsDriverConfig) {
    assertAwsRegion(config.region, config.allowedRegions);
    if (!config.subnets.length || !config.securityGroups.length) {
      throw new Error('AWS ECS driver requires private subnets and securityGroups');
    }
    const isHttps = /^https:\/\//.test(config.controlApiUrl);
    const isAllowedInternalHttp = config.allowVpcInternalHttp === true && isPrivateVpcHttpUrl(config.controlApiUrl);
    if (!isHttps && !isAllowedInternalHttp) {
      throw new Error('AWS ECS driver requires HTTPS controlApiUrl');
    }
    if (config.workerTaskDefinition === config.verifierTaskDefinition) {
      throw new Error('Worker and verifier must use distinct ECS task definitions and IAM roles');
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  private async ecsCall(
    action: 'RunTask' | 'StopTask' | 'DescribeTasks',
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const creds = await this.config.credentials();
    const host = `ecs.${this.config.region}.amazonaws.com`;
    const body = JSON.stringify(payload);
    const headers = signAwsJsonRequest({
      service: 'ecs',
      region: this.config.region,
      host,
      target: `AmazonEC2ContainerServiceV20141113.${action}`,
      body,
      credentials: creds,
      nowMs: this.now(),
    });
    const response = await this.fetchImpl(`https://${host}/`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`AWS ECS ${action} failed with HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async launchWorkload(input: LaunchEcsWorkloadInput, signal?: AbortSignal): Promise<{ taskArn: string }> {
    const isWorker = input.kind === 'worker';
    const taskDefinition = isWorker ? this.config.workerTaskDefinition : this.config.verifierTaskDefinition;
    const containerName = isWorker
      ? (this.config.workerContainerName ?? 'ai-worker')
      : (this.config.verifierContainerName ?? 'verifier');

    // Non-secret metadata only; secrets come strictly from each Task Definition's isolated IAM role.
    const environment: { name: string; value: string }[] = [
      { name: 'HIVEMIND_CONTROL_API_URL', value: assertSafeValue(this.config.controlApiUrl, 'controlApiUrl') },
      { name: 'HIVEMIND_ARTIFACTS_BUCKET', value: assertSafeValue(this.config.artifactsBucket, 'artifactsBucket') },
      { name: 'HIVEMIND_TASK_ID', value: assertSafeValue(input.taskId, 'taskId') },
      { name: 'HIVEMIND_RUN_ID', value: assertSafeValue(input.runId, 'runId') },
      { name: 'HIVEMIND_ITERATION', value: String(input.iteration) },
      { name: 'HIVEMIND_BUNDLE_S3_KEY', value: assertSafeValue(input.bundleS3Key, 'bundleS3Key') },
      { name: 'HIVEMIND_BUNDLE_SHA256', value: assertSafeValue(input.bundleSha256, 'bundleSha256') },
      { name: 'HIVEMIND_ACCEPTANCE_DIGEST', value: assertSafeValue(input.acceptanceDigest, 'acceptanceDigest') },
      ...(input.patchS3Key ? [{ name: 'HIVEMIND_PATCH_S3_KEY', value: assertSafeValue(input.patchS3Key, 'patchS3Key') }] : []),
      ...(isWorker && input.checkpointS3Key
        ? [{ name: 'HIVEMIND_CHECKPOINT_S3_KEY', value: assertSafeValue(input.checkpointS3Key, 'checkpointS3Key') }]
        : []),
    ];

    const capacityProviderStrategy = this.config.allowOnDemandFallback
      ? [
          { capacityProvider: 'FARGATE_SPOT', weight: 4, base: 0 },
          { capacityProvider: 'FARGATE', weight: 1, base: 0 },
        ]
      : [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }];

    const result = await this.ecsCall(
      'RunTask',
      {
        cluster: this.config.clusterArn,
        taskDefinition,
        count: 1,
        capacityProviderStrategy,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnets,
            securityGroups: this.config.securityGroups,
            assignPublicIp: this.config.assignPublicIp ?? 'DISABLED',
          },
        },
        overrides: { containerOverrides: [{ name: containerName, environment }] },
        tags: [
          { key: 'hivemind:taskId', value: input.taskId },
          { key: 'hivemind:runId', value: input.runId },
          { key: 'hivemind:kind', value: input.kind },
        ],
      },
      signal,
    );
    const tasks = result.tasks as { taskArn?: string }[] | undefined;
    const taskArn = tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error('AWS ECS RunTask returned no taskArn');
    return { taskArn };
  }

  async launchCollabWorker(
    input: {
      sessionId: string;
      subtaskId: string;
      agentId: string;
      provider: 'claude' | 'codex';
    },
    signal?: AbortSignal,
  ): Promise<{ taskArn: string; region: string }> {
    const containerName = this.config.workerContainerName ?? 'ai-worker';
    const environment: { name: string; value: string }[] = [
      { name: 'HIVEMIND_COLLAB_MODE', value: 'true' },
      { name: 'HIVEMIND_CONTROL_API_URL', value: assertSafeValue(this.config.controlApiUrl, 'controlApiUrl') },
      { name: 'HIVEMIND_ARTIFACTS_BUCKET', value: assertSafeValue(this.config.artifactsBucket, 'artifactsBucket') },
      { name: 'HIVEMIND_COLLAB_SESSION_ID', value: assertSafeValue(input.sessionId, 'sessionId') },
      { name: 'HIVEMIND_COLLAB_SUBTASK_ID', value: assertSafeValue(input.subtaskId, 'subtaskId') },
      { name: 'HIVEMIND_COLLAB_AGENT_ID', value: assertSafeValue(input.agentId, 'agentId') },
      { name: 'HIVEMIND_COLLAB_PROVIDER', value: input.provider },
    ];
    const capacityProviderStrategy = this.config.allowOnDemandFallback
      ? [
          { capacityProvider: 'FARGATE_SPOT', weight: 4, base: 0 },
          { capacityProvider: 'FARGATE', weight: 1, base: 0 },
        ]
      : [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }];

    const result = await this.ecsCall(
      'RunTask',
      {
        cluster: this.config.clusterArn,
        taskDefinition: this.config.workerTaskDefinition,
        count: 1,
        capacityProviderStrategy,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnets,
            securityGroups: this.config.securityGroups,
            assignPublicIp: this.config.assignPublicIp ?? 'DISABLED',
          },
        },
        overrides: { containerOverrides: [{ name: containerName, environment }] },
        tags: [
          { key: 'hivemind:sessionId', value: input.sessionId },
          { key: 'hivemind:subtaskId', value: input.subtaskId },
          { key: 'hivemind:kind', value: 'collab-worker' },
        ],
      },
      signal,
    );
    const tasks = result.tasks as { taskArn?: string }[] | undefined;
    const taskArn = tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error('AWS ECS RunTask (collab-worker) returned no taskArn');
    return { taskArn, region: this.config.region };
  }

  async launch(task: Task): Promise<{ externalRunId: string }> {
    if (!task.runId || !task.baseCommit) throw new Error('ECS launch requires task runId and baseCommit');
    const launched = await this.launchWorkload({
      kind: 'worker',
      taskId: task.id,
      runId: task.runId,
      iteration: 1,
      bundleS3Key: `bundles/${task.baseCommit}.bundle`,
      bundleSha256: '0'.repeat(64),
      acceptanceDigest: '0'.repeat(64),
    });
    return { externalRunId: launched.taskArn };
  }

  /**
   * Reads one task's lifecycle state. Returns `null` when ECS no longer knows the task (ECS forgets a
   * stopped task after about an hour), which a caller must treat as "the worker is gone".
   */
  async describeTask(taskArn: string, signal?: AbortSignal): Promise<EcsTaskStatus | null> {
    const result = await this.ecsCall(
      'DescribeTasks',
      { cluster: this.config.clusterArn, tasks: [assertSafeValue(taskArn, 'taskArn')] },
      signal,
    );
    const task = (result.tasks as Record<string, unknown>[] | undefined)?.[0];
    if (!task) return null;
    const container = (task.containers as Record<string, unknown>[] | undefined)?.[0];
    return {
      lastStatus: typeof task.lastStatus === 'string' ? task.lastStatus : 'UNKNOWN',
      stopCode: typeof task.stopCode === 'string' ? task.stopCode : null,
      stoppedReason: typeof task.stoppedReason === 'string' ? task.stoppedReason.slice(0, 300) : null,
      exitCode: typeof container?.exitCode === 'number' ? container.exitCode : null,
    };
  }

  async stop(externalRunId: string): Promise<void> {
    await this.ecsCall('StopTask', {
      cluster: this.config.clusterArn,
      task: assertSafeValue(externalRunId, 'externalRunId'),
      reason: 'Stopped by HIVEMIND control plane',
    });
  }
}
