import {createAutonomousCloudProxy} from './autonomous-cloud-proxy.js';
import { buildApp } from './app.js';
import { configurationGitEnvironment, configurationScope, loadCloudflareConfig, loadCloudWorkflowChecks } from './cloudflare-config.js';
import { DeliveryOrchestrator } from './delivery-orchestrator.js';
import { ModelFactoryOrchestrator } from './model-factory-orchestrator.js';
import { AwsEc2SpotTrainer } from '../../../packages/adapters/src/aws-ec2-spot-trainer.js';
import { createTrustedHfReleasePublisher } from '../../../packages/adapters/src/model-factory-hf-publisher.js';
import { AwsEcsFargateSpotDriver } from '../../../packages/adapters/src/aws-ecs-driver.js';
import { AwsMultiRegionEcsDriver } from '../../../packages/adapters/src/aws-multi-region-driver.js';
import { createEcsTaskCredentialsProvider } from '../../../packages/adapters/src/aws-ecs-metadata-creds.js';
import { createAwsS3ArtifactsPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { createAwsSecretsManagerPort } from '../../../packages/adapters/src/aws-secrets-manager.js';
import { createSpotPlacementFeedPort, DEFAULT_SPOT_FEED_URL } from '../../../packages/adapters/src/spot-placement-feed.js';
import type { AwsSpokeRegionConfig } from '../../../packages/contracts/src/multi-region.js';
import { createCloudPort } from '../../../packages/adapters/src/cloudflare.js';
import { createCloudWorkflowPort } from '../../../packages/adapters/src/cloud-workflow.js';
import { createGitHubDraftPrPort } from '../../../packages/adapters/src/github-draft-pr.js';
import { createGitPushCommitMaterializer } from '../../../packages/adapters/src/github-git-push.js';
import { resolveGithubTokenForRepo } from '../../../packages/adapters/src/github-token-resolver.js';
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
  const extraSpokesRaw = process.env.HIVEMIND_AWS_SPOKES_JSON?.trim();
  const extraSpokes: AwsSpokeRegionConfig[] = extraSpokesRaw
    ? (JSON.parse(extraSpokesRaw) as AwsSpokeRegionConfig[])
    : [];
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
        const token = resolveGithubTokenForRepo(rawSecret, task.delivery.repository);
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

  return (store: ModelFactoryStore) =>
    new ModelFactoryOrchestrator({
      store,
      ec2,
      s3,
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
  app = buildApp({dbPath,operatorToken,workerToken,nativeReporterToken:process.env.HIVEMIND_NATIVE_REPORTER_TOKEN,repository,cloudflare,workflows,autonomousCloudProxy,deliveryOrchestratorFactory,modelFactoryOrchestratorFactory,modelFactoryBudgetCapMicros});
  const address = await app.listen({host,port});
  console.log(`HIVEMIND control service: ${address}`);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { void app!.close(); });
} catch (error) {
  console.error(error instanceof Error && startupErrors.has(error.message) ? error.message : 'Unable to start HIVEMIND dashboard.');
  try { if (app) await app.close(); else await cloudflare?.close(); } catch { /* Startup errors stay scrubbed. */ }
  process.exitCode = 1;
}
