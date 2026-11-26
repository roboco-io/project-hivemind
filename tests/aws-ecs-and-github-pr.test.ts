import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsEcsFargateSpotDriver } from '../packages/adapters/src/aws-ecs-driver.js';
import { createGitHubDraftPrPort } from '../packages/adapters/src/github-draft-pr.js';

test('AwsEcsFargateSpotDriver signs ECS RunTask with FARGATE_SPOT, disables public IP, isolates task definitions, and passes zero secrets', async () => {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const driver = new AwsEcsFargateSpotDriver({
    region: 'ap-northeast-2',
    clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/hivemind-cluster',
    workerTaskDefinition: 'hivemind-ai-worker:1',
    verifierTaskDefinition: 'hivemind-verifier:1',
    subnets: ['subnet-private-1'],
    securityGroups: ['sg-private-1'],
    controlApiUrl: 'https://control.hivemind.internal',
    artifactsBucket: 'hivemind-artifacts',
    credentials: () => ({
      accessKeyId: 'AKIAEXAMPLE123456',
      secretAccessKey: 'super-secret-aws-key-never-in-env',
      sessionToken: 'session-token-xyz',
    }),
    now: () => Date.parse('2026-11-25T12:00:00.000Z'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(
        JSON.stringify({ tasks: [{ taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/hivemind-cluster/abc123' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const launched = await driver.launchWorkload({
    kind: 'worker',
    taskId: 'dlv-123',
    runId: 'run-1',
    iteration: 2,
    bundleS3Key: 'bundles/base.bundle',
    bundleSha256: 'a'.repeat(64),
    acceptanceDigest: 'b'.repeat(64),
    checkpointS3Key: 'sessions/run-0.enc',
  });
  assert.equal(launched.taskArn, 'arn:aws:ecs:ap-northeast-2:123456789012:task/hivemind-cluster/abc123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://ecs.ap-northeast-2.amazonaws.com/');
  assert.match(calls[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123456\/20261125\/ap-northeast-2\/ecs\/aws4_request/);
  assert.deepEqual(calls[0]!.body.capacityProviderStrategy, [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }]);
  assert.equal(
    (calls[0]!.body.networkConfiguration as { awsvpcConfiguration: { assignPublicIp: string } }).awsvpcConfiguration.assignPublicIp,
    'DISABLED',
  );
  // Secrets must never appear in container overrides.
  assert.ok(!JSON.stringify(calls[0]!.body).includes('super-secret-aws-key-never-in-env'));

  // Verifier uses separate taskDefinition and never receives checkpointS3Key.
  await driver.launchWorkload({
    kind: 'verifier',
    taskId: 'dlv-123',
    runId: 'run-1',
    iteration: 2,
    bundleS3Key: 'bundles/base.bundle',
    bundleSha256: 'a'.repeat(64),
    acceptanceDigest: 'b'.repeat(64),
    patchS3Key: 'patches/run-1.patch',
    checkpointS3Key: 'sessions/should-not-pass.enc',
  });
  assert.equal(calls[1]!.body.taskDefinition, 'hivemind-verifier:1');
  assert.ok(!JSON.stringify(calls[1]!.body).includes('should-not-pass'));

  // Rejects same taskDefinition for worker & verifier.
  assert.throws(
    () =>
      new AwsEcsFargateSpotDriver({
        region: 'ap-northeast-2',
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c',
        workerTaskDefinition: 'same:1',
        verifierTaskDefinition: 'same:1',
        subnets: ['subnet-1'],
        securityGroups: ['sg-1'],
        controlApiUrl: 'https://control.internal',
        artifactsBucket: 'bucket',
        credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
      }),
    /distinct ECS task definitions/,
  );

  // Rejects HTTP by default, permits private VPC HTTP only with explicit allowVpcInternalHttp, and always rejects public HTTP.
  assert.throws(
    () =>
      new AwsEcsFargateSpotDriver({
        region: 'ap-northeast-2',
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c',
        workerTaskDefinition: 'worker:1',
        verifierTaskDefinition: 'verifier:1',
        subnets: ['subnet-1'],
        securityGroups: ['sg-1'],
        controlApiUrl: 'http://10.0.1.25:4310',
        artifactsBucket: 'bucket',
        credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
      }),
    /requires HTTPS controlApiUrl/,
  );
  assert.throws(
    () =>
      new AwsEcsFargateSpotDriver({
        region: 'ap-northeast-2',
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c',
        workerTaskDefinition: 'worker:1',
        verifierTaskDefinition: 'verifier:1',
        subnets: ['subnet-1'],
        securityGroups: ['sg-1'],
        controlApiUrl: 'http://example.com:4310',
        allowVpcInternalHttp: true,
        artifactsBucket: 'bucket',
        credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
      }),
    /requires HTTPS controlApiUrl/,
  );
  const vpcHttpDriver = new AwsEcsFargateSpotDriver({
    region: 'ap-northeast-2',
    clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c',
    workerTaskDefinition: 'worker:1',
    verifierTaskDefinition: 'verifier:1',
    subnets: ['subnet-1'],
    securityGroups: ['sg-1'],
    controlApiUrl: 'http://10.0.1.25:4310',
    allowVpcInternalHttp: true,
    artifactsBucket: 'bucket',
    credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
  });
  assert.equal(vpcHttpDriver.runtime, 'ecs');
});

test('createGitHubDraftPrPort enforces draft:true, blocks protected branches, and verifies treeSha before opening PR', async () => {
  const signal = new AbortController().signal;
  let capturedBody: Record<string, unknown> | null = null;
  const port = createGitHubDraftPrPort(
    {
      token: 'ghp_test_token_never_leak',
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({
            number: 55,
            html_url: 'https://github.com/roboco-io/project-hivemind/pull/55',
            draft: true,
            head: { sha: 'c'.repeat(40) },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
    },
    {
      async createIsolatedBranchCommit(input) {
        return { commitSha: 'c'.repeat(40), treeSha: input.expectedTreeHash };
      },
    },
  );

  const res = await port.publishDraftPr(
    {
      repository: 'roboco-io/project-hivemind',
      baseBranch: 'main',
      branchName: 'hivemind/dlv-1-r1',
      baseCommit: 'a'.repeat(40),
      patch: 'diff --git a/x b/x\n',
      expectedTreeHash: 'b'.repeat(40),
      title: '[HIVEMIND] Fix',
      body: 'Evidence body',
      draft: true,
    },
    signal,
  );
  assert.equal(res.prNumber, 55);
  assert.equal(res.prTreeHash, 'b'.repeat(40));
  assert.equal((capturedBody as Record<string, unknown> | null)?.draft, true);

  await assert.rejects(
    () =>
      port.publishDraftPr(
        {
          repository: 'roboco-io/project-hivemind',
          baseBranch: 'main',
          branchName: 'main',
          baseCommit: 'a'.repeat(40),
          patch: '',
          expectedTreeHash: 'b'.repeat(40),
          title: 'Bad',
          body: 'Bad',
          draft: true,
        },
        signal,
      ),
    /protected or non-isolated branch/,
  );

  const mismatchPort = createGitHubDraftPrPort(
    { token: 'ghp_test_token', fetchImpl: async () => new Response('{}', { status: 201 }) },
    {
      async createIsolatedBranchCommit() {
        return { commitSha: 'c'.repeat(40), treeSha: '9'.repeat(40) };
      },
    },
  );
  await assert.rejects(
    () =>
      mismatchPort.publishDraftPr(
        {
          repository: 'roboco-io/project-hivemind',
          baseBranch: 'main',
          branchName: 'hivemind/dlv-1-r1',
          baseCommit: 'a'.repeat(40),
          patch: '',
          expectedTreeHash: 'b'.repeat(40),
          title: 'Bad',
          body: 'Bad',
          draft: true,
        },
        signal,
      ),
    /treeSha does not match/,
  );
});
