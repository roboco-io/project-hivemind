import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_dsql as dsql,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_efs as efs,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { assertAwsRegion } from '../../../packages/adapters/src/autonomous-aws-region.ts';
import { bundleLambda } from './bundle-lambda.ts';

export interface AwsRuntimeConfig {
  /**
   * When true, the Control Plane and the TTL Guard Lambda connect to Aurora DSQL with restricted database
   * roles (`hm_control_plane`, `hm_ttl_guard`) and IAM action dsql:DbConnect, and they stop issuing DDL.
   * Run scripts/aws-dsql-apply-roles.ts as admin BEFORE deploying with this flag; otherwise the services
   * cannot connect. Default false: both connect as `admin` (dsql:DbConnectAdmin).
   */
  restrictedDsqlRoles?: boolean;
  /**
   * Where the Control Plane keeps the Model Factory ledger. 'aurora-dsql' sets HIVEMIND_MF_STORAGE so the
   * ledger lives in the Seoul DSQL cluster instead of the EFS SQLite file. Default: 'sqlite'.
   */
  modelFactoryStorage?: 'sqlite' | 'aurora-dsql';
  /** Where the Control Plane keeps SW delivery tasks. 'aurora-dsql' sets HIVEMIND_DELIVERY_STORAGE. Default: 'sqlite'. */
  deliveryStorage?: 'sqlite' | 'aurora-dsql';
  /**
   * Spoke regions whose ECS clusters the Control Plane may run, stop and describe tasks in. For each region
   * the Control Plane also gets iam:PassRole on that spoke's three fixed-name task roles.
   */
  spokeRegions?: string[];
  /** JSON array of spoke configurations, passed to the Control Plane as HIVEMIND_AWS_SPOKES_JSON. No secrets. */
  spokesJson?: string;
  /**
   * JSON registry of per-region Model Factory network and AMI defaults, passed to the Control Plane as
   * HIVEMIND_MF_REGION_NETWORKS_JSON. Contains resource IDs only, never secrets.
   */
  modelFactoryRegionNetworksJson?: string;
  accountId: string;
  region: string;
  allowedRegions?: string[];
  resourcePrefix: string;
  workerCpu?: number;
  workerMemoryMiB?: number;
  verifierCpu?: number;
  verifierMemoryMiB?: number;
  ephemeralStorageGiB?: number;
  allowOnDemandFallback?: boolean;
  controlPlaneDesiredCount?: number;
}

export class AwsRuntimeStack extends Stack {
  readonly artifactsBucket: s3.Bucket;
  readonly cluster: ecs.Cluster;
  readonly controlPlaneRole: iam.Role;
  readonly aiWorkerRole: iam.Role;
  readonly verifierRole: iam.Role;
  readonly trainingInstanceRole: iam.Role;
  readonly trainingInstanceProfile: iam.CfnInstanceProfile;
  readonly agentCredentialsParentRole: iam.Role;
  readonly operatorTokenSecret: secretsmanager.Secret;
  readonly workerTokenSecret: secretsmanager.Secret;
  readonly modelAuthSecret: secretsmanager.Secret;
  readonly githubDraftPrSecret: secretsmanager.Secret;
  readonly hfReleaseTokenSecret: secretsmanager.Secret;
  readonly collabDsqlCluster: dsql.CfnCluster;
  readonly modelFactoryTtlGuardFn: lambda.Function;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { configuration: AwsRuntimeConfig; fixture?: boolean },
  ) {
    super(scope, id, props);
    const cfg = props.configuration;
    assertAwsRegion(cfg.region, cfg.allowedRegions);
    if (
      !/^\d{12}$/.test(cfg.accountId) ||
      (cfg.accountId === '111111111111' && props.fixture !== true) ||
      this.account !== cfg.accountId ||
      this.region !== cfg.region ||
      !/^[a-z][a-z0-9-]{2,31}$/.test(cfg.resourcePrefix)
    ) {
      throw new Error('Explicit AWS runtime deployment configuration required');
    }

    const prefix = cfg.resourcePrefix;
    const spokeRegions = [...new Set(cfg.spokeRegions ?? [])];
    for (const spokeRegion of spokeRegions) {
      if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(spokeRegion) || spokeRegion === cfg.region) {
        throw new Error(`Invalid spoke region for Control Plane permissions: ${spokeRegion}`);
      }
    }
    const workerCpu = cfg.workerCpu ?? 4096;
    const workerMemoryMiB = cfg.workerMemoryMiB ?? 8192;
    const verifierCpu = cfg.verifierCpu ?? 4096;
    const verifierMemoryMiB = cfg.verifierMemoryMiB ?? 8192;
    const ephemeralStorageGiB = cfg.ephemeralStorageGiB ?? 50;
    if (ephemeralStorageGiB < 21 || ephemeralStorageGiB > 200) {
      throw new Error('Fargate ephemeralStorageGiB must be within 21..200');
    }

    const artifactKey = new kms.Key(this, 'ArtifactsKey', {
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description: `HIVEMIND ${prefix} S3 bundles, patches, and encrypted sessions key`,
    });

    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `${prefix}-${cfg.accountId}-${cfg.region}-artifacts`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: artifactKey,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'expire-bundles', prefix: 'bundles/', expiration: Duration.days(14) },
        { id: 'expire-sessions', prefix: 'sessions/', expiration: Duration.days(30) },
        // Training instances write here; the Control Plane copies checked artifacts to models/ on receipt.
        { id: 'expire-training-staging', prefix: 'staging/', expiration: Duration.days(14) },
      ],
    });

    // NAT-free, zero-public-ingress VPC ($0 NAT Gateway, $0 EIP, $0 ALB):
    // - Public subnets give outbound internet access to ECR/S3/SSM/model endpoints with ZERO public inbound rules.
    // - Operator reaches Control Plane strictly via AWS SSM Port Forwarding (IAM-authenticated encrypted tunnel).
    // - Isolated subnets (no internet route) host EFS SQLite mount targets (port 2049 from Control Plane SG only).
    const vpc = new ec2.Vpc(this, 'RuntimeVpc', {
      availabilityZones: [`${cfg.region}a`, `${cfg.region}c`],
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const efsSg = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc,
      description: `HIVEMIND ${prefix} EFS SQLite security group (Control Plane only)`,
      allowAllOutbound: false,
    });

    const controlPlaneFs = new efs.FileSystem(this, 'ControlPlaneData', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: efsSg,
      encrypted: true,
      kmsKey: artifactKey,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const controlPlaneAccessPoint = controlPlaneFs.addAccessPoint('ControlPlaneAccessPoint', {
      path: '/hivemind-data',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '0750' },
    });

    const controlPlaneRepo = new ecr.Repository(this, 'ControlPlaneRepo', {
      repositoryName: `${prefix}-control-plane`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const workerRepo = new ecr.Repository(this, 'WorkerRepo', {
      repositoryName: `${prefix}-worker`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const verifierRepo = new ecr.Repository(this, 'VerifierRepo', {
      repositoryName: `${prefix}-verifier`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Separate auto-generated Secrets Manager tokens enforce strict operator vs worker role boundary.
    this.operatorTokenSecret = new secretsmanager.Secret(this, 'OperatorTokenSecret', {
      secretName: `${prefix}/operator-token`,
      encryptionKey: artifactKey,
      removalPolicy: RemovalPolicy.RETAIN,
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
      description: 'HIVEMIND Control Plane operator Bearer token (Control Plane only)',
    });

    this.workerTokenSecret = new secretsmanager.Secret(this, 'WorkerTokenSecret', {
      secretName: `${prefix}/worker-token`,
      encryptionKey: artifactKey,
      removalPolicy: RemovalPolicy.RETAIN,
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
      description: 'HIVEMIND worker Bearer token (distinct from operator token)',
    });

    // Separate external secrets enforce 3-way trust boundary: AI worker never sees GitHub secret; Verifier sees neither.
    this.modelAuthSecret = new secretsmanager.Secret(this, 'ModelSubscriptionAuthSecret', {
      secretName: `${prefix}/model-subscription-auth`,
      encryptionKey: artifactKey,
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'Sealed Codex/Claude subscription auth for AI worker tasks only',
    });

    this.githubDraftPrSecret = new secretsmanager.Secret(this, 'GithubDraftPrSecret', {
      secretName: `${prefix}/github-draft-pr`,
      encryptionKey: artifactKey,
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'Scoped GitHub token for trusted Draft PR publisher only (branch prefix + PRs)',
    });

    this.hfReleaseTokenSecret = new secretsmanager.Secret(this, 'HfReleaseTokenSecret', {
      secretName: `${prefix}/hf-release-token`,
      encryptionKey: artifactKey,
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'Scoped Hugging Face write token for Control Plane trusted model release publisher ONLY (never workers)',
    });

    // Amazon Aurora DSQL serverless distributed PostgreSQL cluster ($0/hr idle, scales to 0 DPUs)
    // storing multi-agent collaboration sessions, DAG subtasks, shared communication board, and work logs.
    this.collabDsqlCluster = new dsql.CfnCluster(this, 'CollabDsqlCluster', {
      deletionProtectionEnabled: false,
      tags: [
        { key: 'Name', value: `${prefix}-collab-dsql` },
        { key: 'hivemind:managed-by', value: 'hivemind-runtime' },
      ],
    });

    this.cluster = new ecs.Cluster(this, 'RuntimeCluster', {
      clusterName: `${prefix}-cluster`,
      vpc,
      enableFargateCapacityProviders: true,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    this.cluster.addDefaultCapacityProviderStrategy(
      cfg.allowOnDemandFallback
        ? [
            { capacityProvider: 'FARGATE_SPOT', weight: 4, base: 0 },
            { capacityProvider: 'FARGATE', weight: 1, base: 0 },
          ]
        : [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }],
    );

    const logGroup = new logs.LogGroup(this, 'RuntimeLogs', {
      logGroupName: `/hivemind/${prefix}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Dedicated execution roles per task family prevent cross-role secret injection at ECS startup.
    const controlPlaneExecRole = new iam.Role(this, 'ControlPlaneExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    this.operatorTokenSecret.grantRead(controlPlaneExecRole);
    this.workerTokenSecret.grantRead(controlPlaneExecRole);

    const workerExecRole = new iam.Role(this, 'WorkerExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    this.workerTokenSecret.grantRead(workerExecRole);

    // 1. Control Plane Role: uploads pinned bundles/acceptance tests, dispatches ECS tasks, publishes Draft PRs,
    // and supports AWS SSM port forwarding (ECS Exec). Explicitly NEVER granted access to modelAuthSecret.
    this.controlPlaneRole = new iam.Role(this, 'ControlPlaneTaskRole', {
      roleName: `${prefix}-control-plane-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    controlPlaneFs.grant(
      this.controlPlaneRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    );
    this.artifactsBucket.grantReadWrite(this.controlPlaneRole, 'bundles/*');
    this.artifactsBucket.grantReadWrite(this.controlPlaneRole, 'acceptance/*');
    this.artifactsBucket.grantRead(this.controlPlaneRole, 'patches/*');
    this.artifactsBucket.grantRead(this.controlPlaneRole, 'attestations/*');
    this.artifactsBucket.grantReadWrite(this.controlPlaneRole, 'models/*');
    this.artifactsBucket.grantRead(this.controlPlaneRole, 'staging/*');
    this.githubDraftPrSecret.grantRead(this.controlPlaneRole);
    this.hfReleaseTokenSecret.grantRead(this.controlPlaneRole);
    // Aurora DSQL IAM authentication for Control Plane ONLY (workers communicate strictly through Control Plane HTTP API).
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: cfg.restrictedDsqlRoles ? ['dsql:DbConnect'] : ['dsql:DbConnectAdmin', 'dsql:DbConnect'],
        resources: [this.collabDsqlCluster.attrResourceArn],
      }),
    );
    // Scoped EC2 Spot Model Factory orchestration across allowed regions (no stack redeploy per model).
    // TerminateInstances is strictly conditioned on hivemind:managed-by=hivemind-model-factory.
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ec2:DescribeImages', 'ec2:DescribeSubnets', 'ec2:GetSpotPlacementScores', 'ec2:RunInstances', 'ec2:CreateTags'],
        resources: ['*'],
      }),
    );
    // Latest-AMI lookup reads AWS-owned public SSM parameters only (empty account field in the ARN).
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: ['arn:aws:ssm:*::parameter/aws/service/*'],
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'ec2:ResourceTag/hivemind:managed-by': 'hivemind-model-factory' },
        },
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks'],
        resources: ['*'],
        conditions: {
          ArnEquals: {
            'ecs:cluster': [
              this.cluster.clusterArn,
              ...spokeRegions.map((r) => `arn:aws:ecs:${r}:${cfg.accountId}:cluster/${prefix}-${r}-cluster`),
            ],
          },
        },
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:TagResource'],
        resources: [
          `arn:aws:ecs:${cfg.region}:${cfg.accountId}:task/${prefix}-cluster/*`,
          ...spokeRegions.map((r) => `arn:aws:ecs:${r}:${cfg.accountId}:task/${prefix}-${r}-cluster/*`),
        ],
      }),
    );
    if (spokeRegions.length > 0) {
      // Spoke task roles have fixed names (see AwsComputeSpokeStack), so PassRole names them exactly.
      this.controlPlaneRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: spokeRegions.flatMap((r) =>
            ['worker-exec-role', 'ai-worker-role', 'verifier-role'].map(
              (suffix) => `arn:aws:iam::${cfg.accountId}:role/${prefix}-${r}-${suffix}`,
            ),
          ),
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      );
    }
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }),
    );

    // 2. AI Worker Role: reads bundle/session, writes patch/session, reads model subscription secret ONLY.
    // Explicitly NEVER granted operatorTokenSecret, GitHub secret, acceptance write, or ECS orchestration.
    this.aiWorkerRole = new iam.Role(this, 'AiWorkerTaskRole', {
      roleName: `${prefix}-ai-worker-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.artifactsBucket.grantRead(this.aiWorkerRole, 'bundles/*');
    this.artifactsBucket.grantReadWrite(this.aiWorkerRole, 'sessions/*');
    this.artifactsBucket.grantPut(this.aiWorkerRole, 'patches/*');
    this.modelAuthSecret.grantRead(this.aiWorkerRole);

    // 3. Verifier Role: reads bundle, pinned acceptance tests, and patch; writes verification attestation receipt only.
    // Explicitly NEVER granted operatorTokenSecret, modelAuthSecret, githubDraftPrSecret, or write access to bundles/sessions/patches.
    this.verifierRole = new iam.Role(this, 'VerifierTaskRole', {
      roleName: `${prefix}-verifier-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.artifactsBucket.grantRead(this.verifierRole, 'bundles/*');
    this.artifactsBucket.grantRead(this.verifierRole, 'acceptance/*');
    this.artifactsBucket.grantRead(this.verifierRole, 'patches/*');
    this.artifactsBucket.grantPut(this.verifierRole, 'attestations/*');
    // Model Factory release verification: the verifier reads artifacts and pinned inputs, never writes them.
    this.artifactsBucket.grantRead(this.verifierRole, 'models/*');

    // 4. Model Factory EC2 Training Instance Role & Instance Profile:
    // Reads models/*/inputs/*; writes only staging/<role id>:<instance id>/*, so one job cannot overwrite
    // another job's artifacts. The Control Plane copies checked artifacts to the job prefix. + KMS key usage.
    // Explicitly ZERO Secrets Manager, ZERO EC2 control, ZERO delivery bundles/patches/attestations access.
    this.trainingInstanceRole = new iam.Role(this, 'ModelFactoryTrainingInstanceRole', {
      roleName: `${prefix}-mf-training-instance-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    this.trainingInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadModelFactoryInputsOnly',
        actions: ['s3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('models/*/inputs/*')],
      }),
    );
    this.trainingInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PutOwnInstanceStagingOnly',
        actions: ['s3:PutObject'],
        // For an EC2 instance role session aws:userid is "<role id>:<instance id>".
        resources: [this.artifactsBucket.arnForObjects('staging/${aws:userid}/*')],
      }),
    );
    this.trainingInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyWritingModelsDirectly',
        effect: iam.Effect.DENY,
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [this.artifactsBucket.arnForObjects('models/*')],
      }),
    );
    this.trainingInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KmsAccessForArtifactsBucket',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        resources: [artifactKey.keyArn],
      }),
    );
    this.trainingInstanceProfile = new iam.CfnInstanceProfile(this, 'ModelFactoryTrainingInstanceProfile', {
      instanceProfileName: `${prefix}-mf-training-instance-profile`,
      roles: [this.trainingInstanceRole.roleName],
    });

    // Control Plane may pass ONLY ModelFactoryTrainingInstanceRole to ec2.amazonaws.com.
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.trainingInstanceRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      }),
    );

    // 5. Parent role for agent credentials (issue #19). The Control Plane assumes it and calls
    // GetScopedCredentials with a purpose policy, so every issued credential is the intersection of this
    // role and that policy. This role holds only the union of the purpose templates.
    this.agentCredentialsParentRole = new iam.Role(this, 'AgentCredentialsParentRole', {
      roleName: `${prefix}-agent-credentials-parent-role`,
      assumedBy: new iam.ArnPrincipal(this.controlPlaneRole.roleArn),
      maxSessionDuration: Duration.hours(1),
      description: 'Parent session for scoped agent credentials; never handed to an agent',
    });
    this.agentCredentialsParentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ScopeDownAtMost900Seconds',
        actions: ['sts:GetScopedCredentials'],
        resources: ['*'],
        conditions: { NumericLessThanEquals: { 'sts:DurationSeconds': 900 } },
      }),
    );
    this.agentCredentialsParentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SpotPlacementRead',
        actions: ['ec2:GetSpotPlacementScores', 'ec2:DescribeSpotPriceHistory', 'ec2:DescribeInstanceTypeOfferings'],
        resources: ['*'],
      }),
    );
    this.agentCredentialsParentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ModelInputsUpload',
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('models/*/inputs/*')],
      }),
    );
    this.agentCredentialsParentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ModelArtifactsRead',
        actions: ['s3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('models/*/runs/*')],
      }),
    );
    this.agentCredentialsParentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListModelPrefixes',
        actions: ['s3:ListBucket'],
        resources: [this.artifactsBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['models/*/inputs/*', 'models/*/runs/*'] } },
      }),
    );
    this.agentCredentialsParentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ArtifactsKey',
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [artifactKey.keyArn],
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [this.agentCredentialsParentRole.roleArn],
      }),
    );

    const arm64Platform = {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    const aiWorkerTaskDef = new ecs.FargateTaskDefinition(this, 'AiWorkerTaskDef', {
      family: `${prefix}-ai-worker`,
      cpu: workerCpu,
      memoryLimitMiB: workerMemoryMiB,
      ephemeralStorageGiB,
      runtimePlatform: arm64Platform,
      executionRole: workerExecRole,
      taskRole: this.aiWorkerRole,
    });
    aiWorkerTaskDef.addContainer('ai-worker', {
      image: ecs.ContainerImage.fromEcrRepository(workerRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ai-worker', logGroup }),
      // 120s stopTimeout matches Fargate Spot SIGTERM grace window so workers can flush encrypted checkpoints.
      stopTimeout: Duration.seconds(120),
      environment: {
        HIVEMIND_AWS_REGION: cfg.region,
        HIVEMIND_ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        HIVEMIND_MODEL_AUTH_SECRET_ARN: this.modelAuthSecret.secretArn,
        HIVEMIND_SPOT_FLUSH_TIMEOUT_MS: '90000',
      },
      secrets: {
        HIVEMIND_WORKER_TOKEN: ecs.Secret.fromSecretsManager(this.workerTokenSecret),
      },
    });

    const verifierTaskDef = new ecs.FargateTaskDefinition(this, 'VerifierTaskDef', {
      family: `${prefix}-verifier`,
      cpu: verifierCpu,
      memoryLimitMiB: verifierMemoryMiB,
      ephemeralStorageGiB,
      runtimePlatform: arm64Platform,
      executionRole: workerExecRole,
      taskRole: this.verifierRole,
    });
    verifierTaskDef.addContainer('verifier', {
      image: ecs.ContainerImage.fromEcrRepository(verifierRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'verifier', logGroup }),
      stopTimeout: Duration.seconds(30),
      environment: {
        HIVEMIND_AWS_REGION: cfg.region,
        HIVEMIND_ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
      },
      secrets: {
        HIVEMIND_WORKER_TOKEN: ecs.Secret.fromSecretsManager(this.workerTokenSecret),
      },
    });

    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [workerExecRole.roleArn, this.aiWorkerRole.roleArn, this.verifierRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );

    // Worker/Verifier SG: ZERO inbound rules; outbound HTTPS (ECR/S3/model) + Control Plane 4310 only.
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc,
      description: `HIVEMIND ${prefix} Fargate Spot worker/verifier SG (zero inbound)`,
      allowAllOutbound: false,
    });
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow outbound HTTPS to AWS ECR/S3/KMS and model endpoints');

    // Control Plane SG: ZERO public CIDR inbound rules!
    // Operator connects over AWS SSM encrypted tunnel (outbound HTTPS from SSM agent); VPC workers connect on 4310.
    const controlPlaneSg = new ec2.SecurityGroup(this, 'ControlPlaneSecurityGroup', {
      vpc,
      description: `HIVEMIND ${prefix} Control Plane SG (zero public inbound; SSM tunnel + VPC workers only)`,
      allowAllOutbound: true,
    });
    controlPlaneSg.addIngressRule(workerSg, ec2.Port.tcp(4310), 'Allow VPC Fargate Spot workers/verifiers to call control-plane');
    workerSg.addEgressRule(controlPlaneSg, ec2.Port.tcp(4310), 'Allow workers/verifiers to reach control-plane');
    efsSg.addIngressRule(controlPlaneSg, ec2.Port.tcp(2049), 'Allow control-plane EFS SQLite mount only');

    const controlPlaneTaskDef = new ecs.FargateTaskDefinition(this, 'ControlPlaneTaskDef', {
      family: `${prefix}-control-plane`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: arm64Platform,
      executionRole: controlPlaneExecRole,
      taskRole: this.controlPlaneRole,
      volumes: [
        {
          name: 'sqlite-data',
          efsVolumeConfiguration: {
            fileSystemId: controlPlaneFs.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: controlPlaneAccessPoint.accessPointId,
              iam: 'ENABLED',
            },
          },
        },
      ],
    });
    const cpContainer = controlPlaneTaskDef.addContainer('control-plane', {
      image: ecs.ContainerImage.fromEcrRepository(controlPlaneRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'control-plane', logGroup }),
      linuxParameters: new ecs.LinuxParameters(this, 'ControlPlaneLinuxParams', { initProcessEnabled: true }),
      environment: {
        HIVEMIND_HOST: '0.0.0.0',
        HIVEMIND_PORT: '4310',
        HIVEMIND_DB: '/data/hivemind.sqlite',
        HIVEMIND_AWS_REGION: cfg.region,
        HIVEMIND_ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        HIVEMIND_ECS_CLUSTER: this.cluster.clusterName,
        HIVEMIND_ECS_CLUSTER_ARN: this.cluster.clusterArn,
        HIVEMIND_AI_WORKER_TASK_DEF: aiWorkerTaskDef.taskDefinitionArn,
        HIVEMIND_VERIFIER_TASK_DEF: verifierTaskDef.taskDefinitionArn,
        HIVEMIND_WORKER_SUBNETS: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
        HIVEMIND_WORKER_SECURITY_GROUPS: workerSg.securityGroupId,
        HIVEMIND_WORKER_ASSIGN_PUBLIC_IP: 'ENABLED',
        HIVEMIND_GITHUB_SECRET_ARN: this.githubDraftPrSecret.secretArn,
        HIVEMIND_HF_RELEASE_SECRET_ARN: this.hfReleaseTokenSecret.secretArn,
        HIVEMIND_DSQL_ENDPOINT: `${this.collabDsqlCluster.attrIdentifier}.dsql.${cfg.region}.on.aws`,
        HIVEMIND_DSQL_REGION: cfg.region,
        ...(cfg.restrictedDsqlRoles ? { HIVEMIND_DSQL_USER: 'hm_control_plane', HIVEMIND_DSQL_MANAGE_SCHEMA: 'false' } : {}),
        HIVEMIND_MF_INSTANCE_PROFILE_ARN: this.trainingInstanceProfile.attrArn,
        HIVEMIND_MF_TRAINING_ROLE_ID: this.trainingInstanceRole.roleId,
        HIVEMIND_AGENT_CREDENTIALS_PARENT_ROLE_ARN: this.agentCredentialsParentRole.roleArn,
        HIVEMIND_AGENT_CREDENTIAL_PURPOSES: 'spot-placement-read,model-inputs-upload,model-artifacts-read',
        HIVEMIND_ARTIFACTS_KMS_KEY_ARN: artifactKey.keyArn,
        HIVEMIND_MF_ALLOWED_REGIONS: 'ap-northeast-2,us-east-2,us-east-1,us-west-2,ap-northeast-1',
        HIVEMIND_MF_BUDGET_CAP_MICROS: '500000000',
        ...(cfg.modelFactoryStorage === 'aurora-dsql' ? { HIVEMIND_MF_STORAGE: 'aurora-dsql' } : {}),
        ...(cfg.deliveryStorage === 'aurora-dsql' ? { HIVEMIND_DELIVERY_STORAGE: 'aurora-dsql' } : {}),
        ...(cfg.spokesJson ? { HIVEMIND_AWS_SPOKES_JSON: cfg.spokesJson } : {}),
        ...(cfg.modelFactoryRegionNetworksJson
          ? { HIVEMIND_MF_REGION_NETWORKS_JSON: cfg.modelFactoryRegionNetworksJson }
          : {}),
        HIVEMIND_ALLOW_VPC_INTERNAL_HTTP: 'true',
      },
      secrets: {
        HIVEMIND_OPERATOR_TOKEN: ecs.Secret.fromSecretsManager(this.operatorTokenSecret),
        HIVEMIND_WORKER_TOKEN: ecs.Secret.fromSecretsManager(this.workerTokenSecret),
      },
      readonlyRootFilesystem: false,
    });
    cpContainer.addMountPoints({ containerPath: '/data', sourceVolume: 'sqlite-data', readOnly: false });
    cpContainer.addPortMappings({ containerPort: 4310, protocol: ecs.Protocol.TCP });

    const controlPlaneService = new ecs.FargateService(this, 'ControlPlaneService', {
      serviceName: `${prefix}-control-plane`,
      cluster: this.cluster,
      taskDefinition: controlPlaneTaskDef,
      desiredCount: cfg.controlPlaneDesiredCount ?? 1,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [controlPlaneSg],
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1, base: 1 }],
    });

    // Autonomous $0-idle Multi-Region Model Factory TTL Guard (runs every 5 min even when ControlPlaneService desiredCount=0).
    // Fails closed: terminates any hivemind:managed-by=hivemind-model-factory instance past hivemind:expires-at or missing the tag.
    const ttlGuardRole = new iam.Role(this, 'ModelFactoryTtlGuardRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    ttlGuardRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );
    ttlGuardRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'ec2:ResourceTag/hivemind:managed-by': 'hivemind-model-factory' },
        },
      }),
    );

    // With the DSQL ledger, the guard also settles the terminated job's cost, so it needs to connect.
    const guardSettlesInDsql = cfg.modelFactoryStorage === 'aurora-dsql';
    if (guardSettlesInDsql) {
      ttlGuardRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [cfg.restrictedDsqlRoles ? 'dsql:DbConnect' : 'dsql:DbConnectAdmin'],
          resources: [this.collabDsqlCluster.attrResourceArn],
        }),
      );
    }

    this.modelFactoryTtlGuardFn = new lambda.Function(this, 'ModelFactoryTtlGuardFn', {
      functionName: `${prefix}-mf-ttl-guard`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(bundleLambda('mf-ttl-guard.ts')),
      timeout: Duration.seconds(60),
      memorySize: 256,
      role: ttlGuardRole,
      environment: {
        HIVEMIND_GUARD_REGIONS: 'ap-northeast-2,us-east-2,us-east-1,us-west-2,ap-northeast-1',
        ...(guardSettlesInDsql
          ? {
              HIVEMIND_MF_STORAGE: 'aurora-dsql',
              HIVEMIND_DSQL_ENDPOINT: `${this.collabDsqlCluster.attrIdentifier}.dsql.${cfg.region}.on.aws`,
              HIVEMIND_DSQL_REGION: cfg.region,
              ...(cfg.restrictedDsqlRoles ? { HIVEMIND_DSQL_USER: 'hm_ttl_guard' } : {}),
            }
          : {}),
      },
      description: 'Autonomous $0-idle multi-region TTL Guard sweeping expired hivemind-model-factory EC2 Spot instances',
    });

    new events.Rule(this, 'ModelFactoryTtlGuardSchedule', {
      ruleName: `${prefix}-mf-ttl-guard-5m`,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(this.modelFactoryTtlGuardFn)],
    });

    new CfnOutput(this, 'ClusterArn', { value: this.cluster.clusterArn });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'ArtifactsBucketName', { value: this.artifactsBucket.bucketName });
    new CfnOutput(this, 'ControlPlaneServiceName', { value: controlPlaneService.serviceName });
    new CfnOutput(this, 'ControlPlaneTaskDefArn', { value: controlPlaneTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'AiWorkerTaskDefArn', { value: aiWorkerTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'VerifierTaskDefArn', { value: verifierTaskDef.taskDefinitionArn });
    new CfnOutput(this, 'ControlPlaneSecurityGroupId', { value: controlPlaneSg.securityGroupId });
    new CfnOutput(this, 'WorkerSecurityGroupId', { value: workerSg.securityGroupId });
    new CfnOutput(this, 'OperatorTokenSecretArn', { value: this.operatorTokenSecret.secretArn });
    new CfnOutput(this, 'ModelAuthSecretArn', { value: this.modelAuthSecret.secretArn });
    new CfnOutput(this, 'GithubDraftPrSecretArn', { value: this.githubDraftPrSecret.secretArn });
    new CfnOutput(this, 'HfReleaseTokenSecretArn', { value: this.hfReleaseTokenSecret.secretArn });
    new CfnOutput(this, 'DsqlClusterArn', { value: this.collabDsqlCluster.attrResourceArn });
    new CfnOutput(this, 'DsqlClusterEndpoint', {
      value: `${this.collabDsqlCluster.attrIdentifier}.dsql.${cfg.region}.on.aws`,
    });
    new CfnOutput(this, 'ModelFactoryTrainingInstanceRoleArn', { value: this.trainingInstanceRole.roleArn });
    new CfnOutput(this, 'ModelFactoryTrainingInstanceProfileArn', { value: this.trainingInstanceProfile.attrArn });
    new CfnOutput(this, 'ModelFactoryTtlGuardFunctionName', { value: this.modelFactoryTtlGuardFn.functionName });
    // IAM role ARNs that scripts/aws-dsql-apply-roles.ts maps to the restricted database roles.
    new CfnOutput(this, 'ControlPlaneTaskRoleArn', { value: this.controlPlaneRole.roleArn });
    new CfnOutput(this, 'ModelFactoryTtlGuardRoleArn', { value: ttlGuardRole.roleArn });
    new CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
    });
  }
}
