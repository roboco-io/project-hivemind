import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_TEMPLATES, type ProjectTemplateId } from '../packages/contracts/src/projects.js';
import {
  formatProjectBootstrapReport,
  runProjectBootstrap,
  type ProjectBootstrapManifest,
  type ProjectBootstrapSystem,
} from './lib/project-bootstrap.js';

const HELP = `HIVEMIND 프로젝트 부트스트랩: HIVEMIND 호스트에 새 프로젝트를 등록·격리하고 대상 저장소 연동을 구성합니다.
이미 등록된 프로젝트에 다시 실행하면 정책을 안전하게 갱신합니다(멱등).

사용법: npm run project:bootstrap -- [옵션]

  --manifest <경로>              hivemind.project.json 매니페스트 파일 (개별 옵션으로 덮어쓰기 가능)
  --id <프로젝트 ID>             소문자·숫자·하이픈 (예: silicon-model-factory, research-lab)
  --name <표시 이름>             관제실에 표시할 프로젝트 이름
  --description <설명>           프로젝트 한 줄 설명
  --template <이름>              템플릿 프리셋: ${PROJECT_TEMPLATES.join(', ')} (기본: generic)
  --repo <owner/repo,...>        허용 GitHub 저장소 (쉼표 구분)
  --budget-usd <달러>            프로젝트별 Spot 컴퓨팅 예산 상한 (USD)
  --max-job-usd <달러>           단일 작업당 최대 비용 상한 (USD)
  --regions <r1,r2,...>          허용 AWS 리전 목록 (쉼표 구분)
  --hf-prefix <org/,...>         자동 공개 허용 Hugging Face 접두사 (쉼표 구분)
  --auto-merge                   등록 저장소의 보호 경로 외 자동 병합 허용
  --issue-token                  프로젝트 전용 에이전트 토큰 발급 (~/.hivemind/projects/<id>/agent-token.json, 0600)
  --rotate-token                 기존 토큰 파일이 있어도 새 토큰을 발급해 덮어씀
  --with-trigger                 주기 자율 트리거 등록(비활성 상태) + 대상 저장소에 ops/autonomy/ 뼈대 생성
  --target-dir <로컬 경로>       대상 저장소에 hivemind.project.json, .mcp.json, .codex/config.toml 스캐폴딩
  --api-url <URL>                Control Plane 주소 (기본: http://127.0.0.1:4310)
  --operator-token-file <경로>   운영자 토큰 JSON 경로 (기본: ~/.hivemind/aws-operator-token.json)
  --force                        스캐폴딩 시 기존 파일 덮어쓰기 허용
  --dry-run                      아무것도 바꾸지 않고 실행 계획만 출력
  --help                         이 도움말
`;

function parseArgs(argv: string[]): Record<string, string | true> {
  const flags = new Set(['auto-merge', 'issue-token', 'rotate-token', 'with-trigger', 'force', 'dry-run', 'help']);
  const valued = new Set([
    'manifest',
    'id',
    'name',
    'description',
    'template',
    'repo',
    'budget-usd',
    'max-job-usd',
    'regions',
    'hf-prefix',
    'target-dir',
    'api-url',
    'operator-token-file',
  ]);
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`알 수 없는 인자: ${arg}`);
    const name = arg.slice(2);
    if (flags.has(name)) {
      out[name] = true;
    } else if (valued.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 에 값이 필요합니다.`);
      out[name] = value;
      i += 1;
    } else {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }
  return out;
}

function loadOperatorToken(filePath: string): string {
  const envToken = process.env.HIVEMIND_OPERATOR_TOKEN?.trim();
  if (envToken) return envToken;
  if (!existsSync(filePath)) {
    throw new Error(`운영자 토큰 파일이 없습니다: ${filePath} (HIVEMIND_OPERATOR_TOKEN 또는 --operator-token-file 확인)`);
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { OPERATOR_TOKEN?: unknown };
  if (typeof parsed?.OPERATOR_TOKEN !== 'string' || !parsed.OPERATOR_TOKEN.trim()) {
    throw new Error(`OPERATOR_TOKEN 필드가 비어 있습니다: ${filePath}`);
  }
  return parsed.OPERATOR_TOKEN.trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const hivemindRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const csv = (v: string | true | undefined) =>
    typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  let fileManifest: Partial<ProjectBootstrapManifest> = {};
  if (typeof args.manifest === 'string') {
    fileManifest = JSON.parse(readFileSync(resolve(args.manifest), 'utf8')) as Partial<ProjectBootstrapManifest>;
  }

  const id = typeof args.id === 'string' ? args.id : fileManifest.id;
  const name = typeof args.name === 'string' ? args.name : fileManifest.name;
  if (!id || !name) {
    throw new Error('--id 와 --name (또는 --manifest 파일의 id/name)이 필요합니다. --help 를 참고하세요.');
  }
  const template = ((typeof args.template === 'string' ? args.template : fileManifest.template) ?? 'generic') as ProjectTemplateId;
  if (!(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
    throw new Error(`알 수 없는 템플릿: ${template}. 가능한 값: ${PROJECT_TEMPLATES.join(', ')}`);
  }

  const manifest: ProjectBootstrapManifest = {
    ...fileManifest,
    id,
    name,
    template,
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    repositories: csv(args.repo) ?? fileManifest.repositories ?? [],
    ...(args['auto-merge'] === true ? { autoMerge: true } : {}),
    ...(typeof args['budget-usd'] === 'string' ? { budgetUsd: Number(args['budget-usd']) } : {}),
    ...(typeof args['max-job-usd'] === 'string' ? { maxJobUsd: Number(args['max-job-usd']) } : {}),
    ...(csv(args.regions) ? { regions: csv(args.regions) } : {}),
    ...(csv(args['hf-prefix']) ? { hfAutoPublishPrefixes: csv(args['hf-prefix']) } : {}),
  };

  const apiUrl = typeof args['api-url'] === 'string' ? args['api-url'] : (process.env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4310');
  const operatorTokenFile =
    typeof args['operator-token-file'] === 'string'
      ? resolve(args['operator-token-file'])
      : (process.env.OPERATOR_TOKEN_FILE ?? join(homedir(), '.hivemind', 'aws-operator-token.json'));
  const dryRun = args['dry-run'] === true;
  const operatorToken = dryRun ? 'dry-run-placeholder' : loadOperatorToken(operatorTokenFile);
  const tokenOutputFile = join(homedir(), '.hivemind', 'projects', id, 'agent-token.json');

  const system: ProjectBootstrapSystem = {
    fileExists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    },
    writeSecretFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, content, { mode: 0o600 });
      chmodSync(p, 0o600);
    },
  };

  const { results, manualChecklist } = await runProjectBootstrap(
    {
      manifest,
      apiUrl,
      operatorToken,
      tokenOutputFile,
      issueToken: args['issue-token'] === true,
      rotateToken: args['rotate-token'] === true,
      withTrigger: args['with-trigger'] === true,
      ...(typeof args['target-dir'] === 'string' ? { targetDir: resolve(args['target-dir']) } : {}),
      hivemindRoot,
      force: args.force === true,
      dryRun,
    },
    system,
  );
  process.stdout.write(`${formatProjectBootstrapReport(results, manualChecklist)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
