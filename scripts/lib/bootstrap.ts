/**
 * HIVEMIND bootstrap: the ordered, repeatable set-up of the AWS single path.
 *
 * It creates the cloud resources, registers the credentials the operator supplies, writes the local MCP
 * client configuration, and checks the result. Every step first looks at what already exists, so running
 * the bootstrap again does only what is missing. A credential the operator did not supply is skipped and
 * reported together with the feature that will not work without it; it never stops the other steps.
 *
 * This module holds the decisions and the order. Everything that touches AWS, Docker, the file system or
 * the network goes through `BootstrapSystem`, so the logic is tested without any of them.
 */
export const KNOWN_SPOKE_CIDRS: Record<string, string> = {
  'us-east-2': '10.1.0.0/16',
  'us-east-1': '10.2.0.0/16',
  'us-west-2': '10.3.0.0/16',
  'ap-northeast-1': '10.4.0.0/16',
};
export const IMAGES = [
  { name: 'control-plane', dockerfile: 'infra/aws/Dockerfile.control-plane' },
  { name: 'worker', dockerfile: 'infra/aws/Dockerfile.worker' },
  { name: 'verifier', dockerfile: 'infra/aws/Dockerfile.verifier' },
] as const;
const HUB_STACK = 'HivemindAwsRuntimeStack';
/** TypeScript loader shipped with the CDK package; sub-scripts run through it, with no download at run time. */
export const TSX_LOADER = './infrastructure/aws-runtime/node_modules/tsx/dist/loader.mjs';
const tsx = (script: string) => ['--import', TSX_LOADER, script];

export interface BootstrapOptions {
  primaryRegion: string;
  prefix: string;
  /** Spoke regions the operator asked for. Spokes that already exist are always kept as well. */
  spokeRegions: string[];
  /** JSON file with `{"codex":{"authJson"|"apiKey"}}` and/or `{"claude":{...}}`. */
  modelAuthFile?: string;
  githubAppId?: string;
  githubAppKeyFile?: string;
  githubAppRepositories?: string[];
  /** File that holds the Hugging Face token. */
  hfTokenFile?: string;
  rebuildImages?: boolean;
  skipClientConfig?: boolean;
  skipVerify?: boolean;
  /** Look only: report what each step would do and change nothing. */
  dryRun?: boolean;
  projectRoot: string;
  localApiPort: number;
  operatorTokenFile: string;
  /** Where the Model Factory agent token is written (mode 600). The agent's MCP profile reads it. */
  agentTokenFile?: string;
  /** Non-secret file that tells the MCP server how to start the dormant Control Plane. */
  controlPlaneConfigFile: string;
  /** AWS profile recorded in that file. */
  profile?: string;
}

export type StepStatus = 'done' | 'already_done' | 'skipped' | 'would_run' | 'failed' | 'not_run';

export interface StepResult {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
  /** For a skipped credential: what does not work until it is supplied. */
  disables?: string;
}

/** Side effects of the bootstrap. `aws` and `run` throw on a non-zero exit. */
export interface BootstrapSystem {
  aws(region: string, args: string[]): string;
  run(command: string, args: string[], options?: { env?: Record<string, string>; input?: string }): string;
  fileExists(path: string): boolean;
  readFile(path: string): string;
  /** Writes a file readable by the owner only (mode 600), creating its directory (mode 700). */
  writeSecretFile(path: string, content: string): void;
  configureClients(input: { projectRoot: string; apiUrl: string; operatorTokenFile: string }): string[];
  verifyControlPlane(): Promise<Record<string, string | null>>;
  log(line: string): void;
}

export function spokeStackName(region: string): string {
  return `HivemindAwsSpoke${region.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')}Stack`;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().split('\n').slice(-3).join(' ').slice(0, 300);
}

function stackExists(system: BootstrapSystem, region: string, name: string): boolean {
  try {
    const status = system.aws(region, ['cloudformation', 'describe-stacks', '--stack-name', name, '--query', 'Stacks[0].StackStatus', '--output', 'text']);
    return /_COMPLETE$/.test(status) && !status.startsWith('DELETE') && status !== 'ROLLBACK_COMPLETE';
  } catch {
    return false;
  }
}

function stackOutputs(system: BootstrapSystem, region: string, name: string): Record<string, string> {
  const raw = system.aws(region, ['cloudformation', 'describe-stacks', '--stack-name', name, '--query', 'Stacks[0].Outputs', '--output', 'json']);
  return Object.fromEntries((JSON.parse(raw) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]));
}

/** Reads a secret and returns its parsed JSON, or the raw string under `raw`. The value is never logged. */
function readSecret(system: BootstrapSystem, region: string, secretId: string): Record<string, unknown> {
  const raw = system.aws(region, ['secretsmanager', 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString', '--output', 'text']).trim();
  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return { raw };
}

export function describeModelAuth(secret: Record<string, unknown>): string[] {
  const providers: string[] = [];
  const codex = secret.codex as Record<string, unknown> | undefined;
  const claude = secret.claude as Record<string, unknown> | undefined;
  if (codex && (typeof codex.authJson === 'string' || typeof codex.apiKey === 'string')) providers.push('codex');
  if (claude && ['oauthToken', 'apiKey', 'credentialsJson'].some((key) => typeof claude[key] === 'string')) providers.push('claude');
  return providers;
}

/**
 * Runs the bootstrap. Steps run in a fixed order because later ones need the earlier ones:
 * the first Hub deploy creates the ECR repositories and the IAM roles; the DSQL roles are mapped to those
 * IAM roles; and only after the DSQL roles exist may the Hub be deployed with the restricted setting,
 * otherwise the services could not connect to the database.
 */
export async function runBootstrap(options: BootstrapOptions, system: BootstrapSystem): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const dry = options.dryRun === true;
  let blocked = false;
  const record = (result: StepResult) => {
    results.push(result);
    system.log(`[${result.status}] ${result.title} — ${result.detail}`);
    if (result.status === 'failed') blocked = true;
  };
  /** Runs one resource step. After a failure, later resource steps are not attempted. */
  const step = async (id: string, title: string, work: () => Promise<Omit<StepResult, 'id' | 'title'>> | Omit<StepResult, 'id' | 'title'>) => {
    if (blocked) {
      record({ id, title, status: 'not_run', detail: '앞 단계가 실패해 실행하지 않았습니다.' });
      return;
    }
    try {
      record({ id, title, ...(await work()) });
    } catch (error) {
      record({ id, title, status: 'failed', detail: errorText(error) });
    }
  };

  for (const region of options.spokeRegions) {
    if (!KNOWN_SPOKE_CIDRS[region]) throw new Error(`Unknown spoke region: ${region}. Known: ${Object.keys(KNOWN_SPOKE_CIDRS).join(', ')}`);
  }
  const existingSpokes = Object.keys(KNOWN_SPOKE_CIDRS).filter((region) => stackExists(system, region, spokeStackName(region)));
  // A spoke that is already deployed stays in the Hub configuration even when it was not asked for now.
  // Leaving it out would remove the Hub's permissions for it and its entry in the region registry.
  const targetSpokes = Object.keys(KNOWN_SPOKE_CIDRS).filter((r) => existingSpokes.includes(r) || options.spokeRegions.includes(r));
  const hubEnv = (restricted: boolean, spokes: string[]) => ({
    HIVEMIND_AWS_REGION: options.primaryRegion,
    HIVEMIND_SPOKE_REGIONS: spokes.length > 0 ? spokes.join(',') : 'none',
    HIVEMIND_RESTRICTED_DSQL_ROLES: restricted ? '1' : '0',
  });
  let account = '';

  await step('preflight', '사전 점검', () => {
    account = system.aws(options.primaryRegion, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
    if (!/^\d{12}$/.test(account)) throw new Error('AWS 계정을 확인하지 못했습니다. 프로필과 로그인 상태를 확인하세요.');
    system.run('docker', ['info', '--format', '{{.ServerVersion}}']);
    system.run('cdk', ['--version']);
    if (!system.fileExists(TSX_LOADER)) throw new Error('infrastructure/aws-runtime 의 의존성이 없습니다. 그 디렉터리에서 npm ci 를 실행하세요.');
    return { status: 'done', detail: `계정 ${account}, Docker와 CDK 사용 가능` };
  });

  await step('cdk-bootstrap', 'CDK 부트스트랩', () => {
    const regions = [options.primaryRegion, ...targetSpokes];
    const missing = regions.filter((region) => !stackExists(system, region, 'CDKToolkit'));
    if (missing.length === 0) return { status: 'already_done', detail: `${regions.join(', ')} 모두 준비됨` };
    if (dry) return { status: 'would_run', detail: `${missing.join(', ')}에 CDKToolkit 스택 생성` };
    for (const region of missing) system.run('cdk', ['bootstrap', `aws://${account}/${region}`]);
    return { status: 'done', detail: `${missing.join(', ')}에 CDKToolkit 스택 생성` };
  });

  await step('hub-initial', 'Hub 첫 배포', () => {
    const exists = stackExists(system, options.primaryRegion, HUB_STACK);
    const hasRoleOutputs = exists && Boolean(stackOutputs(system, options.primaryRegion, HUB_STACK).ControlPlaneTaskRoleArn);
    if (hasRoleOutputs) return { status: 'already_done', detail: `${HUB_STACK} 존재` };
    const why = exists ? '스택에 역할 ARN 출력이 없어 다시 배포' : '스택이 없어 새로 배포';
    if (dry) return { status: 'would_run', detail: `${why} (DSQL은 admin 접속 설정)` };
    // Admin mode first: the restricted database roles do not exist yet.
    system.run('bash', ['scripts/aws-deploy-hub.sh', 'deploy'], { env: hubEnv(false, existingSpokes) });
    return { status: 'done', detail: `${why} (DSQL은 admin 접속 설정)` };
  });

  let controlPlaneImagePushed = false;
  await step('images', '컨테이너 이미지', () => {
    const registry = `${account}.dkr.ecr.${options.primaryRegion}.amazonaws.com`;
    const missing = IMAGES.filter((image) => {
      if (options.rebuildImages) return true;
      try {
        system.aws(options.primaryRegion, ['ecr', 'describe-images', '--repository-name', `${options.prefix}-${image.name}`, '--image-ids', 'imageTag=latest', '--query', 'imageDetails[0].imageDigest', '--output', 'text']);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length === 0) return { status: 'already_done', detail: 'ECR에 세 이미지의 latest 태그 존재 (--rebuild-images 로 다시 빌드)' };
    const names = missing.map((i) => i.name).join(', ');
    if (dry) return { status: 'would_run', detail: `${names} 빌드 후 ECR 푸시` };
    const password = system.aws(options.primaryRegion, ['ecr', 'get-login-password']);
    system.run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { input: password });
    for (const image of missing) {
      const tag = `${registry}/${options.prefix}-${image.name}:latest`;
      system.run('docker', ['build', '--platform', 'linux/arm64', '-f', image.dockerfile, '-t', tag, '.']);
      system.run('docker', ['push', tag]);
    }
    controlPlaneImagePushed = missing.some((image) => image.name === 'control-plane');
    return { status: 'done', detail: `${names} 빌드 후 ECR 푸시` };
  });

  await step('spokes', 'Spoke 배포', () => {
    const missing = targetSpokes.filter((region) => !existingSpokes.includes(region));
    if (targetSpokes.length === 0) return { status: 'skipped', detail: 'Spoke 리전을 지정하지 않았습니다 (--spokes).', disables: '다중 리전 스팟 학습의 자동 배치. SW 전달과 협업은 Hub만으로 동작합니다.' };
    if (missing.length === 0) return { status: 'already_done', detail: `${targetSpokes.join(', ')} 존재` };
    if (dry) return { status: 'would_run', detail: `${missing.join(', ')} 배포` };
    for (const region of missing) {
      system.run('bash', ['scripts/aws-deploy-spoke.sh', region, KNOWN_SPOKE_CIDRS[region]!], { env: { HIVEMIND_AWS_REGION: options.primaryRegion, HIVEMIND_AWS_PREFIX: options.prefix } });
    }
    return { status: 'done', detail: `${missing.join(', ')} 배포` };
  });

  await step('dsql-roles', 'DSQL 테이블과 제한된 DB 역할', () => {
    if (dry) return { status: 'would_run', detail: '테이블 10개, DB 역할 2개, IAM 연결, 테이블 권한 적용 (여러 번 실행해도 결과가 같음)' };
    system.run('node', tsx('scripts/aws-dsql-apply-roles.ts'), { env: { HIVEMIND_AWS_REGION: options.primaryRegion } });
    return { status: 'done', detail: '테이블, DB 역할 2개, IAM 연결, 테이블 권한 적용' };
  });

  await step('hub-final', 'Hub 최종 배포', () => {
    const detail = `제한된 DSQL 역할, Spoke ${targetSpokes.length > 0 ? targetSpokes.join(', ') : '없음'}`;
    if (dry) return { status: 'would_run', detail: `${detail} (변경이 없으면 CloudFormation이 아무것도 바꾸지 않음)` };
    system.run('bash', ['scripts/aws-deploy-hub.sh', 'deploy'], { env: hubEnv(true, targetSpokes) });
    // The always-on Control Plane keeps running the image it started with when the task definition did not
    // change ('latest' tag). After a new image is pushed, restart it so it runs the new code.
    if (controlPlaneImagePushed) {
      const outputs = stackOutputs(system, options.primaryRegion, HUB_STACK);
      const desired = Number(system.aws(options.primaryRegion, ['ecs', 'describe-services', '--cluster', outputs.ClusterName!, '--services', outputs.ControlPlaneServiceName!, '--query', 'services[0].desiredCount', '--output', 'text']));
      if (desired > 0) {
        system.aws(options.primaryRegion, ['ecs', 'update-service', '--cluster', outputs.ClusterName!, '--service', outputs.ControlPlaneServiceName!, '--force-new-deployment', '--query', 'service.serviceName', '--output', 'text']);
        system.aws(options.primaryRegion, ['ecs', 'wait', 'services-stable', '--cluster', outputs.ClusterName!, '--services', outputs.ControlPlaneServiceName!]);
        return { status: 'done', detail: `${detail}. 새 Control Plane 이미지로 실행 중인 작업을 교체` };
      }
    }
    return { status: 'done', detail };
  });

  // Credentials. A missing one is reported, never fatal, and never blocks the steps after it.
  const credential = async (id: string, title: string, disables: string, work: () => Omit<StepResult, 'id' | 'title'>) => {
    if (blocked) {
      record({ id, title, status: 'not_run', detail: '앞 단계가 실패해 실행하지 않았습니다.' });
      return;
    }
    try {
      const result = work();
      record({ id, title, ...result, ...(result.status === 'skipped' ? { disables } : {}) });
    } catch (error) {
      // A credential problem must not hide the resource result or stop the remaining steps.
      results.push({ id, title, status: 'failed', detail: errorText(error), disables });
      system.log(`[failed] ${title} — ${errorText(error)}`);
    }
  };

  await credential('model-auth', '모델 구독 인증', '워커의 모델 호출. SW 전달과 협업 워커가 실행되지 않습니다.', () => {
    const secretId = `${options.prefix}/model-subscription-auth`;
    if (options.modelAuthFile) {
      const providers = describeModelAuth(JSON.parse(system.readFile(options.modelAuthFile)) as Record<string, unknown>);
      if (providers.length === 0) throw new Error('모델 인증 파일에 codex 또는 claude 자격이 없습니다.');
      if (dry) return { status: 'would_run', detail: `${providers.join(', ')} 자격 등록` };
      system.aws(options.primaryRegion, ['secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', `file://${options.modelAuthFile}`, '--query', 'VersionId', '--output', 'text']);
      return { status: 'done', detail: `${providers.join(', ')} 자격 등록` };
    }
    const providers = describeModelAuth(readSecret(system, options.primaryRegion, secretId));
    return providers.length > 0
      ? { status: 'already_done', detail: `등록된 제공자: ${providers.join(', ')}` }
      : { status: 'skipped', detail: '등록된 자격이 없고 --model-auth-file 도 주어지지 않았습니다.' };
  });

  await credential('github-app', 'GitHub App', 'Draft PR 게시. SW 전달 작업이 검증까지만 진행됩니다.', () => {
    if (options.githubAppId && options.githubAppKeyFile && options.githubAppRepositories?.length) {
      if (!system.fileExists(options.githubAppKeyFile)) throw new Error(`GitHub App 키 파일이 없습니다: ${options.githubAppKeyFile}`);
      if (dry) return { status: 'would_run', detail: `App ${options.githubAppId}를 ${options.githubAppRepositories.join(', ')}에 등록` };
      system.run('node', tsx('scripts/aws-set-github-app-secret.ts'), {
        env: {
          HIVEMIND_AWS_REGION: options.primaryRegion,
          HIVEMIND_GITHUB_SECRET_ID: `${options.prefix}/github-draft-pr`,
          HIVEMIND_GITHUB_APP_ID: options.githubAppId,
          HIVEMIND_GITHUB_APP_PRIVATE_KEY_FILE: options.githubAppKeyFile,
          HIVEMIND_GITHUB_APP_REPOSITORIES: options.githubAppRepositories.join(','),
        },
      });
      return { status: 'done', detail: `App ${options.githubAppId}를 ${options.githubAppRepositories.join(', ')}에 등록` };
    }
    const secret = readSecret(system, options.primaryRegion, `${options.prefix}/github-draft-pr`);
    const app = secret.githubApp as { appId?: unknown; repositories?: unknown } | undefined;
    if (app && typeof app.appId === 'string' && Array.isArray(app.repositories)) {
      return { status: 'already_done', detail: `App ${app.appId}, 저장소 ${app.repositories.length}개` };
    }
    const pats = secret.tokensByRepo && typeof secret.tokensByRepo === 'object' ? Object.keys(secret.tokensByRepo as object).length : 0;
    return pats > 0
      ? { status: 'already_done', detail: `GitHub App은 없고 저장소별 PAT ${pats}개가 등록되어 있습니다. App으로 바꾸려면 --github-app-id, --github-app-key-file, --github-app-repositories 를 주세요.` }
      : { status: 'skipped', detail: 'GitHub App 정보가 주어지지 않았고 등록된 자격도 없습니다.' };
  });

  await credential('hf-token', 'Hugging Face 토큰', 'Model Factory 산출물의 Hugging Face 공개. S3 산출물 저장은 동작합니다.', () => {
    if (options.hfTokenFile) {
      const token = system.readFile(options.hfTokenFile).trim();
      if (!token) throw new Error('Hugging Face 토큰 파일이 비어 있습니다.');
      if (dry) return { status: 'would_run', detail: '토큰 검증 후 등록' };
      system.run('node', tsx('scripts/aws-set-hf-secret.ts'), { env: { HIVEMIND_AWS_REGION: options.primaryRegion, HIVEMIND_HF_SECRET_ID: `${options.prefix}/hf-release-token` }, input: token });
      return { status: 'done', detail: '토큰 검증 후 등록' };
    }
    const secret = readSecret(system, options.primaryRegion, `${options.prefix}/hf-release-token`);
    const registered = typeof secret.token === 'string' || (typeof secret.raw === 'string' && secret.raw.startsWith('hf_'));
    return registered
      ? { status: 'already_done', detail: '토큰 등록됨' }
      : { status: 'skipped', detail: '--hf-token-file 이 주어지지 않았고 등록된 토큰도 없습니다.' };
  });

  // Local convenience only: a problem here must not stop the cloud-side verification below.
  await credential('client-config', '로컬 MCP 클라이언트 설정', '이 컴퓨터의 Claude Code와 Codex에서 HIVEMIND MCP 도구 사용. 클라우드 쪽 구성에는 영향이 없습니다.', () => {
    if (options.skipClientConfig) return { status: 'skipped', detail: '--skip-client-config' };
    const apiUrl = `http://127.0.0.1:${options.localApiPort}`;
    if (dry) return { status: 'would_run', detail: `운영자 토큰 파일 ${options.operatorTokenFile}과 Control Plane 기동 설정 파일 ${options.controlPlaneConfigFile} 작성, Claude Code와 Codex 설정에 ${apiUrl} 등록` };
    const token = String(readSecret(system, options.primaryRegion, `${options.prefix}/operator-token`).raw ?? '').trim();
    if (!token) throw new Error('운영자 토큰을 읽지 못했습니다.');
    system.writeSecretFile(options.operatorTokenFile, JSON.stringify({ OPERATOR_TOKEN: token }));
    // The agent token exists on stacks deployed with the agent token secret; an older stack has none.
    let agentWritten = false;
    if (options.agentTokenFile) {
      let agentToken = '';
      try {
        agentToken = String(readSecret(system, options.primaryRegion, `${options.prefix}/agent-token`).raw ?? '').trim();
      } catch {
        agentToken = '';
      }
      if (agentToken) {
        system.writeSecretFile(options.agentTokenFile, JSON.stringify({ AGENT_TOKEN: agentToken }));
        agentWritten = true;
      }
    }
    // Lets the MCP server open (and reopen) the tunnel to the always-on Control Plane. No secret in it.
    const outputs = stackOutputs(system, options.primaryRegion, HUB_STACK);
    if (!outputs.ClusterName || !outputs.ControlPlaneServiceName) throw new Error('Hub 스택 출력에 ClusterName 또는 ControlPlaneServiceName 이 없습니다.');
    system.writeSecretFile(
      options.controlPlaneConfigFile,
      `${JSON.stringify({ ...(options.profile ? { profile: options.profile } : {}), region: options.primaryRegion, cluster: outputs.ClusterName, service: outputs.ControlPlaneServiceName, mode: 'always-on' }, null, 2)}\n`,
    );
    const written = system.configureClients({ projectRoot: options.projectRoot, apiUrl, operatorTokenFile: options.operatorTokenFile });
    return { status: 'done', detail: `운영자 토큰 파일(권한 600)${agentWritten ? ', 에이전트 토큰 파일(권한 600)' : ''}, Control Plane 기동 설정 파일과 ${written.join(', ')} 작성. 클라이언트를 다시 시작해야 반영됩니다.` };
  });

  await step('verify', '동작 확인', async () => {
    if (options.skipVerify) return { status: 'skipped', detail: '--skip-verify' };
    if (dry) return { status: 'would_run', detail: 'Control Plane에 연결해 세 저장소의 응답을 확인하고, 확인 전 desiredCount로 되돌림' };
    const backends = await system.verifyControlPlane();
    const summary = Object.entries(backends).map(([store, backend]) => `${store}=${backend ?? '응답 없음'}`).join(', ');
    if (Object.values(backends).some((backend) => backend === null)) throw new Error(`일부 저장소가 응답하지 않았습니다: ${summary}`);
    return { status: 'done', detail: `${summary}. Control Plane은 확인 전 desiredCount로 되돌림` };
  });

  return results;
}

/** Exit code 0 unless a step failed. A skipped credential is a reported gap, not a failure. */
export function bootstrapExitCode(results: StepResult[]): number {
  return results.some((r) => r.status === 'failed' || r.status === 'not_run') ? 1 : 0;
}

export function formatBootstrapReport(results: StepResult[]): string {
  const label: Record<StepStatus, string> = { done: '완료', already_done: '이미 됨', skipped: '건너뜀', would_run: '실행 예정', failed: '실패', not_run: '미실행' };
  const lines = ['| 단계 | 결과 | 내용 |', '|---|---|---|', ...results.map((r) => `| ${r.title} | ${label[r.status]} | ${r.detail.replaceAll('|', '/')} |`)];
  const gaps = results.filter((r) => r.disables && (r.status === 'skipped' || r.status === 'failed'));
  if (gaps.length > 0) {
    lines.push('', '아직 동작하지 않는 기능:');
    for (const gap of gaps) lines.push(`- ${gap.title}: ${gap.disables}`);
  }
  return lines.join('\n');
}
