import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { DeliveryOrchestrator } from '../apps/control-plane/src/delivery-orchestrator.js';
import { AwsMultiRegionEcsDriver } from '../packages/adapters/src/aws-multi-region-driver.js';
import { createSpotPlacementFeedPort, parseSpotMarketSnapshot } from '../packages/adapters/src/spot-placement-feed.js';
import type { SpotMarketSnapshot } from '../packages/contracts/src/multi-region.js';
import { computeAcceptanceTestDigest, DeliveryStore } from '../packages/core/src/delivery.js';
import { selectOptimalSpotPlacement } from '../packages/core/src/multi-region.js';

function makeSnapshot(overrides: Partial<SpotMarketSnapshot> = {}): SpotMarketSnapshot {
  const generated = '2026-11-26 00:00 UTC';
  return parseSpotMarketSnapshot({
    generated,
    types: ['c.xlarge-arm', 'g6e.12xlarge', 'p5.48xlarge'],
    regions: ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'],
    typeMeta: {
      'c.xlarge-arm': { family: 'c', arch: 'arm', spec: '4 vCPU · 8 GiB', members: ['c8g.xlarge', 'c7g.xlarge'] },
      'g6e.12xlarge': { family: 'gpu', arch: 'x86', spec: '48 vCPU · 384 GiB', gpu: '4×L40S', members: ['g6e.12xlarge'] },
      'p5.48xlarge': { family: 'gpu', arch: 'x86', spec: '192 vCPU · 2048 GiB', gpu: '8×H100', members: ['p5.48xlarge'] },
    },
    noPool: { 'c.xlarge-arm': [], 'g6e.12xlarge': [], 'p5.48xlarge': [] },
    azMeta: {
      'apne2-az1': { region: 'ap-northeast-2', azname: 'ap-northeast-2a' },
      'apne2-az3': { region: 'ap-northeast-2', azname: 'ap-northeast-2c' },
      'use2-az1': { region: 'us-east-2', azname: 'us-east-2a' },
      'use2-az2': { region: 'us-east-2', azname: 'us-east-2b' },
      'use1-az1': { region: 'us-east-1', azname: 'us-east-1a' },
      'usw2-az2': { region: 'us-west-2', azname: 'us-west-2a' },
    },
    scores: {
      'c.xlarge-arm': {
        'ap-northeast-2': [
          ['2026-11-25T12:00:00Z', 9],
          ['2026-11-25T18:00:00Z', 9],
          ['2026-11-26T00:00:00Z', 9],
        ],
        'us-east-2': [
          ['2026-11-25T12:00:00Z', 9],
          ['2026-11-25T18:00:00Z', 9],
          ['2026-11-26T00:00:00Z', 9],
        ],
      },
      'g6e.12xlarge': {
        'ap-northeast-2': [
          ['2026-11-25T12:00:00Z', 2],
          ['2026-11-25T18:00:00Z', 1],
          ['2026-11-26T00:00:00Z', 1],
        ],
        'us-east-2': [
          ['2026-11-25T12:00:00Z', 8],
          ['2026-11-25T18:00:00Z', 9],
          ['2026-11-26T00:00:00Z', 9],
        ],
        'us-east-1': [
          ['2026-11-25T12:00:00Z', 9],
          ['2026-11-25T18:00:00Z', 8],
          ['2026-11-26T00:00:00Z', 7],
        ],
      },
      'p5.48xlarge': {
        'ap-northeast-2': [
          ['2026-11-25T12:00:00Z', 8],
          ['2026-11-26T00:00:00Z', 8],
        ],
        'us-east-2': [
          ['2026-11-25T12:00:00Z', 9],
          ['2026-11-26T00:00:00Z', 9],
        ],
        'us-west-2': [
          ['2026-11-25T12:00:00Z', 9],
          ['2026-11-26T00:00:00Z', 9],
        ],
      },
    },
    azScores: {
      'c.xlarge-arm': {
        'apne2-az1': [['2026-11-26T00:00:00Z', 9]],
        'apne2-az3': [['2026-11-26T00:00:00Z', 9]],
        'use2-az1': [['2026-11-26T00:00:00Z', 9]],
      },
      'g6e.12xlarge': {
        'apne2-az1': [['2026-11-26T00:00:00Z', 1]],
        'use2-az1': [['2026-11-26T00:00:00Z', 9]],
        'use2-az2': [['2026-11-26T00:00:00Z', 9]],
        'use1-az1': [['2026-11-26T00:00:00Z', 7]],
      },
      'p5.48xlarge': {
        'apne2-az1': [['2026-11-26T00:00:00Z', 8]],
        'use2-az1': [['2026-11-26T00:00:00Z', 9]],
        'usw2-az2': [['2026-11-26T00:00:00Z', 9]],
      },
    },
    prices: {
      'c.xlarge-arm': {
        'ap-northeast-2': [['2026-11-26T00:00:00Z', 0.0474]],
        'us-east-2': [['2026-11-26T00:00:00Z', 0.0465]],
      },
      'g6e.12xlarge': {
        'ap-northeast-2': [['2026-11-26T00:00:00Z', 5.9293]],
        'us-east-2': [['2026-11-26T00:00:00Z', 5.3581]],
        'us-east-1': [['2026-11-26T00:00:00Z', 5.2]],
      },
      'p5.48xlarge': {
        'ap-northeast-2': [['2026-11-26T00:00:00Z', 33.3444]],
        'us-east-2': [['2026-11-26T00:00:00Z', 24.8869]],
        'us-west-2': [['2026-11-26T00:00:00Z', 26.057]],
      },
    },
    azPrice: {
      'c.xlarge-arm': { 'ap-northeast-2a': 0.048, 'ap-northeast-2c': 0.0474, 'us-east-2a': 0.0465 },
      'g6e.12xlarge': { 'ap-northeast-2a': 5.9293, 'us-east-2a': 5.5, 'us-east-2b': 5.3581, 'us-east-1a': 5.2 },
      'p5.48xlarge': { 'ap-northeast-2a': 33.3444, 'us-east-2a': 24.8869, 'us-west-2a': 26.057 },
    },
    ...overrides,
  });
}

test('selectOptimalSpotPlacement prefers Seoul within primary bonus, shifts GPU to Ohio when Seoul score is low, penalizes declining trend, and supports Spot failover', () => {
  const snapshot = makeSnapshot();
  const nowMs = Date.parse('2026-11-26T01:00:00Z');

  // 1. CPU ARM: Seoul ($0.0474) vs Ohio ($0.0465, only 1.9% cheaper) -> stays in Seoul due to 5% primary bonus!
  const cpuDecision = selectOptimalSpotPlacement(
    snapshot,
    {
      primaryRegion: 'ap-northeast-2',
      allowedRegions: ['ap-northeast-2', 'us-east-2'],
      workloadClass: 'cpu-arm-worker',
      primaryRegionBonusPercent: 5,
    },
    nowMs,
  );
  assert.equal(cpuDecision.selectedRegion, 'ap-northeast-2');
  assert.equal(cpuDecision.selectedAzId, 'apne2-az3');
  assert.equal(cpuDecision.selectedAzName, 'ap-northeast-2c');

  // 2. GPU 4xL40S: Seoul score 1 (rejected), us-east-1 declining 9->7 ($5.20), us-east-2 improving 8->9 ($5.3581) -> picks us-east-2 / use2-az2!
  const gpuDecision = selectOptimalSpotPlacement(
    snapshot,
    {
      primaryRegion: 'ap-northeast-2',
      allowedRegions: ['ap-northeast-2', 'us-east-2', 'us-east-1'],
      workloadClass: 'gpu-l40s-4x',
      minPlacementScore: 7,
    },
    nowMs,
  );
  assert.equal(gpuDecision.selectedRegion, 'us-east-2');
  assert.equal(gpuDecision.selectedAzId, 'use2-az2');
  assert.equal(gpuDecision.trendDirection, 'improving');
  assert.ok((gpuDecision.savingsVsPrimaryPercent ?? 0) > 9);
  assert.equal(gpuDecision.candidates.find((c) => c.region === 'ap-northeast-2')?.eligible, false);
  assert.equal(gpuDecision.candidates.find((c) => c.region === 'us-east-1')?.trendDirection, 'declining');

  // 3. GPU 8xH100 Spot failover: exclude us-east-2 -> automatically fails over to us-west-2 (21.9% cheaper than Seoul)!
  const failoverDecision = selectOptimalSpotPlacement(
    snapshot,
    {
      primaryRegion: 'ap-northeast-2',
      allowedRegions: ['ap-northeast-2', 'us-east-2', 'us-west-2'],
      workloadClass: 'gpu-h100-8x',
      excludeRegions: ['us-east-2'],
    },
    nowMs,
  );
  assert.equal(failoverDecision.selectedRegion, 'us-west-2');
  assert.equal(failoverDecision.selectedAzId, 'usw2-az2');
  assert.ok((failoverDecision.savingsVsPrimaryPercent ?? 0) > 20);

  // 4. Hard maxHourlyPriceUsd enforcement rejects when all regions exceed budget.
  assert.throws(
    () =>
      selectOptimalSpotPlacement(
        snapshot,
        {
          primaryRegion: 'ap-northeast-2',
          allowedRegions: ['ap-northeast-2', 'us-east-2'],
          workloadClass: 'gpu-h100-8x',
          maxHourlyPriceUsd: 10,
        },
        nowMs,
      ),
    /maxHourlyPriceUsd/,
  );

  // 5. Stale feed (>24h old) safely falls back to primaryRegion (ap-northeast-2).
  const staleDecision = selectOptimalSpotPlacement(
    snapshot,
    {
      primaryRegion: 'ap-northeast-2',
      allowedRegions: ['ap-northeast-2', 'us-east-2'],
      workloadClass: 'gpu-h100-8x',
      maxFeedAgeHours: 24,
    },
    Date.parse('2026-11-28T05:00:00Z'),
  );
  assert.equal(staleDecision.selectedRegion, 'ap-northeast-2');
  assert.equal(staleDecision.feedStaleFallback, true);
});

test('AwsMultiRegionEcsDriver routes RunTask to selected spoke region + pinned AZ subnet and fails over on Spot interruption', async () => {
  const launchedCalls: { url: string; subnets: string[]; regionHeader: string }[] = [];
  const driver = new AwsMultiRegionEcsDriver({
    primaryRegion: 'ap-northeast-2',
    spokes: [
      {
        region: 'ap-northeast-2',
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/seoul',
        workerTaskDefinition: 'seoul-worker:1',
        verifierTaskDefinition: 'seoul-verifier:1',
        subnets: ['subnet-seoul-a', 'subnet-seoul-c'],
        subnetByAzId: { 'apne2-az1': 'subnet-seoul-a', 'apne2-az3': 'subnet-seoul-c' },
        securityGroups: ['sg-seoul'],
        controlApiUrl: 'http://10.0.0.10:4310',
        allowVpcInternalHttp: true,
        artifactsBucket: 'hivemind-artifacts',
      },
      {
        region: 'us-east-2',
        clusterArn: 'arn:aws:ecs:us-east-2:123456789012:cluster/ohio',
        workerTaskDefinition: 'ohio-worker:1',
        verifierTaskDefinition: 'ohio-verifier:1',
        subnets: ['subnet-ohio-a', 'subnet-ohio-b'],
        subnetByAzId: { 'use2-az1': 'subnet-ohio-a', 'use2-az2': 'subnet-ohio-b' },
        securityGroups: ['sg-ohio'],
        controlApiUrl: 'http://10.0.0.10:4310',
        allowVpcInternalHttp: true,
        artifactsBucket: 'hivemind-artifacts',
      },
    ],
    credentials: () => ({ accessKeyId: 'AKIAEXAMPLE123456', secretAccessKey: 'secret-never-logged' }),
    now: () => Date.parse('2026-11-26T01:00:00Z'),
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        networkConfiguration?: { awsvpcConfiguration?: { subnets?: string[] } };
      };
      const url = String(input);
      const regionMatch = /^https:\/\/ecs\.([a-z0-9-]+)\.amazonaws\.com/.exec(url);
      launchedCalls.push({
        url,
        subnets: body.networkConfiguration?.awsvpcConfiguration?.subnets ?? [],
        regionHeader: (init?.headers as Record<string, string>).authorization ?? '',
      });
      return new Response(
        JSON.stringify({
          tasks: [{ taskArn: `arn:aws:ecs:${regionMatch?.[1] ?? 'ap-northeast-2'}:123456789012:task/c/t-${launchedCalls.length}` }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const snapshot = makeSnapshot();
  const feed = createSpotPlacementFeedPort({
    fetchImpl: async () => new Response(JSON.stringify(snapshot), { status: 200 }),
    now: () => Date.parse('2026-11-26T01:00:00Z'),
  });

  const store = new DeliveryStore(':memory:', () => Date.parse('2026-11-26T01:00:00Z'));
  try {
    const baseCommit = 'a'.repeat(40);
    const files = [{ path: 'tests/a.test.ts', sha256: 'b'.repeat(64) }];
    const testCommand = ['npm', 'run', 'check'];
    const task = await store.create({
      title: 'GPU Spot task with multi-region routing',
      instructions: 'Run workload in cheapest high-score region.',
      provider: 'codex',
      maxIterations: 2,
      budgetMicros: 500_000,
      acceptance: {
        baseCommit,
        files,
        testCommand,
        digest: computeAcceptanceTestDigest({ baseCommit, files, testCommand }),
      },
      delivery: {
        mode: 'draft_pr',
        repository: 'roboco-io/project-hivemind',
        baseBranch: 'main',
        branchPrefix: 'hivemind/',
        autoMerge: false,
      },
      bundle: {
        baseCommit,
        bundleSha256: 'c'.repeat(64),
        sizeBytes: 2048,
        fileCount: 10,
        s3Key: 'bundles/test.bundle',
      },
      routing: {
        primaryRegion: 'ap-northeast-2',
        allowedRegions: ['ap-northeast-2', 'us-east-2'],
        workloadClass: 'gpu-l40s-4x',
      },
    });
    await store.approve(task.id, task.approvalFingerprint, 'Approved multi-region task');

    const orchestrator = new DeliveryOrchestrator({
      store,
      s3: {
        async putObject() {
          return { sha256: 'd'.repeat(64) };
        },
        async getObject() {
          return new Uint8Array();
        },
      },
      ecs: driver,
      spotFeed: feed,
      defaultRoutingPolicy: {
        primaryRegion: 'ap-northeast-2',
        allowedRegions: ['ap-northeast-2', 'us-east-2'],
        workloadClass: 'c.xlarge-arm',
      },
      github: {
        async publishDraftPr() {
          throw new Error('not called');
        },
      },
      now: () => Date.parse('2026-11-26T01:00:00Z'),
    });

    // Dispatch 1 -> picks Ohio (us-east-2) + exact subnet-ohio-b for use2-az2!
    const d1 = await orchestrator.dispatchWorker(task.id);
    assert.equal(d1.placement?.selectedRegion, 'us-east-2');
    assert.equal(launchedCalls[0]!.url, 'https://ecs.us-east-2.amazonaws.com/');
    assert.deepEqual(launchedCalls[0]!.subnets, ['subnet-ohio-b']);
    assert.match(launchedCalls[0]!.regionHeader, /\/us-east-2\/ecs\/aws4_request/);

    // Spot interruption in us-east-2 -> automatically fails over to Seoul (ap-northeast-2)!
    const afterSpot = await orchestrator.handleSpotInterruption(
      task.id,
      d1.runId,
      'sessions/cp-1.json',
      'Spot SIGTERM in Ohio',
    );
    assert.equal(afterSpot.redispatched?.placement?.selectedRegion, 'ap-northeast-2');
    assert.equal(launchedCalls[1]!.url, 'https://ecs.ap-northeast-2.amazonaws.com/');
  } finally {
    await store.close();
  }
});

test('GET /api/delivery/spot-placement requires operator role and returns live multi-region recommendation', async () => {
  const snapshot = makeSnapshot();
  const feed = createSpotPlacementFeedPort({
    fetchImpl: async () => new Response(JSON.stringify(snapshot), { status: 200 }),
    now: () => Date.parse('2026-11-26T01:00:00Z'),
  });
  const app = buildApp({
    operatorToken: 'operator-multi-region-token-123456',
    workerToken: 'worker-multi-region-token-654321',
    deliveryOrchestratorFactory: (store) =>
      new DeliveryOrchestrator({
        store,
        s3: {
          async putObject() {
            return { sha256: 'a'.repeat(64) };
          },
          async getObject() {
            return new Uint8Array();
          },
        },
        ecs: {
          async launchWorkload() {
            return { taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/c/1' };
          },
          async stop() {},
        },
        spotFeed: feed,
        defaultRoutingPolicy: {
          primaryRegion: 'ap-northeast-2',
          allowedRegions: ['ap-northeast-2', 'us-east-2', 'us-west-2'],
          workloadClass: 'c.xlarge-arm',
        },
        github: {
          async publishDraftPr() {
            throw new Error('not called');
          },
        },
        now: () => Date.parse('2026-11-26T01:00:00Z'),
      }),
  });
  try {
    const workerBlocked = await app.inject({
      method: 'GET',
      url: '/api/delivery/spot-placement?workloadClass=gpu-h100-8x',
      headers: { authorization: 'Bearer worker-multi-region-token-654321' },
    });
    assert.equal(workerBlocked.statusCode, 401);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/delivery/spot-placement?workloadClass=gpu-h100-8x',
      headers: { authorization: 'Bearer operator-multi-region-token-123456' },
    });
    assert.equal(ok.statusCode, 200);
    const body = ok.json();
    assert.equal(body.selectedRegion, 'us-east-2');
    assert.equal(body.selectedAzId, 'use2-az1');
    assert.ok(body.savingsVsPrimaryPercent > 20);
  } finally {
    await app.close();
  }
});
