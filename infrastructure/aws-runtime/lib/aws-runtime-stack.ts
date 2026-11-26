import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
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

export interface AwsRuntimeConfig {
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
  readonly operatorTokenSecret: secretsmanager.Secret;
  readonly workerTokenSecret: secretsmanager.Secret;
  readonly modelAuthSecret: secretsmanager.Secret;
  readonly githubDraftPrSecret: secretsmanager.Secret;
  readonly hfReleaseTokenSecret: secretsmanager.Secret;
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
    this.githubDraftPrSecret.grantRead(this.controlPlaneRole);
    this.hfReleaseTokenSecret.grantRead(this.controlPlaneRole);
    // Scoped EC2 Spot Model Factory orchestration across allowed regions (no stack redeploy per model).
    // TerminateInstances is strictly conditioned on hivemind:managed-by=hivemind-model-factory.
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ec2:RunInstances', 'ec2:CreateTags'],
        resources: ['*'],
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
        conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
      }),
    );
    this.controlPlaneRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:TagResource'],
        resources: [`arn:aws:ecs:${cfg.region}:${cfg.accountId}:task/${prefix}-cluster/*`],
      }),
    );
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

    // 4. Model Factory EC2 Training Instance Role & Instance Profile:
    // Strictly scoped to reading models/*/inputs/* and writing models/* (excluding inputs/*) + KMS key usage.
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
        sid: 'PutModelFactoryOutputsOnly',
        actions: ['s3:PutObject'],
        resources: [this.artifactsBucket.arnForObjects('models/*')],
      }),
    );
    this.trainingInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyMutatingImmutableInputs',
        effect: iam.Effect.DENY,
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [this.artifactsBucket.arnForObjects('models/*/inputs/*')],
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
        HIVEMIND_MF_INSTANCE_PROFILE_ARN: this.trainingInstanceProfile.attrArn,
        HIVEMIND_MF_ALLOWED_REGIONS: 'ap-northeast-2,us-east-2,us-east-1,us-west-2,ap-northeast-1',
        HIVEMIND_MF_BUDGET_CAP_MICROS: '500000000',
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

    const ttlGuardCode = [
      "const crypto = require('node:crypto');",
      "const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');",
      "const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();",
      'function sign(region, body) {',
      "  const now = new Date().toISOString().replace(/[:-]|\\.\\d{3}/g, '');",
      "  const amzDate = now.slice(0, 15) + 'Z', dateStamp = now.slice(0, 8);",
      '  const host = `ec2.${region}.amazonaws.com`;',
      "  const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', host, 'x-amz-date': amzDate };",
      "  if (process.env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;",
      '  const keys = Object.keys(headers).sort();',
      "  const canon = ['POST', '/', '', keys.map((k) => `${k}:${headers[k]}\\n`).join(''), keys.join(';'), sha256(body)].join('\\n');",
      '  const scope = `${dateStamp}/${region}/ec2/aws4_request`;',
      "  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canon)].join('\\n');",
      "  const kSig = hmac(hmac(hmac(hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, dateStamp), region), 'ec2'), 'aws4_request');",
      '  headers.authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${keys.join(\';\')}, Signature=${crypto.createHmac(\'sha256\', kSig).update(sts, \'utf8\').digest(\'hex\')}`;',
      '  return headers;',
      '}',
      'async function ec2Call(region, params) {',
      "  const body = new URLSearchParams({ Version: '2016-11-15', ...params }).toString();",
      '  const res = await fetch(`https://ec2.${region}.amazonaws.com/`, { method: \'POST\', headers: sign(region, body), body });',
      '  const text = await res.text();',
      '  if (!res.ok) throw new Error(`EC2 ${region} ${params.Action} HTTP ${res.status}: ${text.slice(0, 200)}`);',
      '  return text;',
      '}',
      'function firstTag(xml, name) {',
      '  const o = `<${name}>`, c = `</${name}>`, s = xml.indexOf(o);',
      '  if (s === -1) return null;',
      '  const e = xml.indexOf(c, s + o.length);',
      '  return e === -1 ? null : xml.slice(s + o.length, e).trim();',
      '}',
      'function parseInstances(xml) {',
      '  const out = [];',
      "  for (const part of xml.split('<instancesSet>').slice(1)) {",
      "    const setXml = part.split('</instancesSet>')[0] || '';",
      '    let idx = 0;',
      '    while (idx < setXml.length) {',
      "      const start = setXml.indexOf('<item>', idx); if (start === -1) break;",
      '      let depth = 0, cur = start, end = -1;',
      '      while (cur < setXml.length) {',
      "        const no = setXml.indexOf('<item>', cur), nc = setXml.indexOf('</item>', cur);",
      '        if (nc === -1) break;',
      '        if (no !== -1 && no < nc) { depth++; cur = no + 6; } else { depth--; cur = nc + 7; if (depth === 0) { end = nc; break; } }',
      '      }',
      '      if (end === -1) break;',
      '      const item = setXml.slice(start + 6, end);',
      "      const id = firstTag(item, 'instanceId');",
      "      const tagXml = firstTag(item, 'tagSet') || '';",
      '      const tags = {};',
      "      for (const t of tagXml.split('<item>').slice(1)) { const k = firstTag(t, 'key'), v = firstTag(t, 'value'); if (k) tags[k] = v || ''; }",
      '      if (id) out.push({ id, tags });',
      '      idx = end + 7;',
      '    }',
      '  }',
      '  return out;',
      '}',
      'exports.handler = async () => {',
      "  const regions = (process.env.HIVEMIND_GUARD_REGIONS || 'ap-northeast-2,us-east-2').split(',').map((s) => s.trim()).filter(Boolean);",
      '  const nowMs = Date.now(), summary = [];',
      '  for (const region of regions) {',
      "    const xml = await ec2Call(region, { Action: 'DescribeInstances', 'Filter.1.Name': 'tag:hivemind:managed-by', 'Filter.1.Value.1': 'hivemind-model-factory', 'Filter.2.Name': 'instance-state-name', 'Filter.2.Value.1': 'pending', 'Filter.2.Value.2': 'running', 'Filter.2.Value.3': 'stopping', 'Filter.2.Value.4': 'stopped' });",
      '    const instances = parseInstances(xml);',
      '    const terminated = [];',
      '    for (const inst of instances) {',
      "      const exp = inst.tags['hivemind:expires-at'] || null;",
      '      const expMs = exp ? Date.parse(exp) : Number.NaN;',
      '      if (!Number.isFinite(expMs) || expMs <= nowMs) {',
      "        await ec2Call(region, { Action: 'TerminateInstances', 'InstanceId.1': inst.id });",
      '        terminated.push({ instanceId: inst.id, expiresAt: exp });',
      '      }',
      '    }',
      '    summary.push({ region, checked: instances.length, terminated });',
      '  }',
      "  console.log(JSON.stringify({ event: 'hivemind.mf_ttl_guard.sweep', summary }));",
      '  return { ok: true, summary };',
      '};',
    ].join('\n');

    this.modelFactoryTtlGuardFn = new lambda.Function(this, 'ModelFactoryTtlGuardFn', {
      functionName: `${prefix}-mf-ttl-guard`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(ttlGuardCode),
      timeout: Duration.seconds(30),
      memorySize: 128,
      role: ttlGuardRole,
      environment: {
        HIVEMIND_GUARD_REGIONS: 'ap-northeast-2,us-east-2,us-east-1,us-west-2,ap-northeast-1',
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
    new CfnOutput(this, 'ModelFactoryTrainingInstanceRoleArn', { value: this.trainingInstanceRole.roleArn });
    new CfnOutput(this, 'ModelFactoryTrainingInstanceProfileArn', { value: this.trainingInstanceProfile.attrArn });
    new CfnOutput(this, 'ModelFactoryTtlGuardFunctionName', { value: this.modelFactoryTtlGuardFn.functionName });
    new CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
    });
  }
}
