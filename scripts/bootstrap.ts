import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapExitCode, formatBootstrapReport, KNOWN_SPOKE_CIDRS, runBootstrap, type BootstrapOptions, type BootstrapSystem } from './lib/bootstrap.js';

const HELP = `HIVEMIND 부트스트랩: AWS 리소스 생성, 인증 등록, 로컬 MCP 설정, 동작 확인을 순서대로 수행합니다.
이미 끝난 단계는 건너뛰므로 여러 번 실행해도 됩니다.

사용법: npm run bootstrap -- [옵션]

  --profile <이름>                  AWS 프로필 (기본: AWS_PROFILE 또는 roboco)
  --region <리전>                   Hub 리전 (기본: ap-northeast-2)
  --spokes <리전,리전>              추가로 배포할 Spoke 리전. 가능한 값: ${Object.keys(KNOWN_SPOKE_CIDRS).join(', ')}
                                    이미 배포된 Spoke는 지정하지 않아도 유지됩니다.
  --model-auth-file <경로>          모델 구독 인증 JSON ({"codex":{"authJson":"..."}} 또는 {"claude":{...}})
  --github-app-id <ID>              GitHub App ID
  --github-app-key-file <경로>      GitHub App private key (.pem)
  --github-app-repositories <a,b>   Draft PR을 만들 저장소 (owner/name)
  --hf-token-file <경로>            Hugging Face 토큰이 든 파일
  --rebuild-images                  이미지가 있어도 다시 빌드해 푸시
  --skip-client-config              로컬 MCP 클라이언트 설정을 쓰지 않음
  --skip-verify                     Control Plane을 켜서 확인하는 단계를 생략
  --dry-run                         아무것도 바꾸지 않고 각 단계가 할 일만 보고
  --help                            이 도움말

주어지지 않은 인증 값은 건너뛰고, 끝에 무엇이 빠졌고 어떤 기능이 동작하지 않는지 보고합니다.
GitHub App 생성·설치, 모델 구독 로그인, Hugging Face 토큰 발급은 사람이 웹에서 해야 합니다.
`;

function parseArgs(argv: string[]): Record<string, string | true> {
  const flags = new Set(['rebuild-images', 'skip-client-config', 'skip-verify', 'dry-run', 'help']);
  const valued = new Set(['profile', 'region', 'spokes', 'model-auth-file', 'github-app-id', 'github-app-key-file', 'github-app-repositories', 'hf-token-file']);
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`알 수 없는 인자: ${arg}`);
    const name = arg.slice(2);
    if (flags.has(name)) out[name] = true;
    else if (valued.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 에 값이 필요합니다.`);
      out[name] = value;
      i += 1;
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(projectRoot);
  // The live helpers read AWS_PROFILE when they are imported, so the profile is fixed before that.
  const profile = typeof args.profile === 'string' ? args.profile : (process.env.AWS_PROFILE ?? 'roboco');
  process.env.AWS_PROFILE = profile;
  const list = (value: string | true | undefined) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const path = (value: string | true | undefined) => (typeof value === 'string' ? resolve(value) : undefined);

  const options: BootstrapOptions = {
    primaryRegion: typeof args.region === 'string' ? args.region : (process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2'),
    prefix: process.env.HIVEMIND_AWS_PREFIX ?? 'hivemind-runtime',
    spokeRegions: list(args.spokes),
    ...(path(args['model-auth-file']) ? { modelAuthFile: path(args['model-auth-file'])! } : {}),
    ...(typeof args['github-app-id'] === 'string' ? { githubAppId: args['github-app-id'] } : {}),
    ...(path(args['github-app-key-file']) ? { githubAppKeyFile: path(args['github-app-key-file'])! } : {}),
    ...(list(args['github-app-repositories']).length ? { githubAppRepositories: list(args['github-app-repositories']) } : {}),
    ...(path(args['hf-token-file']) ? { hfTokenFile: path(args['hf-token-file'])! } : {}),
    rebuildImages: args['rebuild-images'] === true,
    skipClientConfig: args['skip-client-config'] === true,
    skipVerify: args['skip-verify'] === true,
    dryRun: args['dry-run'] === true,
    projectRoot,
    localApiPort: Number(process.env.HIVEMIND_LOCAL_PORT ?? '4311'),
    operatorTokenFile: join(homedir(), '.hivemind', 'aws-operator-token.json'),
    agentTokenFile: join(homedir(), '.hivemind', 'aws-agent-token.json'),
    controlPlaneConfigFile: join(homedir(), '.hivemind', 'aws-control-plane.json'),
    profile,
  };

  const system: BootstrapSystem = {
    aws: (region, awsArgs) =>
      execFileSync('aws', ['--profile', profile, '--region', region, ...awsArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    run: (command, commandArgs, runOptions) => {
      try {
        return execFileSync(command, commandArgs, {
          encoding: 'utf8',
          cwd: projectRoot,
          env: { ...process.env, AWS_PROFILE: profile, ...(runOptions?.env ?? {}) },
          input: runOptions?.input,
          stdio: [runOptions?.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
        }).trim();
      } catch (error) {
        const failure = error as { stderr?: string; stdout?: string; message: string };
        // Only the tail: build and deploy output is long, and the last lines name the cause.
        const tail = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
        throw new Error(`${command} ${commandArgs.slice(0, 3).join(' ')} 실패: ${tail || failure.message}`);
      }
    },
    fileExists: (file) => existsSync(file),
    readFile: (file) => readFileSync(file, 'utf8'),
    writeSecretFile: (file, content) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, content, { mode: 0o600 });
      chmodSync(file, 0o600); // an existing file keeps its old mode unless it is set again
    },
    configureClients: (input) => {
      // The existing installers own the format and the safety checks of both client configuration files.
      // They refuse to overwrite an entry that was edited by hand; their message is passed on unchanged.
      const written: string[] = [];
      for (const [script, file] of [['scripts/configure-hivemind-claude.ts', '.mcp.json'], ['scripts/configure-hivemind-mcp.ts', '.codex/config.toml']] as const) {
        try {
          execFileSync(process.execPath, [script, '--project-root', input.projectRoot, '--api-url', input.apiUrl, '--operator-token-file', input.operatorTokenFile], {
            encoding: 'utf8',
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          const stderr = String((error as { stderr?: string }).stderr ?? '').trim().split('\n').pop() ?? '';
          throw new Error(`${file} 을 쓰지 못했습니다: ${stderr || '설치기가 거절했습니다.'} 이 파일의 hivemind 항목을 손으로 고쳤다면 원래대로 되돌린 뒤 다시 실행하세요.`);
        }
        written.push(file);
      }
      return written;
    },
    verifyControlPlane: async () => {
      const live = await import('./lib/aws-live.js');
      const outputs = Object.fromEntries(
        (JSON.parse(system.aws(options.primaryRegion, ['cloudformation', 'describe-stacks', '--stack-name', 'HivemindAwsRuntimeStack', '--query', 'Stacks[0].Outputs', '--output', 'json'])) as { OutputKey: string; OutputValue: string }[])
          .map((o) => [o.OutputKey, o.OutputValue]),
      );
      const controlPlane = live.ControlPlane.fromOutputs(outputs, Number(process.env.HIVEMIND_BOOTSTRAP_VERIFY_PORT ?? '14391'));
      const token = live.loadOperatorToken(outputs);
      const backends: Record<string, string | null> = { delivery: null, modelFactory: null, collab: null };
      try {
        await controlPlane.start();
        const read = async (store: string, apiPath: string) => {
          try {
            const body = await live.apiJson<{ storageBackend?: string }>(`${controlPlane.baseUrl}${apiPath}`, token, undefined, 30_000);
            backends[store] = body.storageBackend ?? null;
          } catch {
            backends[store] = null;
          }
        };
        await read('delivery', '/api/delivery/tasks');
        await read('modelFactory', '/api/model-factory/jobs');
        await read('collab', '/api/collab/sessions');
      } finally {
        await controlPlane.stop();
      }
      return backends;
    },
    log: (line) => process.stderr.write(`${line}\n`),
  };

  const results = await runBootstrap(options, system);
  process.stdout.write(`\n${formatBootstrapReport(results)}\n`);
  process.exitCode = bootstrapExitCode(results);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
