import {createAutonomousCloudProxy} from './autonomous-cloud-proxy.js';
import { buildApp } from './app.js';
import { configurationGitEnvironment, configurationScope, loadCloudflareConfig, loadCloudWorkflowChecks } from './cloudflare-config.js';
import { DeliveryOrchestrator } from './delivery-orchestrator.js';
import { ModelFactoryOrchestrator, parseRegionNetworkRegistry } from './model-factory-orchestrator.js';
import { CollabOrchestrator } from './collab-orchestrator.js';
import { DsqlCollaborationRepository } from '../../../packages/adapters/src/aws-dsql.js';
import { DsqlModelFactoryRepository, importModelFactoryHistoryIfEmpty } from '../../../packages/adapters/src/aws-dsql-model-factory.js';
import { SqliteModelFactoryRepository } from '../../../packages/core/src/model-factory-repository.js';
import { DsqlDeliveryRepository } from '../../../packages/adapters/src/aws-dsql-delivery.js';
import { SqliteDeliveryRepository } from '../../../packages/core/src/delivery-repository.js';
import { importHistoryIfEmpty } from '../../../packages/core/src/document-repository.js';
import { AwsEc2SpotTrainer } from '../../../packages/adapters/src/aws-ec2-spot-trainer.js';
import { createTrustedHfReleasePublisher } from '../../../packages/adapters/src/model-factory-hf-publisher.js';
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
import type { ModelFactoryStore } from '../../../packages/core/src/model-factory.js';
import type { AgentCollabService } from '../../../packages/core/src/agent-collab.js';

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

function createAwsDeliveryOrchestratorFactory(port: number, extraRedactSecrets: string[]) {
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

function createAwsModelFactoryOrchestratorFactory() {
  const region = process.env.HIVEMIND_AWS_REGION?.trim();
  const bucket = process.env.HIVEMIND_ARTIFACTS_BUCKET?.trim();
  if (!region || !bucket) return undefined;

  const allowedRegions = (process.env.HIVEMIND_MF_ALLOWED_REGIONS ?? `${region},us-east-2,us-east-1,us-west-2,ap-northeast-1`)
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

  const regionNetworks = parseRegionNetworkRegistry(process.env.HIVEMIND_MF_REGION_NETWORKS_JSON, allowedRegions);
  const amiResolver = createAwsPublicAmiResolver({ allowedRegions, credentials });

  const defaultInstanceProfileArn = process.env.HIVEMIND_MF_INSTANCE_PROFILE_ARN?.trim() || undefined;
  const allowedInstanceProfileArns = (process.env.HIVEMIND_MF_ALLOWED_INSTANCE_PROFILE_ARNS ?? defaultInstanceProfileArn ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (store: ModelFactoryStore) =>
    new ModelFactoryOrchestrator({
      store,
      ec2,
      s3,
      artifactsBucket: bucket,
      artifactsRegion: region,
      ...(regionNetworks ? { regionNetworks, amiResolver } : {}),
      onPlacementAttempt: (attempt) =>
        console.log(JSON.stringify({ event: 'hivemind.model_factory.placement_attempt', ...attempt })),
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
  const autonomousCloudProxy=config?createAutonomousCloudProxy(config,{localTokens:[operatorToken,workerToken]}):undefined;
  const checks = loadCloudWorkflowChecks(config);
  const workflows = config && checks ? createCloudWorkflowControl(dbPath,
    createHash('sha256').update(JSON.stringify({scope:configurationScope(config),checks})).digest('hex'),
    createCloudWorkflowPort(config,checks)) : undefined;
  const deliveryOrchestratorFactory = createAwsDeliveryOrchestratorFactory(port, [operatorToken, workerToken]);
  const modelFactoryOrchestratorFactory = createAwsModelFactoryOrchestratorFactory();
  const modelFactoryBudgetCapMicros = process.env.HIVEMIND_MF_BUDGET_CAP_MICROS
    ? Number(process.env.HIVEMIND_MF_BUDGET_CAP_MICROS)
    : undefined;
  const modelFactoryWakePollMs = process.env.HIVEMIND_MF_WAKE_POLL_MS
    ? Number(process.env.HIVEMIND_MF_WAKE_POLL_MS)
    : modelFactoryOrchestratorFactory
      ? 60_000
      : undefined;

  const dsqlEndpoint = process.env.HIVEMIND_DSQL_ENDPOINT?.trim();
  const dsqlRegion = process.env.HIVEMIND_DSQL_REGION?.trim() || process.env.HIVEMIND_AWS_REGION?.trim() || 'ap-northeast-2';
  const collabRepo = dsqlEndpoint
    ? new DsqlCollaborationRepository({
        endpoint: dsqlEndpoint,
        region: dsqlRegion,
        allowedRegions: [dsqlRegion],
        credentials: createEcsTaskCredentialsProvider(),
      })
    : undefined;
  if (collabRepo) {
    console.log(JSON.stringify({ event: 'hivemind.control_plane.aurora_dsql_enabled', dsqlEndpoint, dsqlRegion }));
  }

  // The Model Factory ledger moves to Aurora DSQL only when HIVEMIND_MF_STORAGE=aurora-dsql is set. On the
  // first start with an empty DSQL ledger, the jobs and events of the local SQLite file are copied once.
  let modelFactoryRepository: DsqlModelFactoryRepository | undefined;
  const modelFactoryStorage = process.env.HIVEMIND_MF_STORAGE?.trim();
  if (modelFactoryStorage !== undefined && modelFactoryStorage !== 'sqlite' && modelFactoryStorage !== 'aurora-dsql') {
    throw new Error('HIVEMIND_MF_STORAGE must be sqlite or aurora-dsql');
  }
  if (modelFactoryStorage === 'aurora-dsql') {
    if (!dsqlEndpoint) throw new Error('HIVEMIND_MF_STORAGE=aurora-dsql requires HIVEMIND_DSQL_ENDPOINT');
    modelFactoryRepository = new DsqlModelFactoryRepository({
      endpoint: dsqlEndpoint,
      region: dsqlRegion,
      allowedRegions: [dsqlRegion],
      credentials: createEcsTaskCredentialsProvider(),
    });
    const localHistory = new SqliteModelFactoryRepository(dbPath);
    try {
      const importedJobs = await importModelFactoryHistoryIfEmpty(localHistory, modelFactoryRepository);
      console.log(JSON.stringify({ event: 'hivemind.control_plane.model_factory_dsql_enabled', dsqlRegion, importedJobs }));
    } finally {
      await localHistory.close();
    }
  }

  // Same switch for the SW delivery task store: HIVEMIND_DELIVERY_STORAGE=aurora-dsql.
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
      redactSecrets: [operatorToken, workerToken],
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
            },
          }
        : {}),
    });
  };

  app = buildApp({dbPath,operatorToken,workerToken,nativeReporterToken:process.env.HIVEMIND_NATIVE_REPORTER_TOKEN,repository,cloudflare,workflows,autonomousCloudProxy,deliveryOrchestratorFactory,modelFactoryOrchestratorFactory,modelFactoryBudgetCapMicros,modelFactoryWakePollMs,...(modelFactoryRepository ? { modelFactoryRepository } : {}),...(deliveryRepository ? { deliveryRepository } : {}),collabRepo,collabOrchestratorFactory});
  const address = await app.listen({host,port});
  console.log(`HIVEMIND control service: ${address}`);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app!.close(); });
} catch (error) {
  console.error(error instanceof Error && startupErrors.has(error.message) ? error.message : 'Unable to start HIVEMIND dashboard.');
  try { if (app) await app.close(); else await cloudflare?.close(); } catch { /* Startup errors stay scrubbed. */ }
  process.exitCode = 1;
}
