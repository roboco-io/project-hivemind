import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapExitCode,
  describeModelAuth,
  formatBootstrapReport,
  runBootstrap,
  spokeStackName,
  TSX_LOADER,
  type BootstrapOptions,
  type BootstrapSystem,
} from '../scripts/lib/bootstrap.js';

const ACCOUNT = '123456789012';

interface World {
  stacks: Set<string>; // `${region}/${name}`
  hubHasRoleOutputs: boolean;
  images: Set<string>;
  secrets: Record<string, string>;
  files: Record<string, string>;
  failOn?: (command: string, args: string[]) => string | undefined;
  verify: Record<string, string | null>;
}

function freshAccount(): World {
  return {
    stacks: new Set(),
    hubHasRoleOutputs: false,
    images: new Set(),
    secrets: {
      'hivemind-runtime/operator-token': 'operator-token-value-0000000000000000',
      'hivemind-runtime/model-subscription-auth': 'randomInitialPassword',
      'hivemind-runtime/github-draft-pr': 'randomInitialPassword',
      'hivemind-runtime/hf-release-token': 'randomInitialPassword',
    },
    files: { [TSX_LOADER]: 'loader' },
    verify: { delivery: 'aurora-dsql', modelFactory: 'aurora-dsql', collab: 'aurora-dsql' },
  };
}

function makeSystem(world: World) {
  const commands: { command: string; args: string[]; env?: Record<string, string>; hadInput: boolean }[] = [];
  const written: Record<string, string> = {};
  const logs: string[] = [];
  let verifyCalls = 0;
  const system: BootstrapSystem = {
    aws(region, args) {
      const [service, action] = args;
      const arg = (flag: string) => args[args.indexOf(flag) + 1]!;
      if (service === 'sts') return ACCOUNT;
      if (service === 'cloudformation' && action === 'describe-stacks') {
        const name = arg('--stack-name');
        if (!world.stacks.has(`${region}/${name}`)) throw new Error(`Stack with id ${name} does not exist`);
        if (arg('--query') === 'Stacks[0].StackStatus') return 'UPDATE_COMPLETE';
        return JSON.stringify(
          name === 'HivemindAwsRuntimeStack' && world.hubHasRoleOutputs
            ? [{ OutputKey: 'ControlPlaneTaskRoleArn', OutputValue: `arn:aws:iam::${ACCOUNT}:role/cp` }]
            : [{ OutputKey: 'ClusterName', OutputValue: 'c' }],
        );
      }
      if (service === 'ecr' && action === 'describe-images') {
        if (!world.images.has(arg('--repository-name'))) throw new Error('ImageNotFoundException');
        return 'sha256:abc';
      }
      if (service === 'ecr' && action === 'get-login-password') return 'ecr-password';
      if (service === 'secretsmanager' && action === 'get-secret-value') return world.secrets[arg('--secret-id')] ?? '';
      if (service === 'secretsmanager' && action === 'put-secret-value') {
        world.secrets[arg('--secret-id')] = world.files[arg('--secret-string').replace('file://', '')]!;
        return 'version-1';
      }
      throw new Error(`unexpected aws call: ${args.join(' ')}`);
    },
    run(command, args, options) {
      commands.push({ command, args, ...(options?.env ? { env: options.env } : {}), hadInput: options?.input !== undefined });
      const failure = world.failOn?.(command, args);
      if (failure) throw new Error(failure);
      // Model the effect of each mutating command on the world.
      if (command === 'cdk' && args[0] === 'bootstrap') world.stacks.add(`${args[1]!.split('/').pop()}/CDKToolkit`);
      if (command === 'bash' && args[0] === 'scripts/aws-deploy-hub.sh') {
        world.stacks.add(`${options!.env!.HIVEMIND_AWS_REGION}/HivemindAwsRuntimeStack`);
        world.hubHasRoleOutputs = true;
      }
      if (command === 'bash' && args[0] === 'scripts/aws-deploy-spoke.sh') world.stacks.add(`${args[1]}/${spokeStackName(args[1]!)}`);
      if (command === 'docker' && args[0] === 'push') world.images.add(args[1]!.split('/').pop()!.replace(':latest', ''));
      if (command === 'node' && args.includes('scripts/aws-set-github-app-secret.ts')) {
        world.secrets['hivemind-runtime/github-draft-pr'] = JSON.stringify({ githubApp: { appId: options!.env!.HIVEMIND_GITHUB_APP_ID, privateKeyPem: 'x', repositories: options!.env!.HIVEMIND_GITHUB_APP_REPOSITORIES!.split(',') } });
      }
      if (command === 'node' && args.includes('scripts/aws-set-hf-secret.ts')) world.secrets['hivemind-runtime/hf-release-token'] = JSON.stringify({ token: 'stored' });
      return '';
    },
    fileExists: (path) => path in world.files,
    readFile: (path) => {
      if (!(path in world.files)) throw new Error(`ENOENT: ${path}`);
      return world.files[path]!;
    },
    writeSecretFile: (path, content) => void (written[path] = content),
    configureClients: () => ['.mcp.json', '.codex/config.toml'],
    verifyControlPlane: async () => {
      verifyCalls += 1;
      return world.verify;
    },
    log: (line) => void logs.push(line),
  };
  return { system, commands, written, logs, verifyCalls: () => verifyCalls };
}

const baseOptions = (overrides: Partial<BootstrapOptions> = {}): BootstrapOptions => ({
  primaryRegion: 'ap-northeast-2',
  prefix: 'hivemind-runtime',
  spokeRegions: [],
  projectRoot: '/repo',
  localApiPort: 4311,
  operatorTokenFile: '/home/op/.hivemind/aws-operator-token.json',
  ...overrides,
});
const statusOf = (results: Awaited<ReturnType<typeof runBootstrap>>) => Object.fromEntries(results.map((r) => [r.id, r.status]));
const describe = (c: { command: string; args: string[] }) => `${c.command} ${c.args.filter((a) => !a.startsWith('--import') && a !== TSX_LOADER).slice(0, 3).join(' ')}`;

test('bootstrap on an empty account creates resources in the safe order and reports missing credentials without failing', async () => {
  const world = freshAccount();
  const { system, commands, written, verifyCalls } = makeSystem(world);
  const results = await runBootstrap(baseOptions(), system);

  assert.deepEqual(statusOf(results), {
    preflight: 'done',
    'cdk-bootstrap': 'done',
    'hub-initial': 'done',
    images: 'done',
    spokes: 'skipped',
    'dsql-roles': 'done',
    'hub-final': 'done',
    'model-auth': 'skipped',
    'github-app': 'skipped',
    'hf-token': 'skipped',
    'client-config': 'done',
    verify: 'done',
  });
  assert.equal(bootstrapExitCode(results), 0, 'skipped credentials are a reported gap, not a failure');

  const order = commands.map(describe);
  const at = (prefix: string) => order.findIndex((c) => c.startsWith(prefix));
  // First Hub deploy (admin) -> images -> DSQL roles -> final Hub deploy (restricted).
  const hubDeploys = commands.filter((c) => c.command === 'bash' && c.args[0] === 'scripts/aws-deploy-hub.sh');
  assert.equal(hubDeploys.length, 2);
  assert.equal(hubDeploys[0]!.env!.HIVEMIND_RESTRICTED_DSQL_ROLES, '0', 'the restricted roles do not exist at the first deploy');
  assert.equal(hubDeploys[1]!.env!.HIVEMIND_RESTRICTED_DSQL_ROLES, '1');
  assert.equal(hubDeploys[0]!.env!.HIVEMIND_SPOKE_REGIONS, 'none');
  assert.ok(at('cdk bootstrap') < at('bash scripts/aws-deploy-hub.sh'));
  assert.ok(at('bash scripts/aws-deploy-hub.sh') < at('docker login'));
  assert.ok(at('docker push') < at('node scripts/aws-dsql-apply-roles.ts'));
  assert.ok(at('node scripts/aws-dsql-apply-roles.ts') < order.lastIndexOf('bash scripts/aws-deploy-hub.sh deploy'));
  assert.equal(order.filter((c) => c.startsWith('docker build')).length, 3);
  // The ECR password goes to docker through stdin, never as an argument.
  const login = commands.find((c) => c.command === 'docker' && c.args[0] === 'login')!;
  assert.ok(login.hadInput && !login.args.includes('ecr-password'));

  // The operator token is written to the 600 file only; it is not in any command line or log.
  assert.deepEqual(JSON.parse(written['/home/op/.hivemind/aws-operator-token.json']!), { OPERATOR_TOKEN: 'operator-token-value-0000000000000000' });
  assert.ok(!JSON.stringify(commands).includes('operator-token-value'));
  assert.equal(verifyCalls(), 1);

  const report = formatBootstrapReport(results);
  assert.match(report, /아직 동작하지 않는 기능:/);
  assert.match(report, /모델 구독 인증: 워커의 모델 호출/);
  assert.match(report, /GitHub App: Draft PR 게시/);
  assert.match(report, /Hugging Face 토큰: Model Factory 산출물의 Hugging Face 공개/);
  assert.ok(!report.includes('operator-token-value'));
});

test('running the bootstrap again changes nothing that already exists and keeps deployed spokes in the Hub configuration', async () => {
  const world = freshAccount();
  await runBootstrap(baseOptions({ spokeRegions: ['us-east-2'] }), makeSystem(world).system);
  world.secrets['hivemind-runtime/model-subscription-auth'] = JSON.stringify({ codex: { authJson: '{}' } });

  const second = makeSystem(world);
  // No --spokes this time: the us-east-2 spoke from the first run must still be passed to the Hub.
  const results = await runBootstrap(baseOptions(), second.system);
  assert.deepEqual(statusOf(results), {
    preflight: 'done',
    'cdk-bootstrap': 'already_done',
    'hub-initial': 'already_done',
    images: 'already_done',
    spokes: 'already_done',
    'dsql-roles': 'done',
    'hub-final': 'done',
    'model-auth': 'already_done',
    'github-app': 'skipped',
    'hf-token': 'skipped',
    'client-config': 'done',
    verify: 'done',
  });
  const mutating = second.commands.map(describe).filter((c) => /cdk bootstrap|docker (build|push|login)|aws-deploy-spoke/.test(c));
  assert.deepEqual(mutating, []);
  const hubDeploys = second.commands.filter((c) => c.args[0] === 'scripts/aws-deploy-hub.sh');
  assert.equal(hubDeploys.length, 1, 'only the idempotent final deploy runs');
  assert.equal(hubDeploys[0]!.env!.HIVEMIND_SPOKE_REGIONS, 'us-east-2');
  assert.equal(hubDeploys[0]!.env!.HIVEMIND_RESTRICTED_DSQL_ROLES, '1');
});

test('supplied credentials are registered, and a bad credential fails only its own step', async () => {
  const world = freshAccount();
  world.files['/in/model.json'] = JSON.stringify({ codex: { authJson: '{"tokens":{}}' }, claude: { apiKey: 'sk-ant-x' } });
  world.files['/in/app.pem'] = '-----BEGIN RSA PRIVATE KEY-----';
  world.files['/in/hf.txt'] = 'hf_token_value\n';
  const first = makeSystem(world);
  const ok = await runBootstrap(
    baseOptions({ modelAuthFile: '/in/model.json', githubAppId: '5939785', githubAppKeyFile: '/in/app.pem', githubAppRepositories: ['roboco-io/project-hivemind'], hfTokenFile: '/in/hf.txt' }),
    first.system,
  );
  assert.equal(statusOf(ok)['model-auth'], 'done');
  assert.equal(statusOf(ok)['github-app'], 'done');
  assert.equal(statusOf(ok)['hf-token'], 'done');
  assert.match(ok.find((r) => r.id === 'model-auth')!.detail, /codex, claude/);
  // The model auth goes to Secrets Manager as a file reference; the HF token goes through stdin.
  assert.deepEqual(describeModelAuth(JSON.parse(world.secrets['hivemind-runtime/model-subscription-auth']!)), ['codex', 'claude']);
  const hf = first.commands.find((c) => c.args.includes('scripts/aws-set-hf-secret.ts'))!;
  assert.ok(hf.hadInput);
  assert.ok(!JSON.stringify(first.commands).includes('hf_token_value'));
  assert.ok(!JSON.stringify(first.commands).includes('sk-ant-x'));
  // With every credential supplied, the only reported gap is the optional spoke deployment.
  const gaps = formatBootstrapReport(ok).split('아직 동작하지 않는 기능:')[1] ?? '';
  assert.match(gaps, /Spoke 배포: 다중 리전 스팟 학습의 자동 배치/);
  assert.ok(!/모델 구독 인증|GitHub App|Hugging Face/.test(gaps));

  // A model auth file without usable credentials and a missing key file: those two steps fail, the rest still run.
  const broken = freshAccount();
  broken.files['/in/empty.json'] = JSON.stringify({ codex: {} });
  const second = makeSystem(broken);
  const results = await runBootstrap(baseOptions({ modelAuthFile: '/in/empty.json', githubAppId: '1', githubAppKeyFile: '/in/missing.pem', githubAppRepositories: ['a/b'] }), second.system);
  const status = statusOf(results);
  assert.equal(status['model-auth'], 'failed');
  assert.equal(status['github-app'], 'failed');
  assert.equal(status['client-config'], 'done');
  assert.equal(status.verify, 'done');
  assert.equal(bootstrapExitCode(results), 1);
});

test('a failed resource step stops later resource steps, and dry-run changes nothing', async () => {
  const world = freshAccount();
  world.failOn = (command, args) => (command === 'docker' && args[0] === 'build' ? 'docker build failed: no space left on device' : undefined);
  const failing = makeSystem(world);
  const results = await runBootstrap(baseOptions(), failing.system);
  const status = statusOf(results);
  assert.equal(status.images, 'failed');
  for (const id of ['spokes', 'dsql-roles', 'hub-final', 'model-auth', 'client-config', 'verify']) assert.equal(status[id], 'not_run', id);
  assert.match(results.find((r) => r.id === 'images')!.detail, /no space left on device/);
  assert.equal(failing.verifyCalls(), 0);
  assert.equal(bootstrapExitCode(results), 1);
  // The restricted Hub deploy never ran, so the services were not switched before the roles existed.
  assert.ok(!failing.commands.some((c) => c.env?.HIVEMIND_RESTRICTED_DSQL_ROLES === '1'));

  const dryWorld = freshAccount();
  const dry = makeSystem(dryWorld);
  const planned = await runBootstrap(baseOptions({ dryRun: true, spokeRegions: ['us-east-1'] }), dry.system);
  assert.deepEqual(dry.commands.map(describe), ['docker info --format {{.ServerVersion}}', 'cdk --version'], 'dry-run runs only the read-only tool checks');
  assert.deepEqual(dry.written, {});
  assert.equal(dry.verifyCalls(), 0);
  assert.equal(statusOf(planned)['hub-initial'], 'would_run');
  assert.equal(statusOf(planned).spokes, 'would_run');
  assert.equal(dryWorld.stacks.size, 0);

  await assert.rejects(() => runBootstrap(baseOptions({ spokeRegions: ['eu-west-1'] }), makeSystem(freshAccount()).system), /Unknown spoke region/);
});

test('a local client configuration problem is reported but does not stop the cloud verification', async () => {
  const world = freshAccount();
  const { system, verifyCalls } = makeSystem(world);
  system.configureClients = () => {
    throw new Error('.mcp.json 을 쓰지 못했습니다: Managed HIVEMIND MCP settings were changed outside the installer.');
  };
  const results = await runBootstrap(baseOptions(), system);
  const status = statusOf(results);
  assert.equal(status['client-config'], 'failed');
  assert.equal(status.verify, 'done');
  assert.equal(verifyCalls(), 1);
  assert.match(formatBootstrapReport(results), /로컬 MCP 클라이언트 설정: 이 컴퓨터의 Claude Code와 Codex에서/);
  assert.equal(bootstrapExitCode(results), 1);
});

test('verification reports a store that does not answer as a failure', async () => {
  const world = freshAccount();
  world.verify = { delivery: 'aurora-dsql', modelFactory: null, collab: 'aurora-dsql' };
  const results = await runBootstrap(baseOptions(), makeSystem(world).system);
  const verify = results.find((r) => r.id === 'verify')!;
  assert.equal(verify.status, 'failed');
  assert.match(verify.detail, /modelFactory=응답 없음/);
});
