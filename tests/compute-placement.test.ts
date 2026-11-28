import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerComputeRoutes } from '../apps/control-plane/src/compute-api.js';
import { ComputeOrchestrator } from '../apps/control-plane/src/compute-orchestrator.js';
import { ProjectStore } from '../packages/core/src/projects.js';
import {
  parseSpotPlacementScores,
  parseSubnetAzIds,
  type Ec2SpotTrainerPort,
  type SpotPlacementScoreQuery,
} from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { SpotPlacementFeedPort } from '../packages/adapters/src/spot-placement-feed.js';
import type { CreateComputeJob, ComputeJob } from '../packages/contracts/src/compute.js';
import type { SpotMarketSnapshot, SpotTimeSeriesPoint } from '../packages/contracts/src/multi-region.js';
import { ComputeStore } from '../packages/core/src/compute.js';
import {
  orderSubnetsByPlannedAzs,
  planComputePlacement,
  resolveFeedPool,
} from '../packages/core/src/compute-placement.js';

const NOW = Date.parse('2026-11-27T03:30:00Z');
const GENERATED = '2026-11-27 03:11 UTC';
const GENERATED_MS = Date.parse('2026-11-27T03:11:00Z');

/** Hourly points ending at the feed time, oldest first. */
function series(values: number[]): SpotTimeSeriesPoint[] {
  return values.map((value, i) => [new Date(GENERATED_MS - (values.length - 1 - i) * 3_600_000).toISOString(), value] as const);
}

function snapshot(overrides: Partial<SpotMarketSnapshot> = {}): SpotMarketSnapshot {
  return {
    generated: GENERATED,
    generatedAtMs: GENERATED_MS,
    types: ['g6e.12xlarge', 'm.xlarge'],
    regions: ['us-east-1', 'us-east-2', 'ap-northeast-2'],
    typeMeta: {
      'g6e.12xlarge': { family: 'gpu', arch: 'x86', spec: '48 vCPU', gpu: '4×L40S', members: ['g6e.12xlarge'] },
      'm.xlarge': { family: 'm', arch: 'x86', spec: '4 vCPU', members: ['m7i.xlarge', 'm6i.xlarge', 'm5.xlarge'] },
    },
    noPool: {},
    azMeta: {
      'use1-az1': { region: 'us-east-1', azname: 'us-east-1a' },
      'use1-az2': { region: 'us-east-1', azname: 'us-east-1b' },
      'use2-az1': { region: 'us-east-2', azname: 'us-east-2a' },
      'use2-az2': { region: 'us-east-2', azname: 'us-east-2b' },
      'use2-az3': { region: 'us-east-2', azname: 'us-east-2c' },
    },
    scores: {
      'g6e.12xlarge': {
        // High now but dropped to 2 inside the window: less stable than us-east-2.
        'us-east-1': series([9, 9, 2, 9, 9, 9]),
        'us-east-2': series([7, 7, 7, 8, 7, 7]),
        // A score older than the 72-hour window does not count.
        'ap-northeast-2': [['2026-11-01T00:00:00Z', 9]],
      },
    },
    azScores: {
      'g6e.12xlarge': {
        'use2-az1': series([3, 3, 3, 3]),
        'use2-az2': series([9, 9, 9, 8]),
        'use2-az3': series([9, 9, 1, 9]),
        'use1-az1': series([9, 9, 9, 9]),
      },
    },
    prices: { 'g6e.12xlarge': { 'us-east-1': series([5.1]), 'us-east-2': series([5.3]) } },
    azPrice: {},
    ...overrides,
  };
}

const COMPUTE = {
  region: 'ap-northeast-2',
  candidateRegions: ['us-east-1', 'us-east-2'],
  instanceType: 'g6e.12xlarge',
};

test('regions and AZs are ordered by the lowest, then average, then latest score in the window', () => {
  const plan = planComputePlacement(snapshot(), COMPUTE, NOW, 'https://feed.example/data.json');
  assert.equal(plan.status, 'ranked');
  assert.equal(plan.feedPool, 'g6e.12xlarge');
  assert.equal(plan.feedGeneratedAt, GENERATED);
  assert.equal(plan.feedUrl, 'https://feed.example/data.json');
  // us-east-2 (min 7) beats us-east-1 (min 2); ap-northeast-2 has no score in the window and goes last.
  assert.deepEqual(plan.regions.map((r) => r.region), ['us-east-2', 'us-east-1', 'ap-northeast-2']);
  assert.deepEqual(plan.regions[0]!.trend, { latest: 7, min: 7, avg: 7.17, slope: 0.33, samples: 6 });
  assert.equal(plan.regions[0]!.priceUsd, 5.3);
  assert.deepEqual(plan.regions[0]!.azs.map((az) => az.azId), ['use2-az2', 'use2-az1', 'use2-az3']);
  assert.equal(plan.regions[2]!.trend, null);
  assert.match(plan.note, /First: us-east-2 \(use2-az2\), min 7/);
});

test('the job region is always a candidate, and the plan never adds a region', () => {
  const plan = planComputePlacement(snapshot(), { region: 'us-east-1', instanceType: 'g6e.12xlarge' }, NOW);
  assert.deepEqual(plan.regions.map((r) => r.region), ['us-east-1']);
});

test('a type the feed does not cover keeps the listed order and says why', () => {
  const plan = planComputePlacement(snapshot(), { ...COMPUTE, instanceType: 'g4dn.xlarge' }, NOW);
  assert.equal(plan.status, 'type_not_in_feed');
  assert.match(plan.note, /does not cover g4dn\.xlarge/);
  assert.deepEqual(plan.regions.map((r) => r.region), ['ap-northeast-2', 'us-east-1', 'us-east-2']);
  assert.ok(plan.regions.every((r) => r.trend === null && r.azs.length === 0));
});

test('the feed pool comes from workloadClass, the type name or the pool members', () => {
  const snap = snapshot();
  assert.equal(resolveFeedPool(snap, { instanceType: 'g6e.12xlarge' }), 'g6e.12xlarge');
  assert.equal(resolveFeedPool(snap, { instanceType: 'm5.xlarge' }), 'm.xlarge');
  assert.equal(resolveFeedPool(snap, { instanceType: 'g4dn.xlarge', workloadClass: 'gpu-l40s-4x' }), 'g6e.12xlarge');
  assert.equal(resolveFeedPool(snap, { instanceType: 'g4dn.xlarge' }), null);
  assert.equal(resolveFeedPool(snap, { instanceType: 'g4dn.xlarge', workloadClass: 'p5.48xlarge' }), null);
});

test('a stale or missing feed keeps the listed order', () => {
  const stale = planComputePlacement(snapshot(), COMPUTE, GENERATED_MS + 25 * 3_600_000);
  assert.equal(stale.status, 'feed_stale');
  assert.deepEqual(stale.regions.map((r) => r.region), ['ap-northeast-2', 'us-east-1', 'us-east-2']);
  assert.equal(planComputePlacement(null, COMPUTE, NOW).status, 'feed_unavailable');
});

test('a region in the feed noPool list is not ranked', () => {
  const plan = planComputePlacement(snapshot({ noPool: { 'g6e.12xlarge': ['us-east-2'] } }), COMPUTE, NOW);
  assert.deepEqual(plan.regions.map((r) => r.region), ['us-east-1', 'ap-northeast-2', 'us-east-2']);
});

test('subnets follow the planned AZ order and unknown AZs keep their order at the end', () => {
  const subnets = ['subnet-0000000a', 'subnet-0000000b', 'subnet-0000000c', 'subnet-0000000d'];
  const azOf = { 'subnet-0000000a': 'use2-az1', 'subnet-0000000b': 'use2-az3', 'subnet-0000000c': 'use2-az2' };
  assert.deepEqual(orderSubnetsByPlannedAzs(subnets, azOf, ['use2-az2', 'use2-az1', 'use2-az3']), [
    'subnet-0000000c',
    'subnet-0000000a',
    'subnet-0000000b',
    'subnet-0000000d',
  ]);
});

test('DescribeSubnets XML is read per subnet even with nested tag and IPv6 sets', () => {
  const xml = `<DescribeSubnetsResponse><subnetSet>
    <item><subnetId>subnet-0aaaaaaaaaaaaaaa1</subnetId><availabilityZone>us-east-2a</availabilityZone>
      <ipv6CidrBlockAssociationSet><item><availabilityZoneId>wrong</availabilityZoneId></item></ipv6CidrBlockAssociationSet>
      <availabilityZoneId>use2-az1</availabilityZoneId>
      <tagSet><item><key>Name</key><value>a</value></item></tagSet></item>
    <item><tagSet><item><key>Name</key><value>b</value></item></tagSet>
      <availabilityZoneId>use2-az3</availabilityZoneId><subnetId>subnet-0bbbbbbbbbbbbbbb2</subnetId></item>
  </subnetSet></DescribeSubnetsResponse>`;
  assert.deepEqual(parseSubnetAzIds(xml), {
    'subnet-0aaaaaaaaaaaaaaa1': 'use2-az1',
    'subnet-0bbbbbbbbbbbbbbb2': 'use2-az3',
  });
});

type Launch = Parameters<Ec2SpotTrainerPort['launchSpotInstance']>[0];

const SUBNETS_USE2 = ['subnet-0aaaaaaaaaaaaaaa1', 'subnet-0bbbbbbbbbbbbbbb2', 'subnet-0ccccccccccccccc3'];
const SUBNET_AZ: Record<string, string> = {
  'subnet-0aaaaaaaaaaaaaaa1': 'use2-az1',
  'subnet-0bbbbbbbbbbbbbbb2': 'use2-az3',
  'subnet-0ccccccccccccccc3': 'use2-az2',
};

function harness(
  feed: SpotMarketSnapshot | null,
  failSubnets: string[] = [],
  live?: (query: SpotPlacementScoreQuery) => { region: string; azId: string | null; score: number }[],
) {
  const liveQueries: SpotPlacementScoreQuery[] = [];
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 5_000_000 });
  const launches: Launch[] = [];
  const ec2: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) {
      launches.push(input);
      if (input.subnetId && failSubnets.includes(input.subnetId)) {
        throw new Error('AWS EC2 RunInstances failed: InsufficientInstanceCapacity');
      }
      return {
        region: input.region,
        availabilityZone: null,
        instanceId: `i-${String(launches.length).padStart(17, '0')}`,
        instanceType: input.instanceType,
        amiId: input.amiId,
        state: 'pending',
      };
    },
    async describeInstance() {
      throw new Error('not used');
    },
    async terminateInstance(_region, instanceId) {
      return { instanceId, state: 'terminated' };
    },
    async sweepExpiredSpotInstances(region) {
      return { region, checkedCount: 0, terminated: [] };
    },
    async describeSubnetAzIds(_region, subnetIds) {
      return Object.fromEntries(subnetIds.map((id) => [id, SUBNET_AZ[id]!]));
    },
    ...(live
      ? {
          async getSpotPlacementScores(query: SpotPlacementScoreQuery) {
            liveQueries.push(query);
            return live(query);
          },
        }
      : {}),
  };
  const s3: S3ObjectPort = {
    async putObject() {
      throw new Error('not used');
    },
    async getObject(key) {
      throw new Error(`NoSuchKey: ${key}`);
    },
  };
  const spotFeed: SpotPlacementFeedPort = { feedUrl: 'https://feed.example/data.json', getSnapshot: async () => feed };
  const orchestrator = new ComputeOrchestrator({
    store,
    ec2,
    s3,
    spotFeed,
    now: () => NOW,
    regionNetworks: {
      'us-east-2': { subnetIds: SUBNETS_USE2, amiId: 'ami-0eeeeeeeeeeeeeee2' },
      'us-east-1': { subnetIds: ['subnet-0ddddddddddddddd4'], amiId: 'ami-0eeeeeeeeeeeeeee1' },
    },
  });
  return { store, orchestrator, launches, liveQueries };
}

function jobInput(): CreateComputeJob {
  return {
    title: 'Placement plan',
    workloadId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-1',
      candidateRegions: ['us-east-2'],
      instanceType: 'g6e.12xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000,
      maxHourlyPriceUsd: 6,
      maxTotalCostMicros: 4_000_000,
      s3ArtifactPrefix: 'models/smf-tiny-v1/run-placement',
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

test('registration through the API stores the plan without changing the approval fingerprint', async () => {
  const { store, orchestrator } = harness(snapshot());
  const app = Fastify();
  const projects = new ProjectStore(':memory:');
  registerComputeRoutes(app, { auth: { operatorToken: 't'.repeat(32), workerToken: 'w'.repeat(32), projects }, store, projects, orchestrator });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compute/jobs',
      headers: { authorization: `Bearer ${'t'.repeat(32)}` },
      payload: jobInput(),
    });
    assert.equal(res.statusCode, 201);
    const job = res.json() as ComputeJob;
    assert.equal(job.placementPlan?.status, 'ranked');
    assert.deepEqual(job.placementPlan?.regions.map((r) => r.region), ['us-east-2', 'us-east-1']);
    const plain = await new ComputeStore(':memory:').create(jobInput());
    assert.equal(job.approvalFingerprint, plain.approvalFingerprint);
    const events = await store.events(job.id);
    assert.ok(events.some((e) => e.type === 'compute.placement_planned'));
  } finally {
    await app.close();
  }
});

test('launch tries the most stable region first and its subnets in AZ order', async () => {
  // use2-az2 (subnet c) is most stable; it has no capacity, so use2-az1 (subnet a) is next.
  const { store, orchestrator, launches } = harness(snapshot(), ['subnet-0ccccccccccccccc3']);
  const job = await orchestrator.planAtRegistration(await store.create(jobInput()));
  const launched = await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'ok');
  assert.equal(launched.status, 'running');
  assert.deepEqual(
    launches.map((l) => [l.region, l.subnetId]),
    [
      ['us-east-2', 'subnet-0ccccccccccccccc3'],
      ['us-east-2', 'subnet-0aaaaaaaaaaaaaaa1'],
    ],
  );
});

test('launch keeps the registration plan when the feed is gone at launch time', async () => {
  const feed = { current: snapshot() as SpotMarketSnapshot | null };
  const { store, orchestrator, launches } = harness(null);
  (orchestrator as unknown as { options: { spotFeed: SpotPlacementFeedPort } }).options.spotFeed = {
    getSnapshot: async () => feed.current,
  };
  const job = await orchestrator.planAtRegistration(await store.create(jobInput()));
  feed.current = null;
  await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'ok');
  assert.equal(launches[0]!.region, 'us-east-2');
  assert.equal(launches[0]!.subnetId, 'subnet-0ccccccccccccccc3');
});

test('without any feed the job region is tried first, as before', async () => {
  const { store, orchestrator, launches } = harness(null);
  const job = await orchestrator.planAtRegistration(await store.create(jobInput()));
  assert.equal(job.placementPlan?.status, 'feed_unavailable');
  await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'ok');
  assert.equal(launches[0]!.region, 'us-east-1');
});

test('live scores are added to the feed trend as the newest sample', () => {
  // Live says us-east-2 dropped to 2 now; us-east-1 is still behind on its window minimum of 2, so the
  // average decides: us-east-1 (6.71) now beats us-east-2 (6.29).
  const plan = planComputePlacement(snapshot(), COMPUTE, NOW, null, {
    at: '2026-11-27T03:29:00.000Z',
    scores: [
      { region: 'us-east-2', azId: null, score: 2 },
      { region: 'us-east-1', azId: null, score: 9 },
      { region: 'us-east-2', azId: 'use2-az2', score: 1 },
    ],
  });
  assert.equal(plan.liveScoredAt, '2026-11-27T03:29:00.000Z');
  assert.deepEqual(plan.regions.map((r) => [r.region, r.trend?.min, r.trend?.latest]), [
    ['us-east-1', 2, 9],
    ['us-east-2', 2, 2],
    ['ap-northeast-2', undefined, undefined],
  ]);
  const use2 = plan.regions.find((r) => r.region === 'us-east-2')!;
  assert.deepEqual(use2.azs.map((az) => az.azId), ['use2-az1', 'use2-az2', 'use2-az3']);
  assert.match(plan.note, /feed pool 'g6e\.12xlarge' over 72 hours and live scores of g6e\.12xlarge/);
});

test('a type the feed does not cover is ranked by live scores alone', () => {
  const plan = planComputePlacement(snapshot(), { ...COMPUTE, instanceType: 'g4dn.xlarge' }, NOW, null, {
    at: '2026-11-27T03:29:00.000Z',
    scores: [
      { region: 'us-east-1', azId: null, score: 1 },
      { region: 'us-east-2', azId: null, score: 9 },
      { region: 'us-east-2', azId: 'use2-az1', score: 9 },
      { region: 'us-east-2', azId: 'use2-az3', score: 3 },
      { region: 'us-east-2', azId: 'use2-az9', score: 99 },
    ],
  });
  assert.equal(plan.status, 'ranked');
  assert.equal(plan.feedPool, null);
  assert.match(plan.note, /^Feed does not cover g4dn\.xlarge\. Ranked by .* live scores of g4dn\.xlarge/);
  assert.deepEqual(plan.regions.map((r) => r.region), ['us-east-2', 'us-east-1', 'ap-northeast-2']);
  // AZs come from the live answer too; an out-of-range score is ignored.
  assert.deepEqual(plan.regions[0]!.azs.map((az) => az.azId), ['use2-az1', 'use2-az3']);
});

test('GetSpotPlacementScores XML is read into regional and per-AZ scores', () => {
  const xml = `<GetSpotPlacementScoresResponse><requestId>r</requestId><spotPlacementScoreSet>
    <item><availabilityZoneId>use1-az6</availabilityZoneId><region>us-east-1</region><score>1</score></item>
    <item><region>us-east-2</region><score>9</score></item>
    <item><region>us-west-2</region><score>11</score></item>
  </spotPlacementScoreSet></GetSpotPlacementScoresResponse>`;
  assert.deepEqual(parseSpotPlacementScores(xml), [
    { region: 'us-east-1', azId: 'use1-az6', score: 1 },
    { region: 'us-east-2', azId: null, score: 9 },
  ]);
});

test('registration asks EC2 for regional and per-AZ live scores of the job type and keeps going when it fails', async () => {
  const { store, orchestrator, liveQueries } = harness(snapshot(), [], (query) => {
    if (query.singleAvailabilityZone) throw new Error('AWS EC2 GetSpotPlacementScores failed with HTTP 403');
    return [
      { region: 'us-east-1', azId: null, score: 9 },
      { region: 'us-east-2', azId: null, score: 9 },
    ];
  });
  const job = await orchestrator.planAtRegistration(await store.create({ ...jobInput(), compute: { ...jobInput().compute, instanceType: 'g4dn.xlarge' } }));
  assert.deepEqual(
    liveQueries.map((q) => [q.endpointRegion, q.instanceType, q.regions.join(','), q.singleAvailabilityZone]).sort(),
    [
      ['us-east-1', 'g4dn.xlarge', 'us-east-1,us-east-2', false],
      ['us-east-1', 'g4dn.xlarge', 'us-east-1,us-east-2', true],
    ],
  );
  assert.equal(job.placementPlan?.status, 'ranked');
  assert.deepEqual(job.placementPlan?.regions.map((r) => r.region), ['us-east-1', 'us-east-2']);
});
