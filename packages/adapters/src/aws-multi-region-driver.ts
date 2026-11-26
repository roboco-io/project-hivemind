import type { AwsSpokeRegionConfig, RegionPlacementDecision } from '../../contracts/src/multi-region.js';
import {
  AwsEcsFargateSpotDriver,
  type AwsEcsCredentials,
  type LaunchEcsWorkloadInput,
  type EcsTaskStatus,
} from './aws-ecs-driver.js';
import { assertAwsRegion } from './autonomous-aws-region.js';

export interface AwsMultiRegionDriverConfig {
  primaryRegion: string;
  spokes: AwsSpokeRegionConfig[];
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface MultiRegionLaunchInput extends LaunchEcsWorkloadInput {
  targetRegion?: string;
  targetAzId?: string | null;
}

/**
 * Multi-region ECS Fargate Spot router.
 * Maintains a strict registry of explicitly configured regional spokes (Seoul primary + approved spokes)
 * and routes RunTask / StopTask to the exact region and AZ subnet chosen by core Spot placement policy.
 */
export class AwsMultiRegionEcsDriver {
  readonly primaryRegion: string;
  private readonly drivers = new Map<string, AwsEcsFargateSpotDriver>();
  private readonly spokeConfigs = new Map<string, AwsSpokeRegionConfig>();
  private readonly allowedRegions: string[];

  constructor(private readonly config: AwsMultiRegionDriverConfig) {
    this.allowedRegions = config.spokes.map((s) => s.region);
    assertAwsRegion(config.primaryRegion, this.allowedRegions);
    this.primaryRegion = config.primaryRegion;

    for (const spoke of config.spokes) {
      if (this.drivers.has(spoke.region)) {
        throw new Error(`Duplicate AWS spoke region configuration: ${spoke.region}`);
      }
      this.spokeConfigs.set(spoke.region, spoke);
      this.drivers.set(spoke.region, this.createRegionalDriver(spoke, spoke.subnets));
    }
  }

  private createRegionalDriver(spoke: AwsSpokeRegionConfig, subnets: string[]): AwsEcsFargateSpotDriver {
    return new AwsEcsFargateSpotDriver({
      region: spoke.region,
      allowedRegions: this.allowedRegions,
      clusterArn: spoke.clusterArn,
      workerTaskDefinition: spoke.workerTaskDefinition,
      verifierTaskDefinition: spoke.verifierTaskDefinition,
      workerContainerName: spoke.workerContainerName,
      verifierContainerName: spoke.verifierContainerName,
      subnets,
      securityGroups: spoke.securityGroups,
      assignPublicIp: spoke.assignPublicIp,
      controlApiUrl: spoke.controlApiUrl,
      allowVpcInternalHttp: spoke.allowVpcInternalHttp,
      artifactsBucket: spoke.artifactsBucket,
      allowOnDemandFallback: spoke.allowOnDemandFallback,
      credentials: this.config.credentials,
      fetchImpl: this.config.fetchImpl,
      now: this.config.now,
    });
  }

  configuredRegions(): string[] {
    return [...this.drivers.keys()];
  }

  async launchWorkload(
    input: MultiRegionLaunchInput,
    signal?: AbortSignal,
  ): Promise<{ taskArn: string; region: string; azId: string | null }> {
    const region = input.targetRegion ?? this.primaryRegion;
    const baseSpoke = this.spokeConfigs.get(region);
    const baseDriver = this.drivers.get(region);
    if (!baseSpoke || !baseDriver) {
      throw new Error(`AWS spoke region is not configured: ${region}`);
    }

    const pinnedSubnet = input.targetAzId ? baseSpoke.subnetByAzId?.[input.targetAzId] : undefined;
    const driver = pinnedSubnet ? this.createRegionalDriver(baseSpoke, [pinnedSubnet]) : baseDriver;
    const launched = await driver.launchWorkload(input, signal);
    return { taskArn: launched.taskArn, region, azId: input.targetAzId ?? null };
  }

  /**
   * Launches one collaboration worker in the requested region. Throws when the region has no configured
   * spoke, so a caller can never start a worker in a region the operator did not register.
   */
  async launchCollabWorker(
    input: {
      sessionId: string;
      subtaskId: string;
      agentId: string;
      provider: 'claude' | 'codex';
      targetRegion?: string;
      targetAzId?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<{ taskArn: string; region: string }> {
    const region = input.targetRegion ?? this.primaryRegion;
    const baseSpoke = this.spokeConfigs.get(region);
    const baseDriver = this.drivers.get(region);
    if (!baseSpoke || !baseDriver) {
      throw new Error(`AWS spoke region is not configured: ${region}`);
    }
    const pinnedSubnet = input.targetAzId ? baseSpoke.subnetByAzId?.[input.targetAzId] : undefined;
    const driver = pinnedSubnet ? this.createRegionalDriver(baseSpoke, [pinnedSubnet]) : baseDriver;
    return driver.launchCollabWorker(
      { sessionId: input.sessionId, subtaskId: input.subtaskId, agentId: input.agentId, provider: input.provider },
      signal,
    );
  }

  /** Routes to the region named in the task ARN. Returns `null` when ECS no longer knows the task. */
  async describeTask(taskArn: string, signal?: AbortSignal): Promise<EcsTaskStatus | null> {
    const region = /^arn:aws:ecs:([a-z]{2}-[a-z]+-\d+):/.exec(taskArn)?.[1] ?? this.primaryRegion;
    const driver = this.drivers.get(region);
    if (!driver) throw new Error(`Cannot describe task in unconfigured AWS region: ${region}`);
    return driver.describeTask(taskArn, signal);
  }

  async stop(externalRunId: string): Promise<void> {
    const arnRegionMatch = /^arn:aws:ecs:([a-z]{2}-[a-z]+-\d+):/.exec(externalRunId);
    const region = arnRegionMatch?.[1] ?? this.primaryRegion;
    const driver = this.drivers.get(region);
    if (!driver) {
      throw new Error(`Cannot stop task in unconfigured AWS region: ${region}`);
    }
    await driver.stop(externalRunId);
  }
}

export function buildPlacementOverrides(decision: RegionPlacementDecision): {
  targetRegion: string;
  targetAzId: string | null;
} {
  return {
    targetRegion: decision.selectedRegion,
    targetAzId: decision.selectedAzId,
  };
}
