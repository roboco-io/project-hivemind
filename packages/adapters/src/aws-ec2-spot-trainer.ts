import { createHash, createHmac } from 'node:crypto';
import type { Ec2InstanceLifecycleState } from '../../contracts/src/model-factory.js';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';
import { assertAwsRegion } from './autonomous-aws-region.js';

export const HIVEMIND_MF_MANAGED_TAG_KEY = 'hivemind:managed-by';
export const HIVEMIND_MF_MANAGED_TAG_VALUE = 'hivemind-model-factory';

export interface LaunchSpotInstanceInput {
  jobId: string;
  modelId: string;
  region: string;
  availabilityZoneId?: string;
  instanceType: string;
  amiId: string;
  maxHourlyPriceUsd: number;
  expiresAtIso: string;
  subnetId?: string;
  securityGroupIds?: string[];
  instanceProfileArn?: string;
  userDataScript?: string;
  /** Size of the root volume in GiB. Omitted: the AMI's own size. */
  rootVolumeGb?: number;
  extraTags?: Record<string, string>;
}

export interface LaunchedSpotInstance {
  region: string;
  availabilityZone: string | null;
  instanceId: string;
  instanceType: string;
  amiId: string;
  state: Ec2InstanceLifecycleState;
}

export interface DescribedSpotInstance {
  region: string;
  instanceId: string;
  state: Ec2InstanceLifecycleState;
  availabilityZone: string | null;
  launchTime: string | null;
  stateReason: string | null;
  /** When the instance left the running state, from EC2's state transition reason. Null when EC2 gives no time. */
  stateTransitionTime?: string | null;
  tags: Record<string, string>;
}

export interface ExpiredSpotSweepResult {
  region: string;
  checkedCount: number;
  terminated: {
    instanceId: string;
    jobId: string | null;
    expiresAt: string | null;
    reason: string;
  }[];
}

export interface Ec2SpotTrainerPort {
  launchSpotInstance(input: LaunchSpotInstanceInput, signal?: AbortSignal): Promise<LaunchedSpotInstance>;
  describeInstance(region: string, instanceId: string, signal?: AbortSignal): Promise<DescribedSpotInstance>;
  terminateInstance(region: string, instanceId: string, signal?: AbortSignal): Promise<{ instanceId: string; state: Ec2InstanceLifecycleState }>;
  sweepExpiredSpotInstances(region: string, nowMs?: number, signal?: AbortSignal): Promise<ExpiredSpotSweepResult>;
  /** Maps each subnet to its AZ ID (for example `use2-az1`). Optional: without it subnets keep their listed order. */
  describeSubnetAzIds?(region: string, subnetIds: string[], signal?: AbortSignal): Promise<Record<string, string>>;
  /**
   * Current Spot placement scores for one instance type, per region (`azId` null) or per AZ.
   * Optional: without it the plan uses the feed only.
   */
  getSpotPlacementScores?(input: SpotPlacementScoreQuery, signal?: AbortSignal): Promise<LiveSpotPlacementScore[]>;
}

export interface SpotPlacementScoreQuery {
  /** Region whose EC2 endpoint answers; the scores cover `regions`. */
  endpointRegion: string;
  instanceType: string;
  regions: string[];
  singleAvailabilityZone: boolean;
}

export interface LiveSpotPlacementScore {
  region: string;
  azId: string | null;
  score: number;
}

/** Reads scores from an EC2 GetSpotPlacementScores response. */
export function parseSpotPlacementScores(xml: string): LiveSpotPlacementScore[] {
  const result: LiveSpotPlacementScore[] = [];
  for (const setBlock of extractTagBlocks(xml, 'spotPlacementScoreSet')) {
    for (const item of extractTagBlocks(setBlock, 'item')) {
      const region = firstTagValue(item, 'region');
      const score = Number(firstTagValue(item, 'score'));
      if (!region || !Number.isInteger(score) || score < 1 || score > 10) continue;
      result.push({ region, azId: firstTagValue(item, 'availabilityZoneId'), score });
    }
  }
  return result;
}

/** Reads subnet ID to AZ ID pairs from an EC2 DescribeSubnets response. */
export function parseSubnetAzIds(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const setBlock of extractTagBlocks(xml, 'subnetSet')) {
    // Drop nested sets (tagSet, ipv6CidrBlockAssociationSet, ...) so each remaining <item> is one subnet.
    const flat = setBlock.replace(/<([A-Za-z0-9]+Set)>[\s\S]*?<\/\1>/g, '');
    for (const item of extractTagBlocks(flat, 'item')) {
      const subnetId = firstTagValue(item, 'subnetId');
      const azId = firstTagValue(item, 'availabilityZoneId');
      if (subnetId && azId) result[subnetId] = azId;
    }
  }
  return result;
}

export interface AwsEc2SpotTrainerOptions {
  allowedRegions: string[];
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signAwsRequest(options: {
  service: string;
  region: string;
  host: string;
  contentType: string;
  extraHeaders?: Record<string, string>;
  body: string;
  credentials: AwsEcsCredentials;
  nowMs: number;
}): Record<string, string> {
  const iso = new Date(options.nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso.slice(0, 15) + 'Z';
  const dateStamp = iso.slice(0, 8);
  const payloadHash = sha256Hex(options.body);
  const headers: Record<string, string> = {
    'content-type': options.contentType,
    host: options.host,
    'x-amz-date': amzDate,
    ...(options.extraHeaders ?? {}),
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

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function firstTagValue(xml: string, tagName: string): string | null {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const end = xml.indexOf(close, start + open.length);
  if (end === -1) return null;
  return decodeXmlEntities(xml.slice(start + open.length, end).trim());
}

function extractTagBlocks(xml: string, tagName: string): string[] {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf(open, cursor);
    if (start === -1) break;
    const end = xml.indexOf(close, start + open.length);
    if (end === -1) break;
    blocks.push(xml.slice(start + open.length, end));
    cursor = end + close.length;
  }
  return blocks;
}

function normalizeEc2State(raw: string | null): Ec2InstanceLifecycleState {
  switch (raw) {
    case 'pending':
    case 'running':
    case 'stopping':
    case 'stopped':
    case 'shutting-down':
    case 'terminated':
      return raw;
    default:
      return 'unknown';
  }
}

/**
 * EC2 reports when an instance stopped running only inside a text field, for example
 * `User initiated (2026-11-27 02:23:56 GMT)`. Returns that time as ISO 8601, or null.
 */
export function parseStateTransitionTime(reason: string | null): string | null {
  const match = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(reason ?? '');
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function parseInstanceBlock(region: string, block: string): DescribedSpotInstance | null {
  const instanceId = firstTagValue(block, 'instanceId');
  if (!instanceId) return null;
  const stateBlock = firstTagValue(block, 'instanceState') ?? '';
  const state = normalizeEc2State(firstTagValue(stateBlock, 'name'));
  const placementBlock = firstTagValue(block, 'placement') ?? '';
  const availabilityZone = firstTagValue(placementBlock, 'availabilityZone');
  const launchTime = firstTagValue(block, 'launchTime');
  const stateReasonBlock = firstTagValue(block, 'stateReason') ?? '';
  const stateReason = firstTagValue(stateReasonBlock, 'message');
  const tagSetBlock = firstTagValue(block, 'tagSet') ?? '';
  const tags: Record<string, string> = {};
  for (const tagItem of extractTagBlocks(tagSetBlock, 'item')) {
    const k = firstTagValue(tagItem, 'key');
    const v = firstTagValue(tagItem, 'value');
    if (k !== null && v !== null) {
      tags[k] = v;
    }
  }
  return {
    region,
    instanceId,
    state,
    availabilityZone,
    launchTime,
    stateReason,
    stateTransitionTime: parseStateTransitionTime(firstTagValue(block, 'reason')),
    tags,
  };
}

function extractTopLevelInstances(region: string, xml: string): DescribedSpotInstance[] {
  const instancesSetBlocks = extractTagBlocks(xml, 'instancesSet');
  const results: DescribedSpotInstance[] = [];
  for (const setBlock of instancesSetBlocks) {
    // Walk top-level <item>...</item> blocks inside <instancesSet> handling nested <item> (e.g. tagSet/groupSet).
    let idx = 0;
    while (idx < setBlock.length) {
      const start = setBlock.indexOf('<item>', idx);
      if (start === -1) break;
      let depth = 0;
      let cursor = start;
      let end = -1;
      while (cursor < setBlock.length) {
        const nextOpen = setBlock.indexOf('<item>', cursor);
        const nextClose = setBlock.indexOf('</item>', cursor);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth += 1;
          cursor = nextOpen + 6;
        } else {
          depth -= 1;
          cursor = nextClose + 7;
          if (depth === 0) {
            end = nextClose;
            break;
          }
        }
      }
      if (end === -1) break;
      const itemXml = setBlock.slice(start + 6, end);
      const parsed = parseInstanceBlock(region, itemXml);
      if (parsed) results.push(parsed);
      idx = end + 7;
    }
  }
  return results;
}

export class AwsEc2SpotTrainer implements Ec2SpotTrainerPort {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: AwsEc2SpotTrainerOptions) {
    if (!options.allowedRegions.length) {
      throw new Error('AwsEc2SpotTrainer requires at least one allowedRegion');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async callEc2Query(
    region: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    assertAwsRegion(region, this.options.allowedRegions);
    const creds = await this.options.credentials();
    const host = `ec2.${region}.amazonaws.com`;
    const encoded = new URLSearchParams({
      Version: '2016-11-15',
      ...params,
    }).toString();

    const headers = signAwsRequest({
      service: 'ec2',
      region,
      host,
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: encoded,
      credentials: creds,
      nowMs: this.now(),
    });

    const response = await this.fetchImpl(`https://${host}/`, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: encoded,
      signal: signal ?? AbortSignal.timeout(20_000),
    });

    const xml = await response.text();
    if (!response.ok) {
      const code = firstTagValue(xml, 'Code') ?? `HTTP_${response.status}`;
      const message = firstTagValue(xml, 'Message') ?? xml.slice(0, 400);
      throw new Error(`AWS EC2 ${params.Action ?? 'request'} failed (${code}): ${message}`);
    }
    return xml;
  }

  async launchSpotInstance(input: LaunchSpotInstanceInput, signal?: AbortSignal): Promise<LaunchedSpotInstance> {
    const params: Record<string, string> = {
      Action: 'RunInstances',
      ImageId: input.amiId,
      InstanceType: input.instanceType,
      MinCount: '1',
      MaxCount: '1',
      'InstanceMarketOptions.MarketType': 'spot',
      'InstanceMarketOptions.SpotOptions.SpotInstanceType': 'one-time',
      'InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior': 'terminate',
      'InstanceMarketOptions.SpotOptions.MaxPrice': input.maxHourlyPriceUsd.toFixed(4),
      InstanceInitiatedShutdownBehavior: 'terminate',
      'TagSpecification.1.ResourceType': 'instance',
      'TagSpecification.1.Tag.1.Key': 'Name',
      'TagSpecification.1.Tag.1.Value': `hivemind-mf-${input.jobId}`,
      'TagSpecification.1.Tag.2.Key': HIVEMIND_MF_MANAGED_TAG_KEY,
      'TagSpecification.1.Tag.2.Value': HIVEMIND_MF_MANAGED_TAG_VALUE,
      'TagSpecification.1.Tag.3.Key': 'hivemind:job-id',
      'TagSpecification.1.Tag.3.Value': input.jobId,
      'TagSpecification.1.Tag.4.Key': 'hivemind:model-id',
      'TagSpecification.1.Tag.4.Value': input.modelId,
      'TagSpecification.1.Tag.5.Key': 'hivemind:expires-at',
      'TagSpecification.1.Tag.5.Value': input.expiresAtIso,
    };

    if (input.extraTags) {
      let tagIndex = 6;
      for (const [k, v] of Object.entries(input.extraTags)) {
        if (!k || !v || /[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) continue;
        params[`TagSpecification.1.Tag.${tagIndex}.Key`] = k;
        params[`TagSpecification.1.Tag.${tagIndex}.Value`] = v;
        tagIndex += 1;
      }
    }

    if (input.availabilityZoneId) {
      params['Placement.AvailabilityZoneId'] = input.availabilityZoneId;
    }
    if (input.subnetId) {
      params['NetworkInterface.1.DeviceIndex'] = '0';
      params['NetworkInterface.1.SubnetId'] = input.subnetId;
      params['NetworkInterface.1.AssociatePublicIpAddress'] = 'true';
      params['NetworkInterface.1.DeleteOnTermination'] = 'true';
      (input.securityGroupIds ?? []).forEach((sg, index) => {
        params[`NetworkInterface.1.SecurityGroupId.${index + 1}`] = sg;
      });
    } else if (input.securityGroupIds?.length) {
      input.securityGroupIds.forEach((sg, index) => {
        params[`SecurityGroupId.${index + 1}`] = sg;
      });
    }
    if (input.instanceProfileArn) {
      params['IamInstanceProfile.Arn'] = input.instanceProfileArn;
    }
    if (input.userDataScript !== undefined) {
      params.UserData = Buffer.from(input.userDataScript, 'utf8').toString('base64');
    }
    if (input.rootVolumeGb !== undefined) {
      // The root device name belongs to the AMI (/dev/xvda, /dev/sda1, ...), so it is read from the AMI.
      const imageXml = await this.callEc2Query(input.region, { Action: 'DescribeImages', 'ImageId.1': input.amiId }, signal);
      const rootDeviceName = firstTagValue(imageXml, 'rootDeviceName');
      if (!rootDeviceName) throw new Error(`AWS EC2 DescribeImages returned no root device for ${input.amiId} in ${input.region}`);
      params['BlockDeviceMapping.1.DeviceName'] = rootDeviceName;
      params['BlockDeviceMapping.1.Ebs.VolumeSize'] = String(input.rootVolumeGb);
      params['BlockDeviceMapping.1.Ebs.VolumeType'] = 'gp3';
      // The volume must not outlive the instance: nothing else would delete it or pay attention to it.
      params['BlockDeviceMapping.1.Ebs.DeleteOnTermination'] = 'true';
    }

    const xml = await this.callEc2Query(input.region, params, signal);
    const instances = extractTopLevelInstances(input.region, xml);
    const first = instances[0];
    if (!first) {
      throw new Error('AWS EC2 RunInstances returned no instanceId');
    }
    return {
      region: input.region,
      availabilityZone: first.availabilityZone,
      instanceId: first.instanceId,
      instanceType: input.instanceType,
      amiId: input.amiId,
      state: first.state,
    };
  }

  async describeSubnetAzIds(region: string, subnetIds: string[], signal?: AbortSignal): Promise<Record<string, string>> {
    if (subnetIds.length === 0) return {};
    const params: Record<string, string> = { Action: 'DescribeSubnets' };
    subnetIds.forEach((id, index) => {
      if (!/^subnet-[a-f0-9]{8,17}$/i.test(id)) throw new Error(`Invalid subnet ID: ${id}`);
      params[`SubnetId.${index + 1}`] = id;
    });
    return parseSubnetAzIds(await this.callEc2Query(region, params, signal));
  }

  async getSpotPlacementScores(input: SpotPlacementScoreQuery, signal?: AbortSignal): Promise<LiveSpotPlacementScore[]> {
    if (!/^[a-z0-9][a-z0-9.-]{2,39}$/.test(input.instanceType)) throw new Error(`Invalid instance type: ${input.instanceType}`);
    if (input.regions.length === 0 || input.regions.length > 10) throw new Error('GetSpotPlacementScores needs 1..10 regions');
    const params: Record<string, string> = {
      Action: 'GetSpotPlacementScores',
      'InstanceType.1': input.instanceType,
      TargetCapacity: '1',
      SingleAvailabilityZone: input.singleAvailabilityZone ? 'true' : 'false',
    };
    input.regions.forEach((region, index) => {
      if (!/^[a-z]{2}-[a-z]+-\d+$/.test(region)) throw new Error(`Invalid region: ${region}`);
      params[`RegionName.${index + 1}`] = region;
    });
    const scores = parseSpotPlacementScores(await this.callEc2Query(input.endpointRegion, params, signal));
    return input.singleAvailabilityZone ? scores.filter((s) => s.azId) : scores.map((s) => ({ ...s, azId: null }));
  }

  async describeInstance(region: string, instanceId: string, signal?: AbortSignal): Promise<DescribedSpotInstance> {
    const xml = await this.callEc2Query(
      region,
      {
        Action: 'DescribeInstances',
        'InstanceId.1': instanceId,
      },
      signal,
    );
    const instances = extractTopLevelInstances(region, xml);
    const found = instances.find((item) => item.instanceId === instanceId) ?? instances[0];
    if (!found) {
      throw new Error(`EC2 instance ${instanceId} not found in ${region}`);
    }
    return found;
  }

  async terminateInstance(
    region: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<{ instanceId: string; state: Ec2InstanceLifecycleState }> {
    const xml = await this.callEc2Query(
      region,
      {
        Action: 'TerminateInstances',
        'InstanceId.1': instanceId,
      },
      signal,
    );
    const currentStateBlock = firstTagValue(xml, 'currentState') ?? '';
    const state = normalizeEc2State(firstTagValue(currentStateBlock, 'name'));
    return { instanceId, state };
  }

  async sweepExpiredSpotInstances(
    region: string,
    nowMs = this.now(),
    signal?: AbortSignal,
  ): Promise<ExpiredSpotSweepResult> {
    const xml = await this.callEc2Query(
      region,
      {
        Action: 'DescribeInstances',
        'Filter.1.Name': `tag:${HIVEMIND_MF_MANAGED_TAG_KEY}`,
        'Filter.1.Value.1': HIVEMIND_MF_MANAGED_TAG_VALUE,
        'Filter.2.Name': 'instance-state-name',
        'Filter.2.Value.1': 'pending',
        'Filter.2.Value.2': 'running',
        'Filter.2.Value.3': 'stopping',
        'Filter.2.Value.4': 'stopped',
      },
      signal,
    );
    const instances = extractTopLevelInstances(region, xml);
    const terminated: ExpiredSpotSweepResult['terminated'] = [];

    for (const instance of instances) {
      const expiresAtRaw = instance.tags['hivemind:expires-at'] ?? null;
      const expiresAtMs = expiresAtRaw ? Date.parse(expiresAtRaw) : Number.NaN;
      const isExpired = !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
      if (!isExpired) continue;

      const reason = !Number.isFinite(expiresAtMs)
        ? 'TTL Guard fail-closed: missing or invalid hivemind:expires-at tag'
        : `TTL Guard expired at ${expiresAtRaw}`;
      await this.terminateInstance(region, instance.instanceId, signal);
      terminated.push({
        instanceId: instance.instanceId,
        jobId: instance.tags['hivemind:job-id'] ?? null,
        expiresAt: expiresAtRaw,
        reason,
      });
    }

    return {
      region,
      checkedCount: instances.length,
      terminated,
    };
  }
}
