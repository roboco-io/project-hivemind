import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { CollabSessionSnapshot } from '../packages/contracts/src/agent-collab.js';
import { openSsmTunnel } from './lib/aws-live.js';

function awsJson(profile: string, region: string, args: string[]): unknown {
  const out = execFileSync('aws', ['--profile', profile, '--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function getOperatorToken(profile: string, region: string, secretArn: string): string {
  const res = awsJson(profile, region, ['secretsmanager', 'get-secret-value', '--secret-id', secretArn]) as {
    SecretString?: string;
  };
  if (!res.SecretString) throw new Error('Operator token missing');
  return res.SecretString.trim();
}

async function apiJson<T>(url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}: ${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = 'ap-northeast-2';
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14325');
  const runtimeOut = (
    JSON.parse(readFileSync('/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<string, Record<string, string>>
  ).HivemindAwsRuntimeStack!;

  const cluster = runtimeOut.ClusterName!;
  const service = runtimeOut.ControlPlaneServiceName!;
  const operatorToken = getOperatorToken(profile, region, runtimeOut.OperatorTokenSecretArn!);

  const tunnel = openSsmTunnel(profile, region, cluster, service, localPort);
  await tunnel.ready;
  const baseUrl = `http://127.0.0.1:${localPort}`;

  try {
    // 1. Verify live Aurora DSQL backend on deployed Seoul ControlPlaneService.
    const listed = await apiJson<{ storageBackend: string; sessions: unknown[] }>(
      `${baseUrl}/api/collab/sessions`,
      operatorToken,
    );
    if (listed.storageBackend !== 'aurora-dsql') {
      throw new Error(`Expected storageBackend=aurora-dsql, got ${listed.storageBackend}`);
    }

    // 2. Create a multi-agent collaboration session persisted in Amazon Aurora DSQL.
    const session = await apiJson<{ id: string }>(`${baseUrl}/api/collab/sessions`, operatorToken, {
      title: 'Aurora DSQL Live Multi-Agent Collab Proof',
      goal: 'Verify DAG subtasks, shared agent message board, and work logs on real Aurora DSQL in Seoul',
      provider: 'claude',
      maxParallelWorkers: 3,
      allowedRegions: ['us-east-1', 'us-east-2', 'us-west-2', 'ap-northeast-1', 'ap-northeast-2'],
    });

    const subA = await apiJson<{ id: string }>(`${baseUrl}/api/collab/sessions/${session.id}/subtasks`, operatorToken, {
      title: 'Agent A: Dataset curation',
      instructions: 'Collect Verilog samples',
    });
    const subB = await apiJson<{ id: string }>(`${baseUrl}/api/collab/sessions/${session.id}/subtasks`, operatorToken, {
      title: 'Agent B: Eval harness',
      instructions: 'Build NDCG@10 evaluator',
    });
    const subC = await apiJson<{ id: string }>(`${baseUrl}/api/collab/sessions/${session.id}/subtasks`, operatorToken, {
      title: 'Agent C: Synthesis',
      instructions: 'Combine A and B outputs',
      dependsOn: [subA.id, subB.id],
    });

    // Claim A & B, exchange messages on the shared DSQL board, append work log, finish A & B, unlock C!
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/subtasks/${subA.id}/claim`, operatorToken, {
      agentId: 'spot-agent-a',
      region: 'us-east-2',
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/subtasks/${subB.id}/claim`, operatorToken, {
      agentId: 'spot-agent-b',
      region: 'us-west-2',
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/messages`, operatorToken, {
      sender: 'spot-agent-a',
      recipient: 'spot-agent-b',
      kind: 'handoff',
      body: 'Uploaded dataset manifest to Seoul KMS S3 for cross-agent eval.',
      artifactRefs: ['s3://hivemind-runtime-<AWS_ACCOUNT_ID>-ap-northeast-2-artifacts/collab/proof.json'],
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/work-logs`, operatorToken, {
      subtaskId: subA.id,
      agentId: 'spot-agent-a',
      kind: 'artifact',
      summary: 'Dataset curated and hashed',
      s3Uri: 's3://hivemind-runtime-<AWS_ACCOUNT_ID>-ap-northeast-2-artifacts/collab/proof.json',
      sha256: 'a'.repeat(64),
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/subtasks/${subA.id}/finish`, operatorToken, {
      agentId: 'spot-agent-a',
      status: 'completed',
      summary: 'Dataset ready',
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/subtasks/${subB.id}/finish`, operatorToken, {
      agentId: 'spot-agent-b',
      status: 'completed',
      summary: 'Evaluator ready',
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/subtasks/${subC.id}/claim`, operatorToken, {
      agentId: 'spot-agent-c',
      region: 'ap-northeast-1',
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/subtasks/${subC.id}/finish`, operatorToken, {
      agentId: 'spot-agent-c',
      status: 'completed',
      summary: 'Synthesis complete',
    });
    await apiJson(`${baseUrl}/api/collab/sessions/${session.id}/complete`, operatorToken, {
      status: 'completed',
    });

    const snapshot = await apiJson<CollabSessionSnapshot>(`${baseUrl}/api/collab/sessions/${session.id}`, operatorToken);
    console.log(
      JSON.stringify(
        {
          ok:
            snapshot.storageBackend === 'aurora-dsql' &&
            snapshot.session.status === 'completed' &&
            snapshot.subtasks.length === 3 &&
            snapshot.subtasks.every((s) => s.status === 'completed') &&
            snapshot.messages.length >= 1 &&
            snapshot.workLogs.length === 1,
          dsqlEndpoint: runtimeOut.DsqlClusterEndpoint,
          storageBackend: snapshot.storageBackend,
          sessionId: snapshot.session.id,
          subtaskRegions: snapshot.subtasks.map((s) => ({ title: s.title, region: s.region, status: s.status })),
          messageCount: snapshot.messages.length,
          workLogCount: snapshot.workLogs.length,
        },
        null,
        2,
      ),
    );
  } finally {
    tunnel.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
