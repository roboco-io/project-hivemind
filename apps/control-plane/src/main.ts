import {createAutonomousCloudProxy} from './autonomous-cloud-proxy.js';
import { buildApp } from './app.js';
import { configurationGitEnvironment, configurationScope, loadCloudflareConfig, loadCloudWorkflowChecks } from './cloudflare-config.js';
import { DeliveryOrchestrator } from './delivery-orchestrator.js';
import { ComputeOrchestrator, parseRegionNetworkRegistry } from './compute-orchestrator.js';
import { CollabOrchestrator } from './collab-orchestrator.js';
import { DsqlCollaborationRepository } from '../../../packages/adapters/src/aws-dsql.js';
import { DsqlComputeRepository, importComputeHistoryIfEmpty } from '../../../packages/adapters/src/aws-dsql-compute.js';
import { DsqlProjectRepository, importProjectHistoryIfEmpty } from '../../../packages/adapters/src/aws-dsql-projects.js';
import { SqliteComputeRepository } from '../../../packages/core/src/compute-repository.js';
import { ProjectStore, SqliteProjectRepository } from '../../../packages/core/src/projects.js';
import { DsqlDeliveryRepository } from '../../../packages/adapters/src/aws-dsql-delivery.js';
import { SqliteDeliveryRepository } from '../../../packages/core/src/delivery-repository.js';
import { importHistoryIfEmpty } from '../../../packages/core/src/document-repository.js';
import { AwsEc2SpotTrainer } from '../../../packages/adapters/src/aws-ec2-spot-trainer.js';
import { createTrustedHfReleasePublisher } from '../../../packages/adapters/src/compute-hf-publisher.js';
import { AwsEcsFargateSpotDriver } from '../../../packages/adapters/src/aws-ecs-driver.js';
import { AwsMultiRegionEcsDriver } from '../../../packages/adapters/src/aws-multi-region-driver.js';
import { createEcsTaskCredentialsProvider } from '../../../packages/adapters/src/aws-ecs-metadata-creds.js';
import { createAwsS3ArtifactsPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { createAwsSecretsManagerPort } from '../../../packages/adapters/src/aws-secrets-manager.js';
import { createAwsPublicAmiResolver } from '../../../packages/adapters/src/aws-ssm-public-ami.js';
import { createSpotPlacementFeedPort, DEFAULT_SPOT_FEED_URL } from '../../../packages/adapters/src/spot-placement-feed.js';
import type { AwsSpokeRegionConfig } from '../../../packages/contracts/src/multi-region.js';
import { createCloudPort } from '../../../packages/adapters/src/cloudflare.js';
import { createCloudWorkflowPort } from '../../../packages/adapters/src/cloud-workflow.js';
import { createGitHubDraftPrPort } from '../../../packages/adapters/src/github-draft-pr.js';
import { createGitPushCommitMaterializer } from '../../../packages/adapters/src/github-git-push.js';
import { resolveGithubCredentialForRepo } from '../../../packages/adapters/src/github-token-resolver.js';
import { createCloudWorkflowControl } from '../../../packages/core/src/cloud-workflow-store.js';
import { createHash } from 'node:crypto';
import { createCloudControl } from '../../../packages/core/src/cloudflare-store.js';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import type { RepositoryPolicy } from '../../../packages/contracts/src/index.js';
import type { CloudControl } from '../../../packages/contracts/src/cloudflare.js';
import type { DeliveryStore } from '../../../packages/core/src/delivery.js';
import type { ComputeStore } from '../../../packages/core/src/compute.js';
import type { AgentCollabService } from '../../../packages/core/src/agent-collab.js';
import { createAwsSnsNotifier, type NotificationKind } from '../../../packages/adapters/src/aws-sns-notifier.js';
import { NotificationGate } from './notifications-api.js';
import { AutonomyDispatcher } from './autonomy-dispatcher.js';
import { createGitSnapshotPreparer } from './autonomy-snapshot.js';
import { DsqlAutonomyTriggerRepository } from '../../../packages/adapters/src/aws-dsql-autonomy.js';
import type { AutonomyTriggerStore } from '../../../packages/core/src/autonomy-trigger.js';
import { createAwsAgentCredentialIssuer } from '../../../packages/adapters/src/aws-agent-access.js';
import { parseEnabledPurposes, validateCatalogConfig } from '../../../packages/core/src/agent-credential-purposes.js';

function isRfc1918Ipv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number) as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function detectPrivateVpcIpv4(): string | null {
  const ifaces = networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isRfc1918Ipv4(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

/** Late-bound autonomy hooks: the periodic trigger registers itself here once it exists (issue #20). */
const autonomyHooks: { onAutoMergeRefused?: (task: import('../../../packages/contracts/src/delivery.js').DeliveryTask, reason: string) => Promise<void> } = {};

/**
 * Periodic autonomy triggers (issue #20) on AWS: snapshots come from the live repository through the
 * GitHub App and go to S3; workers start through the delivery orchestrator. Undefined outside AWS mode.
 */
function createAwsAutonomyDispatcherFactory() {
  const region = process.env.HIVEMIND_AWS_REGION?.trim();
  const bucket = process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim();
  const githubSecretArn = process.env.HIVEMIND_GITHUB_SECRET_ARN?.trim();
  if (!region || !bucket || !githubSecretArn) return undefined;
  const credentials = createEcsTaskCredentialsProvider();
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials });
  const secretsManager = createAwsSecretsManagerPort({ region, allowedRegions: [region], credentials });
  const prepare = createGitSnapshotPreparer({
    s3,
    resolveToken: async (repository, signal) => (await resolveGithubCredentialForRepo(await secretsManager.getSecretString(githubSecretArn, signal), repository, { signal })).token,
  });
  return (triggers: AutonomyTriggerStore, delivery: DeliveryStore, orchestrator?: DeliveryOrchestrator, projects?: ProjectStore) =>
    orchestrator
      ? new AutonomyDispatcher({ triggers, delivery, projects, prepare, dispatchWorker: (taskId, signal) => orchestrator.dispatchWorker(taskId, signal), reconcile: (signal) => orchestrator.reconcileRunningTasks(signal), uploadAcceptance: (task, signal) => orchestrator.uploadAcceptanceSpec(task, signal), primaryRegion: region })
      : undefined;
}

function createAwsDeliveryOrchestratorFactory(port: number, extraRedactSecrets: string[], notifications?: NotificationGate) {
  const region = process.env.HIVEMIND_AWS_REGION?.trim();
  const bucket = process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim();
  const clusterArn = process.env.HIVEMIND_ECS_CLUSTER_ARN?.trim();
  const workerTaskDef = process.env.HIVEMIND_AI_WORKER_TASK_DEF?.trim();
  const verifierTaskDef = process.env.HIVEMIND_VERIFIER_TASK_DEF?.trim();
  const subnets = (process.env.HIVEMIND_WORKER_SUBNETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const securityGroups = (process.env.HIVEMIND_WORKER_SECURITY_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const githubSecretArn = process.env.HIVEMIND_GITHUB_SECRET_ARN?.trim();

  if (!region || !bucket || !clusterArn || !workerTaskDef || !verifierTaskDef || !subnets.length || !securityGroups.length || !githubSecretArn) {
    return undefined;
  }

  const explicitApiUrl = process.env.HIVEMIND_CONTROL_API_URL?.trim();
  const allowVpcInternalHttp = process.env.HIVEMIND_ALLOW_VPC_INTERNAL_HTTP === 'true';
  const detectedIp = detectPrivateVpcIpv4();
  const controlApiUrl = explicitApiUrl || (detectedIp ? `http://${detectedIp}:${port}` : '');
  if (!controlApiUrl) {
    throw new Error('Unable to determine Control Plane VPC URL for AWS ECS workers');
  }

  const assignPublicIp = process.env.HIVEMIND_WORKER_ASSIGN_PUBLIC_IP === 'ENABLED' ? 'ENABLED' : 'DISABLED';
  const credentials = createEcsTaskCredentialsProvider();
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials });
  const secretsManager = createAwsSecretsManagerPort({ region, allowedRegions: [region], credentials });

  const primarySpoke: AwsSpokeRegionConfig = {
    region,
    clusterArn,
    workerTaskDefinition: workerTaskDef,
    verifierTaskDefinition: verifierTaskDef,
    subnets,
    securityGroups,
    assignPublicIp,
    controlApiUrl,
    allowVpcInternalHttp,
    artifactsBucket: bucket,
  };
  const extraSpokes = loadExtraSpokes(primarySpoke);
  const allSpokes = [primarySpoke, ...extraSpokes];
  const ecs =
    allSpokes.length > 1
      ? new AwsMultiRegionEcsDriver({ primaryRegion: region, spokes: allSpokes, credentials })
      : new AwsEcsFargateSpotDriver({
          region,
          allowedRegions: [region],
          clusterArn,
          workerTaskDefinition: workerTaskDef,
          verifierTaskDefinition: verifierTaskDef,
          subnets,
          securityGroups,
          assignPublicIp,
          controlApiUrl,
          allowVpcInternalHttp,
          artifactsBucket: bucket,
          credentials,
        });
  const spotFeed = createSpotPlacementFeedPort({
    feedUrl: process.env.HIVEMIND_SPOT_FEED_URL?.trim() || DEFAULT_SPOT_FEED_URL,
  });
  const defaultRoutingPolicy = {
    primaryRegion: region,
    allowedRegions: allSpokes.map((s) => s.region),
    workloadClass: process.env.HIVEMIND_DEFAULT_WORKLOAD_CLASS?.trim() || 'c.xlarge-arm',
  };

  console.log(
    JSON.stringify({
      event: 'hivemind.control_plane.aws_orchestrator_enabled',
      region,
      allowedRegions: defaultRoutingPolicy.allowedRegions,
      bucket,
      controlApiUrl,
      assignPublicIp,
    }),
  );

  return (store: DeliveryStore) =>
    new DeliveryOrchestrator({
      store,
      s3,
      ecs,
      ...(notifications ? { notify: (kind: 'auto_merge_refused', subject: string, message: string) => notifications.sendQuietly(kind, subject, message) } : {}),
      onAutoMergeRefused: async (task, reason) => { await autonomyHooks.onAutoMergeRefused?.(task, reason); },
      spotFeed,
      defaultRoutingPolicy,
      redactSecrets: extraRedactSecrets,
      githubFactory: async ({ task, bundlePath, expectedBundleSha256, workRoot, signal }) => {
        const rawSecret = await secretsManager.getSecretString(githubSecretArn, signal);
        // A GitHub App entry in the secret yields a one-hour, single-repository token; otherwise a stored PAT.
        const credential = await resolveGithubCredentialForRepo(rawSecret, task.delivery.repository, { signal });
        const token = credential.token;
        console.log(
          JSON.stringify({
            event: 'hivemind.delivery.github_credential_resolved',
            taskId: task.id,
            repository: task.delivery.repository,
            source: credential.source,
            expiresAt: credential.expiresAt,
          }),
        );
        const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
        const httpExtraHeader = `Authorization: Basic ${basic}`;
        const materializer = createGitPushCommitMaterializer({
          bundlePath,
          expectedBundleSha256,
          workRoot,
          remoteUrl: `https://github.com/${task.delivery.repository}.git`,
          httpExtraHeader,
          push: true,
        });
        return {
          port: createGitHubDraftPrPort({ token }, materializer),
          redactSecrets: [token, basic],
        };
      },
    });
}

const SPOKE_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/**
 * Parses HIVEMIND_AWS_SPOKES_JSON. Each entry must name its region, cluster, task definitions, subnets and
 * security groups. The Control Plane URL, the artifacts bucket and public-IP settings default to the
 * primary Hub values, because the Control Plane private IP is known only at start-up.
 */
function loadExtraSpokes(primary: AwsSpokeRegionConfig): AwsSpokeRegionConfig[] {
  const raw = process.env.HIVEMIND_AWS_SPOKES_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('HIVEMIND_AWS_SPOKES_JSON must be a JSON array');
  return parsed.map((item) => {
    const entry = item as Partial<AwsSpokeRegionConfig>;
    if (
      typeof entry.region !== 'string' ||
      !SPOKE_REGION_PATTERN.test(entry.region) ||
      entry.region === primary.region ||
      typeof entry.clusterArn !== 'string' ||
      !entry.clusterArn.startsWith(`arn:aws:ecs:${entry.region}:`) ||
      typeof entry.workerTaskDefinition !== 'string' ||
      typeof entry.verifierTaskDefinition !== 'string' ||
      !Array.isArray(entry.subnets) ||
      entry.subnets.length === 0 ||
      !Array.isArray(entry.securityGroups) ||
      entry.securityGroups.length === 0
    ) {
      throw new Error('HIVEMIND_AWS_SPOKES_JSON contains an invalid spoke entry');
    }
    return {
      ...entry,
      controlApiUrl: entry.controlApiUrl ?? primary.controlApiUrl,
      allowVpcInternalHttp: entry.allowVpcInternalHttp ?? primary.allowVpcInternalHttp,
      artifactsBucket: entry.artifactsBucket ?? primary.artifactsBucket,
      assignPublicIp: entry.assignPublicIp ?? primary.assignPublicIp,
    } as AwsSpokeRegionConfig;
  });
}

/**
 * Scoped AWS credentials for agents. Enabled only when the operator configured a dedicated parent role;
 * the enabled purposes come from HIVEMIND_AGENT_CREDENTIAL_PURPOSES, never from a request.
 */
function createAgentCredentialsOptions() {
  const parentRoleArn = process.env.HIVEMIND_AGENT_CREDENTIALS_PARENT_ROLE_ARN?.trim();
  if (!parentRoleArn) return undefined;
  const region = process.env.HIVEMIND_AWS_REGION?.trim() || 'ap-northeast-2';
  const allowedRegions = (process.env.HIVEMIND_MF_ALLOWED_REGIONS ?? region).split(',').map((r) => r.trim()).filter(Boolean);
  const catalog = validateCatalogConfig({
    enabledPurposes: parseEnabledPurposes(process.env.HIVEMIND_AGENT_CREDENTIAL_PURPOSES),
    artifactsBucket: process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim() ?? '',
    artifactsKmsKeyArn: process.env.HIVEMIND_ARTIFACTS_KMS_KEY_ARN?.trim() ?? '',
    allowedRegions,
  });
  const issuer = createAwsAgentCredentialIssuer({
    region,
    allowedRegions: [region],
    parentRoleArn,
    baseCredentials: createEcsTaskCredentialsProvider(),
  });
  return { catalog, issuer, region };
}

function createAwsComputeOrchestratorFactory(notifications?: NotificationGate) {
  const region = process.env.HIVEMIND_AWS_REGION?.trim();
  const bucket = process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim();
  if (!region || !bucket) return undefined;

  const allowedRegions = (process.env.HIVEMIND_COMPUTE_ALLOWED_REGIONS ?? process.env.HIVEMIND_MF_ALLOWED_REGIONS ?? `${region},us-east-2,us-east-1,us-west-2,ap-northeast-1`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const credentials = createEcsTaskCredentialsProvider();
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials });
  const ec2 = new AwsEc2SpotTrainer({ allowedRegions, credentials });
  const spotFeed = createSpotPlacementFeedPort({
    feedUrl: process.env.HIVEMIND_SPOT_FEED_URL?.trim() || DEFAULT_SPOT_FEED_URL,
  });

  const hfSecretArn = process.env.HIVEMIND_HF_RELEASE_SECRET_ARN?.trim();
  const secretsManager = hfSecretArn
    ? createAwsSecretsManagerPort({ region, allowedRegions: [region], credentials })
    : undefined;
  const hfPublisher =
    hfSecretArn && secretsManager
      ? createTrustedHfReleasePublisher({
          s3,
          resolveHfToken: async (signal) => {
            const raw = (await secretsManager.getSecretString(hfSecretArn, signal)).trim();
            if (raw.startsWith('{')) {
              const parsed = JSON.parse(raw) as { token?: unknown };
              if (typeof parsed.token !== 'string' || !parsed.token.trim()) {
                throw new Error('HF release secret JSON missing token');
              }
              return parsed.token.trim();
            }
            return raw;
          },
        })
      : undefined;

  // The independent release verifier reuses the Seoul verifier task definition (no model, GitHub or HF secret).
  const verifierClusterArn = process.env.HIVEMIND_ECS_CLUSTER_ARN?.trim();
  const verifierTaskDef = process.env.HIVEMIND_VERIFIER_TASK_DEF?.trim();
  const verifierWorkerTaskDef = process.env.HIVEMIND_AI_WORKER_TASK_DEF?.trim();
  const verifierSubnets = (process.env.HIVEMIND_WORKER_SUBNETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const verifierSecurityGroups = (process.env.HIVEMIND_WORKER_SECURITY_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const verifierControlIp = detectPrivateVpcIpv4();
  const verifierControlUrl = process.env.HIVEMIND_CONTROL_API_URL?.trim() || (verifierControlIp ? `http://${verifierControlIp}:${Number(process.env.HIVEMIND_PORT ?? '4310')}` : '');
  const verifierLauncher =
    verifierClusterArn && verifierTaskDef && verifierWorkerTaskDef && verifierSubnets.length && verifierSecurityGroups.length && verifierControlUrl
      ? new AwsEcsFargateSpotDriver({
          region,
          allowedRegions: [region],
          clusterArn: verifierClusterArn,
          workerTaskDefinition: verifierWorkerTaskDef,
          verifierTaskDefinition: verifierTaskDef,
          subnets: verifierSubnets,
          securityGroups: verifierSecurityGroups,
          assignPublicIp: process.env.HIVEMIND_WORKER_ASSIGN_PUBLIC_IP === 'ENABLED' ? 'ENABLED' : 'DISABLED',
          controlApiUrl: verifierControlUrl,
          allowVpcInternalHttp: process.env.HIVEMIND_ALLOW_VPC_INTERNAL_HTTP === 'true',
          artifactsBucket: bucket,
          credentials,
        })
      : undefined;

  const regionNetworks = parseRegionNetworkRegistry(process.env.HIVEMIND_MF_REGION_NETWORKS_JSON, allowedRegions);
  const amiResolver = createAwsPublicAmiResolver({ allowedRegions, credentials });

  const defaultInstanceProfileArn = process.env.HIVEMIND_MF_INSTANCE_PROFILE_ARN?.trim() || undefined;
  const allowedInstanceProfileArns = (process.env.HIVEMIND_MF_ALLOWED_INSTANCE_PROFILE_ARNS ?? defaultInstanceProfileArn ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (store: ComputeStore, projects: ProjectStore) =>
    new ComputeOrchestrator({
      store,
      projects,
      ec2,
      s3,
      ...(process.env.HIVEMIND_MF_TRAINING_ROLE_ID?.trim() ? { trainingRoleId: process.env.HIVEMIND_MF_TRAINING_ROLE_ID.trim() } : {}),
      ...(notifications ? { notify: (kind: NotificationKind, subject: string, message: string) => notifications.sendQuietly(kind, subject, message) } : {}),
      artifactsBucket: bucket,
      artifactsRegion: region,
      ...(regionNetworks ? { regionNetworks, amiResolver } : {}),
      ...(verifierLauncher ? { verifierLauncher } : {}),
      onPlacementAttempt: (attempt) =>
        console.log(JSON.stringify({ event: 'hivemind.compute.placement_attempt', ...attempt })),
      ...(defaultInstanceProfileArn ? { defaultInstanceProfileArn } : {}),
      ...(allowedInstanceProfileArns.length ? { allowedInstanceProfileArns } : {}),
      spotFeed,
      ...(hfPublisher ? { hfPublisher } : {}),
    });
}

let app: ReturnType<typeof buildApp> | undefined;
let cloudflare: CloudControl | undefined;
const startupErrors = new Set([
  'Invalid HIVEMIND_PORT',
  'Non-loopback binding requires two distinct custom tokens of at least 24 characters',
  'Invalid local repository configuration.',
  'Invalid Cloudflare dashboard configuration.',
  'Invalid Cloudflare port configuration.',
  'Operator and worker tokens must be nonempty and distinct'
]);
try {
  const host = process.env.HIVEMIND_HOST ?? '127.0.0.1';
  const port = Number(process.env.HIVEMIND_PORT ?? '4310');
  const operatorToken = process.env.HIVEMIND_OPERATOR_TOKEN ?? 'local-development-only';
  const workerToken = process.env.HIVEMIND_WORKER_TOKEN ?? 'local-worker-only';
  // Optional. Absent: no agent token is accepted and the Model Factory agent uses the operator token as before.
  const agentToken = process.env.HIVEMIND_AGENT_TOKEN?.trim() || undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HIVEMIND_PORT');
  if (!['127.0.0.1','localhost','::1'].includes(host) &&
      (operatorToken.length < 24 || workerToken.length < 24 || operatorToken === 'local-development-only' || workerToken === 'local-worker-only')) {
    throw new Error('Non-loopback binding requires two distinct custom tokens of at least 24 characters');
  }
  let repository: RepositoryPolicy | undefined;
  if (process.env.HIVEMIND_REPO_PATH) {
    try {
      const path = realpathSync(process.env.HIVEMIND_REPO_PATH);
      const git = (args: string[]) => execFileSync('git',['-C',path,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],env:configurationGitEnvironment()}).trim();
      const root = git(['rev-parse','--show-toplevel']);
      const baseCommit = git(['rev-parse','--verify','HEAD^{commit}']);
      if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error();
      const testCommand: unknown = JSON.parse(process.env.HIVEMIND_TEST_COMMAND ?? '["npm","run","check"]');
      if (!Array.isArray(testCommand) || testCommand.length < 1 || testCommand.length > 32 || !testCommand.every(arg=>typeof arg === 'string' && !!arg.trim() && arg.length <= 1000 && !arg.includes('\0'))) throw new Error();
      repository = {id:'local',name:basename(root),baseCommit,testProfile:'default',testCommand};
    } catch { throw new Error('Invalid local repository configuration.'); }
  }
  const dbPath = process.env.HIVEMIND_DB ?? 'data/hivemind.sqlite';
  const config = loadCloudflareConfig();
  if (config) cloudflare = createCloudControl({ dbPath, policy: config.policy, port: createCloudPort(config), executionScope: configurationScope(config) });
  const autonomousCloudProxy=config?createAutonomousCloudProxy(config,{localTokens:[operatorToken,workerToken,...(agentToken?[agentToken]:[])]}):undefined;
  const checks = loadCloudWorkflowChecks(config);
  const workflows = config && checks ? createCloudWorkflowControl(dbPath,
    createHash('sha256').update(JSON.stringify({scope:configurationScope(config),checks})).digest('hex'),
    createCloudWorkflowPort(config,checks)) : undefined;
  // SNS notifications (issue #20): enabled when the operator configured a topic.
  const notifyTopicArn = process.env.HIVEMIND_NOTIFY_TOPIC_ARN?.trim();
  const notifications = notifyTopicArn
    ? new NotificationGate(createAwsSnsNotifier({ topicArn: notifyTopicArn, credentials: createEcsTaskCredentialsProvider(), redact: [operatorToken, workerToken, ...(agentToken ? [agentToken] : [])] }))
    : undefined;
  const computeOrchestratorFactory = createAwsComputeOrchestratorFactory(notifications);
  const deliveryOrchestratorFactory = createAwsDeliveryOrchestratorFactory(port, [operatorToken, workerToken, ...(agentToken ? [agentToken] : [])], notifications);
  const computeAutoPublishRepoPrefixes = (process.env.HIVEMIND_COMPUTE_AUTO_PUBLISH_REPO_PREFIXES ?? process.env.HIVEMIND_MF_AUTO_PUBLISH_REPO_PREFIXES ?? '')
    .split(',').map((p) => p.trim()).filter((p) => /^[A-Za-z0-9][A-Za-z0-9_.-]*\/$/.test(p));
  const deliveryAutoMergeRepositories = (process.env.HIVEMIND_DELIVERY_AUTO_MERGE_REPOS ?? '')
    .split(',').map((r) => r.trim()).filter((r) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r));
  const computeBudgetCapMicros = (process.env.HIVEMIND_COMPUTE_BUDGET_CAP_MICROS ?? process.env.HIVEMIND_MF_BUDGET_CAP_MICROS)
    ? Number(process.env.HIVEMIND_COMPUTE_BUDGET_CAP_MICROS ?? process.env.HIVEMIND_MF_BUDGET_CAP_MICROS)
    : undefined;
  const computeWakePollMs = (process.env.HIVEMIND_COMPUTE_WAKE_POLL_MS ?? process.env.HIVEMIND_MF_WAKE_POLL_MS)
    ? Number(process.env.HIVEMIND_COMPUTE_WAKE_POLL_MS ?? process.env.HIVEMIND_MF_WAKE_POLL_MS)
    : computeOrchestratorFactory
      ? 60_000
      : undefined;

  const dsqlEndpoint = process.env.HIVEMIND_DSQL_ENDPOINT?.trim();
  const dsqlRegion = process.env.HIVEMIND_DSQL_REGION?.trim() || process.env.HIVEMIND_AWS_REGION?.trim() || 'ap-northeast-2';
  const dsqlUser = process.env.HIVEMIND_DSQL_USER?.trim() || undefined;
  if (dsqlUser !== undefined && !/^[a-z][a-z0-9_]{1,62}$/.test(dsqlUser)) {
    throw new Error('HIVEMIND_DSQL_USER must be a lowercase database role name');
  }
  const dsqlManageSchema = process.env.HIVEMIND_DSQL_MANAGE_SCHEMA?.trim() !== 'false';
  const dsqlAccess = { ...(dsqlUser ? { user: dsqlUser } : {}), manageSchema: dsqlManageSchema };
  const collabRepo = dsqlEndpoint
    ? new DsqlCollaborationRepository({
        endpoint: dsqlEndpoint,
        region: dsqlRegion,
        allowedRegions: [dsqlRegion],
        credentials: createEcsTaskCredentialsProvider(),
        ...dsqlAccess,
      })
    : undefined;
  if (collabRepo) {
    console.log(JSON.stringify({ event: 'hivemind.control_plane.aurora_dsql_enabled', dsqlEndpoint, dsqlRegion, dsqlUser: dsqlUser ?? 'admin', manageSchema: dsqlManageSchema }));
  }

  let computeRepository: DsqlComputeRepository | undefined;
  const computeStorage = (process.env.HIVEMIND_COMPUTE_STORAGE ?? process.env.HIVEMIND_MF_STORAGE)?.trim();
  if (computeStorage !== undefined && computeStorage !== 'sqlite' && computeStorage !== 'aurora-dsql') {
    throw new Error('HIVEMIND_COMPUTE_STORAGE must be sqlite or aurora-dsql');
  }
  if (computeStorage === 'aurora-dsql') {
    if (!dsqlEndpoint) throw new Error('HIVEMIND_COMPUTE_STORAGE=aurora-dsql requires HIVEMIND_DSQL_ENDPOINT');
    computeRepository = new DsqlComputeRepository({
      endpoint: dsqlEndpoint,
      region: dsqlRegion,
      allowedRegions: [dsqlRegion],
      credentials: createEcsTaskCredentialsProvider(),
      ...dsqlAccess,
    });
    const localHistory = new SqliteComputeRepository(dbPath);
    try {
      const importedJobs = await importComputeHistoryIfEmpty(localHistory, computeRepository);
      console.log(JSON.stringify({ event: 'hivemind.control_plane.compute_dsql_enabled', dsqlRegion, importedJobs }));
    } finally {
      await localHistory.close();
    }
  }

  let projectRepository: DsqlProjectRepository | undefined;
  const projectStorage = (process.env.HIVEMIND_PROJECTS_STORAGE ?? (dsqlEndpoint && (computeStorage === 'aurora-dsql' || process.env.HIVEMIND_DELIVERY_STORAGE?.trim() === 'aurora-dsql') ? 'aurora-dsql' : undefined))?.trim();
  if (projectStorage === 'aurora-dsql' && dsqlEndpoint) {
    projectRepository = new DsqlProjectRepository({
      endpoint: dsqlEndpoint,
      region: dsqlRegion,
      allowedRegions: [dsqlRegion],
      credentials: createEcsTaskCredentialsProvider(),
      ...dsqlAccess,
    });
    const localProjects = new SqliteProjectRepository(dbPath);
    try {
      const importedProjects = await importProjectHistoryIfEmpty(localProjects, projectRepository);
      console.log(JSON.stringify({ event: 'hivemind.control_plane.projects_dsql_enabled', dsqlRegion, importedProjects }));
    } finally {
      await localProjects.close();
    }
  }

  // Same switch for the SW delivery task store: HIVEMIND_DELIVERY_STORAGE=aurora-dsql.
  // Autonomy triggers (issue #20) keep their state in Aurora DSQL whenever delivery tasks do, so a Spot
  // replacement neither forgets a disabled trigger nor sends a second task.
  let autonomyRepository: DsqlAutonomyTriggerRepository | undefined;
  if (process.env.HIVEMIND_DELIVERY_STORAGE?.trim() === 'aurora-dsql' && dsqlEndpoint) {
    autonomyRepository = new DsqlAutonomyTriggerRepository({ endpoint: dsqlEndpoint, region: dsqlRegion, allowedRegions: [dsqlRegion], credentials: createEcsTaskCredentialsProvider(), ...dsqlAccess });
  }
  const autonomyDispatcherFactory = createAwsAutonomyDispatcherFactory();
  const autonomyTickMs = Number(process.env.HIVEMIND_AUTONOMY_TICK_MS ?? '60000');

  let deliveryRepository: DsqlDeliveryRepository | undefined;
  const deliveryStorage = process.env.HIVEMIND_DELIVERY_STORAGE?.trim();
  if (deliveryStorage !== undefined && deliveryStorage !== 'sqlite' && deliveryStorage !== 'aurora-dsql') {
    throw new Error('HIVEMIND_DELIVERY_STORAGE must be sqlite or aurora-dsql');
  }
  if (deliveryStorage === 'aurora-dsql') {
    if (!dsqlEndpoint) throw new Error('HIVEMIND_DELIVERY_STORAGE=aurora-dsql requires HIVEMIND_DSQL_ENDPOINT');
    deliveryRepository = new DsqlDeliveryRepository({
      endpoint: dsqlEndpoint,
      region: dsqlRegion,
      allowedRegions: [dsqlRegion],
      credentials: createEcsTaskCredentialsProvider(),
      ...dsqlAccess,
    });
    const localDeliveryHistory = new SqliteDeliveryRepository(dbPath);
    try {
      const importedTasks = await importHistoryIfEmpty(localDeliveryHistory, deliveryRepository);
      console.log(JSON.stringify({ event: 'hivemind.control_plane.delivery_dsql_enabled', dsqlRegion, importedTasks }));
    } finally {
      await localDeliveryHistory.close();
    }
  }

  const collabOrchestratorFactory = (service: AgentCollabService) => {
    const region = process.env.HIVEMIND_AWS_REGION?.trim();
    const bucket = process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim();
    const clusterArn = process.env.HIVEMIND_ECS_CLUSTER_ARN?.trim();
    const workerTaskDef = process.env.HIVEMIND_AI_WORKER_TASK_DEF?.trim();
    const verifierTaskDef = process.env.HIVEMIND_VERIFIER_TASK_DEF?.trim();
    const subnets = (process.env.HIVEMIND_WORKER_SUBNETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const securityGroups = (process.env.HIVEMIND_WORKER_SECURITY_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const detectedIp = detectPrivateVpcIpv4();
    const workerControlUrl = process.env.HIVEMIND_CONTROL_API_URL?.trim() || (detectedIp ? `http://${detectedIp}:${port}` : `http://127.0.0.1:${port}`);
    const collabPrimarySpoke: AwsSpokeRegionConfig | undefined =
      region && bucket && clusterArn && workerTaskDef && verifierTaskDef && subnets.length && securityGroups.length
        ? {
            region,
            clusterArn,
            workerTaskDefinition: workerTaskDef,
            verifierTaskDefinition: verifierTaskDef,
            subnets,
            securityGroups,
            assignPublicIp: process.env.HIVEMIND_WORKER_ASSIGN_PUBLIC_IP === 'ENABLED' ? 'ENABLED' : 'DISABLED',
            controlApiUrl: workerControlUrl,
            allowVpcInternalHttp: process.env.HIVEMIND_ALLOW_VPC_INTERNAL_HTTP === 'true',
            artifactsBucket: bucket,
          }
        : undefined;
    // Fan-out covers the Seoul Hub plus every spoke listed in HIVEMIND_AWS_SPOKES_JSON.
    const ecsDriver = collabPrimarySpoke
      ? new AwsMultiRegionEcsDriver({
          primaryRegion: collabPrimarySpoke.region,
          spokes: [collabPrimarySpoke, ...loadExtraSpokes(collabPrimarySpoke)],
          credentials: createEcsTaskCredentialsProvider(),
        })
      : undefined;
    return new CollabOrchestrator({
      service,
      controlApiUrl: `http://127.0.0.1:${port}`,
      workerToken,
      redactSecrets: [operatorToken, workerToken, ...(agentToken ? [agentToken] : [])],
      spotFeed: createSpotPlacementFeedPort({
        feedUrl: process.env.HIVEMIND_SPOT_FEED_URL?.trim() || DEFAULT_SPOT_FEED_URL,
      }),
      ...(ecsDriver
        ? {
            workerLauncher: {
              launchCollabWorker: (input, signal) =>
                ecsDriver.launchCollabWorker(
                  {
                    sessionId: input.sessionId,
                    subtaskId: input.subtaskId,
                    agentId: input.agentId,
                    provider: input.provider,
                    targetRegion: input.targetRegion,
                    targetAzId: input.targetAzId,
                  },
                  signal,
                ),
              configuredRegions: () => ecsDriver.configuredRegions(),
              describeWorker: (taskArn, signal) => ecsDriver.describeTask(taskArn, signal),
              stopWorker: (taskArn) => ecsDriver.stop(taskArn),
            },
          }
        : {}),
    });
  };

  const agentCredentials = createAgentCredentialsOptions();
  app = buildApp({dbPath,operatorToken,workerToken,nativeReporterToken:process.env.HIVEMIND_NATIVE_REPORTER_TOKEN,repository,cloudflare,workflows,autonomousCloudProxy,deliveryOrchestratorFactory,computeOrchestratorFactory,computeBudgetCapMicros,computeWakePollMs,...(deliveryAutoMergeRepositories.length ? { deliveryAutoMergeRepositories } : {}),...(computeAutoPublishRepoPrefixes.length ? { computeAutoPublishRepoPrefixes } : {}),...(computeRepository ? { computeRepository } : {}),...(projectRepository ? { projectRepository } : {}),...(deliveryRepository ? { deliveryRepository } : {}),collabRepo,collabOrchestratorFactory,...(agentCredentials ? { agentCredentials } : {}),...(agentToken ? { agentToken } : {}),...(notifications ? { notifications } : {}),autonomy:{...(autonomyRepository ? { repository: autonomyRepository } : {}),...(autonomyDispatcherFactory ? { dispatcherFactory: autonomyDispatcherFactory, tickMs: autonomyTickMs } : {}),hooks:autonomyHooks}});
  const address = await app.listen({host,port});
  console.log(`HIVEMIND control service: ${address}`);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app!.close(); });
} catch (error) {
  console.error(error instanceof Error && startupErrors.has(error.message) ? error.message : 'Unable to start HIVEMIND dashboard.');
  try { if (app) await app.close(); else await cloudflare?.close(); } catch { /* Startup errors stay scrubbed. */ }
  process.exitCode = 1;
}
