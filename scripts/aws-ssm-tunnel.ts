import { execFileSync, spawn } from 'node:child_process';

const profile = process.env.AWS_PROFILE ?? 'roboco';
const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
const cluster = process.env.HIVEMIND_ECS_CLUSTER ?? 'hivemind-runtime-cluster';
const service = process.env.HIVEMIND_CONTROL_PLANE_SERVICE ?? 'hivemind-runtime-control-plane';
const localPort = process.env.HIVEMIND_LOCAL_PORT ?? '4310';

function awsJson(args: string[]): unknown {
  const out = execFileSync('aws', ['--profile', profile, '--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const listed = awsJson([
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
if (!taskArn) {
  console.error(`No RUNNING task found for service ${service} in cluster ${cluster}.`);
  process.exit(1);
}

const described = awsJson(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]) as {
  tasks?: { containers?: { name?: string; runtimeId?: string }[] }[];
};
const container = described.tasks?.[0]?.containers?.find((c) => c.name === 'control-plane');
const runtimeId = container?.runtimeId;
const taskId = taskArn.split('/').pop();
if (!taskId || !runtimeId) {
  console.error('Control plane task is missing taskId or runtimeId (is ECS Exec ready?).');
  process.exit(1);
}

const target = `ecs:${cluster}_${taskId}_${runtimeId}`;
console.log(`Opening AWS SSM port-forward tunnel: http://127.0.0.1:${localPort} -> ${target}:4310`);

const child = spawn(
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
    JSON.stringify({ portNumber: ['4310'], localPortNumber: [localPort] }),
  ],
  { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
