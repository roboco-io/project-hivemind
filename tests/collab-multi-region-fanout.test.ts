import assert from 'node:assert/strict';
import test from 'node:test';
import { CollabOrchestrator } from '../apps/control-plane/src/collab-orchestrator.js';
import { AwsMultiRegionEcsDriver } from '../packages/adapters/src/aws-multi-region-driver.js';
import { AgentCollabService, SqliteCollaborationRepository } from '../packages/core/src/agent-collab.js';

function spoke(region: string) {
  return {
    region,
    clusterArn: `arn:aws:ecs:${region}:123456789012:cluster/hivemind-runtime-${region}-cluster`,
    workerTaskDefinition: `${region}-worker:1`,
    verifierTaskDefinition: `${region}-verifier:1`,
    subnets: [`subnet-${region}-a`],
    securityGroups: [`sg-${region}`],
    controlApiUrl: 'http://10.0.0.10:4310',
    allowVpcInternalHttp: true,
    artifactsBucket: 'hivemind-artifacts',
  };
}

function makeDriver(regions: string[], calls: { host: string; cluster: string; subnets: string[] }[]) {
  return new AwsMultiRegionEcsDriver({
    primaryRegion: regions[0]!,
    spokes: regions.map(spoke),
    credentials: () => ({ accessKeyId: 'AKIAEXAMPLE123456', secretAccessKey: 'secret-never-logged' }),
    now: () => Date.parse('2026-11-26T05:00:00Z'),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        cluster?: string;
        networkConfiguration?: { awsvpcConfiguration?: { subnets?: string[] } };
      };
      calls.push({
        host: url.hostname,
        cluster: body.cluster ?? '',
        subnets: body.networkConfiguration?.awsvpcConfiguration?.subnets ?? [],
      });
      const region = url.hostname.split('.')[1]!;
      return new Response(
        JSON.stringify({ tasks: [{ taskArn: `arn:aws:ecs:${region}:123456789012:task/c/t-${calls.length}` }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
}

test('AwsMultiRegionEcsDriver.launchCollabWorker runs the worker in the requested spoke and rejects unconfigured regions', async () => {
  const calls: { host: string; cluster: string; subnets: string[] }[] = [];
  const driver = makeDriver(['ap-northeast-2', 'us-east-1'], calls);
  const input = { sessionId: 'ses-1', subtaskId: 'sub-1', agentId: 'agent-1', provider: 'claude' as const };

  const launched = await driver.launchCollabWorker({ ...input, targetRegion: 'us-east-1' });
  assert.equal(launched.region, 'us-east-1');
  assert.equal(calls[0]!.host, 'ecs.us-east-1.amazonaws.com');
  assert.equal(calls[0]!.cluster, 'arn:aws:ecs:us-east-1:123456789012:cluster/hivemind-runtime-us-east-1-cluster');
  assert.deepEqual(calls[0]!.subnets, ['subnet-us-east-1-a']);

  const defaulted = await driver.launchCollabWorker(input);
  assert.equal(defaulted.region, 'ap-northeast-2');

  await assert.rejects(() => driver.launchCollabWorker({ ...input, targetRegion: 'us-west-2' }), /not configured/);
  assert.equal(calls.length, 2);
});

test('collab fan-out only places workers in regions that are session-allowed and launcher-configured', async () => {
  const service = new AgentCollabService(new SqliteCollaborationRepository(':memory:'));
  const calls: { host: string; cluster: string; subnets: string[] }[] = [];
  const driver = makeDriver(['ap-northeast-2', 'us-east-1'], calls);
  const orchestrator = new CollabOrchestrator({
    service,
    controlApiUrl: 'http://127.0.0.1:4310',
    workerToken: 'wk-token',
    redactSecrets: ['wk-token'],
    workerLauncher: {
      launchCollabWorker: (input, signal) => driver.launchCollabWorker(input, signal),
      configuredRegions: () => driver.configuredRegions(),
    },
  });
  try {
    // us-west-2 is allowed by the session but has no configured spoke, so only us-east-1 is a candidate.
    const routed = await service.createSession({
      title: 'Spoke fan-out',
      goal: 'Route to a configured spoke',
      provider: 'claude',
      allowedRegions: ['us-west-2', 'us-east-1'],
    });
    await service.createSubtask(routed.id, { title: 'A', instructions: 'Do A' });
    await service.createSubtask(routed.id, { title: 'B', instructions: 'Do B' });
    const result = await orchestrator.fanOutReadySubtasks(routed.id);
    assert.equal(result.dispatched.length, 2);
    assert.deepEqual(result.dispatched.map((s) => s.region), ['us-east-1', 'us-east-1']);
    assert.deepEqual(calls.map((c) => c.host), ['ecs.us-east-1.amazonaws.com', 'ecs.us-east-1.amazonaws.com']);

    // No overlap between session regions and configured spokes: nothing is launched or claimed.
    const blocked = await service.createSession({
      title: 'No spoke',
      goal: 'Must not launch',
      provider: 'claude',
      allowedRegions: ['us-west-2'],
    });
    await service.createSubtask(blocked.id, { title: 'C', instructions: 'Do C' });
    const skipped = await orchestrator.fanOutReadySubtasks(blocked.id);
    assert.equal(skipped.dispatched.length, 0);
    assert.match(skipped.skippedReason ?? '', /No session-allowed region has a configured worker spoke/);
    assert.equal(calls.length, 2);
    assert.equal((await service.listReadySubtasks(blocked.id)).length, 1);
  } finally {
    service.close();
  }
});
