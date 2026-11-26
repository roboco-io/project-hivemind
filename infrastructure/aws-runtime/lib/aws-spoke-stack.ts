import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { assertAwsRegion } from '../../../packages/adapters/src/autonomous-aws-region.ts';

export interface AwsSpokeStackConfig {
  accountId: string;
  region: string;
  allowedRegions: string[];
  primaryRegion: string;
  resourcePrefix: string;
  /** Non-overlapping VPC CIDR per spoke region (e.g. '10.1.0.0/16' for us-east-2, '10.2.0.0/16' for us-east-1). */
  vpcCidr: string;
  /** Primary Hub (Seoul) S3 artifacts bucket ARN for cross-region bundle/patch/attestation access. */
  primaryArtifactsBucketArn: string;
  /** Primary Hub KMS key ARN encrypting S3 artifacts and replicated secrets. */
  primaryArtifactKeyArn: string;
  /** Primary Hub ECR repository ARNs/URIs (ECS Fargate pulls ARM64 images cross-region or from replicated repos). */
  workerImageUri: string;
  verifierImageUri: string;
  /** Replicated secret ARNs in THIS spoke region (NEVER OperatorTokenSecret or GithubDraftPrSecret). */
  workerTokenSecretArn: string;
  modelAuthSecretArn: string;
  /** Peered Seoul Hub VPC CIDR (e.g. '10.0.0.0/16') so spoke workers can reach Control Plane TCP 4310 privately. */
  primaryHubVpcCidr: string;
  workerCpu?: number;
  workerMemoryMiB?: number;
  verifierCpu?: number;
  verifierMemoryMiB?: number;
  ephemeralStorageGiB?: number;
}

/**
 * Stateless, $0/hr-idle regional Compute Spoke stack.
 * Hosts ONLY ECS FARGATE_SPOT workers and verifiers — NEVER Control Plane, EFS SQLite,
 * OperatorTokenSecret, or GithubDraftPrSecret (those remain strictly in the Seoul Primary Hub).
 */
export class AwsComputeSpokeStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly aiWorkerRole: iam.Role;
  readonly verifierRole: iam.Role;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { configuration: AwsSpokeStackConfig; fixture?: boolean },
  ) {
    super(scope, id, props);
    const cfg = props.configuration;
    assertAwsRegion(cfg.region, cfg.allowedRegions);
    assertAwsRegion(cfg.primaryRegion, cfg.allowedRegions);
    if (
      !/^\d{12}$/.test(cfg.accountId) ||
      (cfg.accountId === '111111111111' && props.fixture !== true) ||
      this.account !== cfg.accountId ||
      this.region !== cfg.region ||
      !/^[a-z][a-z0-9-]{2,31}$/.test(cfg.resourcePrefix) ||
      cfg.region === cfg.primaryRegion
    ) {
      throw new Error('Explicit multi-region AWS spoke configuration required (spoke region must differ from primaryRegion)');
    }

    const prefix = `${cfg.resourcePrefix}-${cfg.region}`;
    const workerCpu = cfg.workerCpu ?? 4096;
    const workerMemoryMiB = cfg.workerMemoryMiB ?? 8192;
    const verifierCpu = cfg.verifierCpu ?? 4096;
    const verifierMemoryMiB = cfg.verifierMemoryMiB ?? 8192;
    const ephemeralStorageGiB = cfg.ephemeralStorageGiB ?? 50;

    // NAT-free, EIP-free, zero-inbound public-subnet VPC ($0/hr fixed cost).
    const vpc = new ec2.Vpc(this, 'SpokeVpc', {
      ipAddresses: ec2.IpAddresses.cidr(cfg.vpcCidr),
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    this.cluster = new ecs.Cluster(this, 'SpokeCluster', {
      clusterName: `${prefix}-cluster`,
      vpc,
      enableFargateCapacityProviders: true,
    });
    this.cluster.addDefaultCapacityProviderStrategy([{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }]);

    const logGroup = new logs.LogGroup(this, 'SpokeLogs', {
      logGroupName: `/hivemind/${prefix}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const primaryBucket = s3.Bucket.fromBucketArn(this, 'PrimaryArtifactsBucket', cfg.primaryArtifactsBucketArn);
    const workerTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ReplicatedWorkerTokenSecret',
      cfg.workerTokenSecretArn,
    );
    const modelAuthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ReplicatedModelAuthSecret',
      cfg.modelAuthSecretArn,
    );

    // Fixed name so the Seoul Control Plane role can be granted iam:PassRole on exactly this role.
    const workerExecRole = new iam.Role(this, 'SpokeWorkerExecutionRole', {
      roleName: `${prefix}-worker-exec-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    workerTokenSecret.grantRead(workerExecRole);
    workerExecRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [cfg.primaryArtifactKeyArn],
      }),
    );

    // Spoke AI Worker Role: reads primary S3 bundles/sessions, writes patches/sessions, reads replicated model auth ONLY.
    // Explicitly NEVER granted OperatorTokenSecret, GithubDraftPrSecret, or ECS orchestration.
    this.aiWorkerRole = new iam.Role(this, 'SpokeAiWorkerTaskRole', {
      roleName: `${prefix}-ai-worker-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    primaryBucket.grantRead(this.aiWorkerRole, 'bundles/*');
    primaryBucket.grantReadWrite(this.aiWorkerRole, 'sessions/*');
    primaryBucket.grantPut(this.aiWorkerRole, 'patches/*');
    modelAuthSecret.grantRead(this.aiWorkerRole);
    this.aiWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [cfg.primaryArtifactKeyArn],
      }),
    );

    // Spoke Verifier Role: reads bundles/acceptance/patches, writes attestations/* ONLY; ZERO secrets.
    this.verifierRole = new iam.Role(this, 'SpokeVerifierTaskRole', {
      roleName: `${prefix}-verifier-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    primaryBucket.grantRead(this.verifierRole, 'bundles/*');
    primaryBucket.grantRead(this.verifierRole, 'acceptance/*');
    primaryBucket.grantRead(this.verifierRole, 'patches/*');
    primaryBucket.grantPut(this.verifierRole, 'attestations/*');
    this.verifierRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [cfg.primaryArtifactKeyArn],
      }),
    );

    const arm64Platform = {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'SpokeAiWorkerTaskDef', {
      family: `${prefix}-ai-worker`,
      cpu: workerCpu,
      memoryLimitMiB: workerMemoryMiB,
      ephemeralStorageGiB,
      runtimePlatform: arm64Platform,
      executionRole: workerExecRole,
      taskRole: this.aiWorkerRole,
    });
    workerTaskDef.addContainer('ai-worker', {
      image: ecs.ContainerImage.fromRegistry(cfg.workerImageUri),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ai-worker', logGroup }),
      stopTimeout: Duration.seconds(120),
      environment: {
        HIVEMIND_AWS_REGION: cfg.primaryRegion,
        HIVEMIND_SPOKE_REGION: cfg.region,
        HIVEMIND_MODEL_AUTH_SECRET_ARN: cfg.modelAuthSecretArn,
        HIVEMIND_SPOT_FLUSH_TIMEOUT_MS: '90000',
      },
      secrets: {
        HIVEMIND_WORKER_TOKEN: ecs.Secret.fromSecretsManager(workerTokenSecret),
      },
    });

    const verifierTaskDef = new ecs.FargateTaskDefinition(this, 'SpokeVerifierTaskDef', {
      family: `${prefix}-verifier`,
      cpu: verifierCpu,
      memoryLimitMiB: verifierMemoryMiB,
      ephemeralStorageGiB,
      runtimePlatform: arm64Platform,
      executionRole: workerExecRole,
      taskRole: this.verifierRole,
    });
    verifierTaskDef.addContainer('verifier', {
      image: ecs.ContainerImage.fromRegistry(cfg.verifierImageUri),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'verifier', logGroup }),
      stopTimeout: Duration.seconds(30),
      environment: {
        HIVEMIND_AWS_REGION: cfg.primaryRegion,
        HIVEMIND_SPOKE_REGION: cfg.region,
      },
      secrets: {
        HIVEMIND_WORKER_TOKEN: ecs.Secret.fromSecretsManager(workerTokenSecret),
      },
    });

    // Zero inbound rules; outbound HTTPS (ECR/S3/model) + peered Seoul Hub VPC CIDR TCP 4310 only.
    const workerSg = new ec2.SecurityGroup(this, 'SpokeWorkerSecurityGroup', {
      vpc,
      description: `HIVEMIND ${prefix} Fargate Spot spoke worker SG (zero inbound)`,
      allowAllOutbound: false,
    });
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow outbound HTTPS to AWS APIs and model endpoints');
    workerSg.addEgressRule(
      ec2.Peer.ipv4(cfg.primaryHubVpcCidr),
      ec2.Port.tcp(4310),
      'Allow outbound TCP 4310 to peered primary Hub Control Plane VPC',
    );

    // Silence unused import lint while keeping ECR type reference documented for future local-mirror option.
    void ecr;

    new CfnOutput(this, 'SpokeRegion', { value: cfg.region });
    new CfnOutput(this, 'SpokeClusterArn', { value: this.cluster.clusterArn });
    new CfnOutput(this, 'SpokeAiWorkerTaskDefArn', { value: workerTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'SpokeVerifierTaskDefArn', { value: verifierTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'SpokeWorkerSecurityGroupId', { value: workerSg.securityGroupId });
    new CfnOutput(this, 'SpokePublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
  }
}
