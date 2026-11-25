import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function awsJson(profile: string, region: string, args: string[]): unknown {
  return JSON.parse(
    execFileSync('aws', ['--profile', profile, '--region', region, ...args, '--output', 'json'], {
      encoding: 'utf8',
    }),
  );
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const outputsPath = process.env.HIVEMIND_CDK_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json';
  const outputs = (JSON.parse(readFileSync(outputsPath, 'utf8')) as Record<string, Record<string, string>>)
    .HivemindAwsRuntimeStack;
  if (!outputs) throw new Error('Missing HivemindAwsRuntimeStack outputs');

  const cluster = outputs.ClusterName!;
  const service = outputs.ControlPlaneServiceName!;
  const operatorToken = (
    awsJson(profile, region, ['secretsmanager', 'get-secret-value', '--secret-id', outputs.OperatorTokenSecretArn!]) as {
      SecretString: string;
    }
  ).SecretString.trim();

  const listed = awsJson(profile, region, [
    'ecs',
    'list-tasks',
    '--cluster',
    cluster,
    '--service-name',
    service,
    '--desired-status',
    'RUNNING',
  ]) as { taskArns?: string[] };
  const taskArn = listed.taskArns?.[0];
  if (!taskArn) throw new Error('No RUNNING ControlPlaneService task');

  const desc = awsJson(profile, region, ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]) as {
    tasks?: { containers?: { name?: string; runtimeId?: string }[] }[];
  };
  const runtimeId = desc.tasks?.[0]?.containers?.find((c) => c.name === 'control-plane')?.runtimeId;
  const ecsTaskId = taskArn.split('/').pop();
  if (!ecsTaskId || !runtimeId) throw new Error('Missing runtimeId for SSM Exec');

  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14315');
  const target = `ecs:${cluster}_${ecsTaskId}_${runtimeId}`;
  const tunnel = spawn(
    'aws',
    [
      '--profile',
      profile,
      '--region',
      region,
      'ssm',
      'start-session',
      '--target',
      target,
      '--document-name',
      'AWS-StartPortForwardingSession',
      '--parameters',
      JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(localPort)] }),
    ],
    { stdio: 'ignore' },
  );

  const client = new Client({ name: 'hivemind-aws-ssm-verifier', version: '0.1.0' });
  try {
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // wait for tunnel
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) throw new Error('SSM tunnel failed to reach /health');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/apps/mcp-server/src/main.js'],
      env: {
        PATH: process.env.PATH ?? '',
        HIVEMIND_MCP_PROFILE: 'delivery',
        HIVEMIND_API_URL: `http://127.0.0.1:${localPort}`,
        HIVEMIND_OPERATOR_TOKEN: operatorToken,
      },
    });
    await client.connect(transport);

    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map((t) => t.name).sort();
    const listResult = await client.callTool({ name: 'hivemind_delivery_list', arguments: {} });
    const listRaw = JSON.stringify(listResult);
    if (listRaw.includes(operatorToken)) {
      throw new Error('Operator token leaked in MCP hivemind_delivery_list output');
    }
    const structuredList = listResult.structuredContent as { tasks?: { id: string; status: string }[] } | undefined;
    const approvedTask = structuredList?.tasks?.find((t) => t.status === 'approved') ?? structuredList?.tasks?.[0];
    if (!approvedTask) throw new Error('No delivery tasks returned from live AWS ControlPlaneService');

    const getResult = await client.callTool({
      name: 'hivemind_delivery_get',
      arguments: { taskId: approvedTask.id },
    });
    const getRaw = JSON.stringify(getResult);
    if (getRaw.includes(operatorToken)) {
      throw new Error('Operator token leaked in MCP hivemind_delivery_get output');
    }
    const detail = getResult.structuredContent as {
      task?: {
        id: string;
        status: string;
        publication?: { prNumber: number; prUrl: string; verifiedTreeHash: string; prTreeHash: string } | null;
        humanDecision?: { decision: string; openedDiff: boolean; durationMinutes: number } | null;
      };
    };

    console.log(
      JSON.stringify(
        {
          verified: true,
          profile: 'delivery',
          toolCount: toolNames.length,
          tools: toolNames,
          liveTaskCount: structuredList?.tasks?.length ?? 0,
          inspectedTaskId: detail.task?.id,
          inspectedStatus: detail.task?.status,
          prUrl: detail.task?.publication?.prUrl ?? null,
          treeHashMatch:
            Boolean(detail.task?.publication) &&
            detail.task?.publication?.verifiedTreeHash === detail.task?.publication?.prTreeHash,
          humanDecision: detail.task?.humanDecision ?? null,
          operatorTokenLeaked: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close().catch(() => undefined);
    if (!tunnel.killed) tunnel.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
