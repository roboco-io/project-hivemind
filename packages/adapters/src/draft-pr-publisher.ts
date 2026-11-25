import type {
  DeliveryChangeSummary,
  DeliveryTask,
  DraftPrPublication,
  VerificationAttestation,
} from '../../contracts/src/delivery.js';
import { computePatchTreeHash } from './git-bundle.js';

export interface GitHubDraftPrRequest {
  repository: string;
  baseBranch: string;
  branchName: string;
  baseCommit: string;
  patch: string;
  expectedTreeHash: string;
  title: string;
  body: string;
  draft: true;
}

export interface GitHubDraftPrResponse {
  commitSha: string;
  prTreeHash: string;
  prNumber: number;
  prUrl: string;
}

export interface GitHubDraftPrPort {
  publishDraftPr(request: GitHubDraftPrRequest, signal: AbortSignal): Promise<GitHubDraftPrResponse>;
}

export interface PublishDraftPrOptions {
  task: DeliveryTask;
  attestation: VerificationAttestation;
  bundlePath: string;
  expectedBundleSha256: string;
  patch: string;
  workRoot: string;
  github: GitHubDraftPrPort;
  workerSummary?: string;
  redactSecrets?: string[];
  now?: () => number;
}

function redactText(raw: string, secrets: string[]): string {
  let out = raw;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.replaceAll(secret, '[REDACTED]');
  }
  return out
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|operator[_-]?token|worker[_-]?token|github[_-]?token|password|secret)\s*[=:]\s*)[^\s,"'}]+/gi, '$1[REDACTED]');
}

export function buildDraftPrBody(
  task: DeliveryTask,
  attestation: VerificationAttestation,
  prTreeHash: string,
  redactSecrets: string[] = [],
  changeSummary?: DeliveryChangeSummary,
): string {
  const pinnedFiles = task.acceptance.files
    .map((file) => `- \`${file.path}\` (\`${file.sha256.slice(0, 12)}...\`)`)
    .join('\n');

  const summarySection: string[] = [];
  if (changeSummary) {
    const displayedFiles = changeSummary.files.slice(0, 50);
    const fileRows =
      displayedFiles.length > 0
        ? [
            `| 파일 경로 | 추가 | 삭제 |`,
            `|---|---:|---:|`,
            ...displayedFiles.map((file) =>
              file.binary
                ? `| \`${file.path}\` | binary | binary |`
                : `| \`${file.path}\` | +${file.insertions ?? 0} | -${file.deletions ?? 0} |`,
            ),
            ...(changeSummary.files.length > displayedFiles.length
              ? [`_외 ${changeSummary.files.length - displayedFiles.length}개 파일 생략_`]
              : []),
          ].join('\n')
        : '_변경된 파일 없음_';
    const cleanWorkerSummary = changeSummary.workerSummary.trim()
      ? changeSummary.workerSummary.trim()
      : '_워커 상세 요약 미제공_';
    summarySection.push(
      '',
      `### 3. 변경사항 상세 요약 (diff 미열람 판단용)`,
      `- **변경 규모 (신뢰된 Git 메타데이터 기준):** 총 \`${changeSummary.totalFiles}\`개 파일 (\`+${changeSummary.totalInsertions}\` / \`-${changeSummary.totalDeletions}\`)`,
      `- **정책 준수 확인:** 격리 브랜치(\`${task.delivery.branchPrefix}*\`) 전용 · 자동 병합 금지(\`autoMerge: false\`) · 수용 테스트 경로 무변조 · 검증–게시 트리 해시 일치`,
      '',
      `#### 변경 파일 목록`,
      fileRows,
      '',
      `#### 워커 구현 요약 (비신뢰 참고 · 독립 검증 통과본 기준)`,
      cleanWorkerSummary,
    );
  }

  const raw = [
    `## HIVEMIND 자동 생성 Draft PR (정책·검증 근거 기반 판단용)`,
    '',
    `이 PR은 독립 검증을 통과한 결과를 격리 브랜치로 자동 게시한 **Draft PR**입니다. \`${task.delivery.baseBranch}\`에 직접 병합하지 않았습니다.`,
    '',
    `### 1. 검증–게시 코드 동일성 증명`,
    `| 항목 | 값 |`,
    `|---|---|`,
    `| Task ID | \`${task.id}\` |`,
    `| Provider / Iteration | \`${task.provider}\` / \`${attestation.iteration}/${task.maxIterations}\` |`,
    `| 고정 기준 커밋 (\`baseCommit\`) | \`${task.acceptance.baseCommit}\` |`,
    `| 승인 수용 테스트 Digest | \`${task.acceptance.digest}\` |`,
    `| 검증 통과 트리 해시 (\`verifiedTreeHash\`) | \`${attestation.verifiedTreeHash}\` |`,
    `| PR 게시 트리 해시 (\`prTreeHash\`) | \`${prTreeHash}\` |`,
    `| 패치 SHA-256 (\`patchSha256\`) | \`${attestation.patchSha256}\` |`,
    `| 해시 일치 여부 | **${attestation.verifiedTreeHash === prTreeHash ? '일치 (VERIFIED)' : '불일치'}** |`,
    '',
    `### 2. 불변 수용 테스트 및 독립 검증 결과`,
    `- 수용 테스트 경로 변조 없음: **${attestation.acceptancePathsUnmodified ? '확인' : '위반'}**`,
    `- 고정 검증 명령: \`${JSON.stringify(task.acceptance.testCommand)}\``,
    `- 종료 코드 / 소요 시간: \`${attestation.exitCode ?? 'null'}\` / \`${attestation.durationMs}ms\``,
    `- 요약: ${attestation.summary}`,
    '',
    `#### 고정된 수용 테스트 파일`,
    pinnedFiles,
    ...summarySection,
  ].join('\n');
  return redactText(raw, redactSecrets);
}

export async function publishVerifiedDraftPr(
  options: PublishDraftPrOptions,
  signal: AbortSignal,
): Promise<DraftPrPublication> {
  const { task, attestation } = options;
  if (!attestation.checksPassed || !attestation.acceptancePathsUnmodified) {
    throw new Error('Refusing Draft PR publication: independent acceptance verification did not pass');
  }
  if (attestation.acceptanceTestDigest !== task.acceptance.digest) {
    throw new Error('Refusing Draft PR publication: acceptanceTestDigest mismatch');
  }
  // Independent trusted tree-hash and file-stat calculation without executing any model code or build script.
  const { prTreeHash, patchSha256, changedFiles, totalInsertions, totalDeletions } = await computePatchTreeHash(
    options.bundlePath,
    options.expectedBundleSha256,
    task.acceptance.baseCommit,
    options.patch,
    options.workRoot,
    signal,
  );
  if (patchSha256 !== attestation.patchSha256) {
    throw new Error('Refusing Draft PR publication: patchSha256 does not match verified attestation');
  }
  if (prTreeHash !== attestation.verifiedTreeHash) {
    throw new Error('Refusing Draft PR publication: computed prTreeHash does not match verifiedTreeHash');
  }

  const branchName = `${task.delivery.branchPrefix}${task.id}-r${attestation.iteration}`;
  if (branchName === task.delivery.baseBranch || branchName === 'main' || branchName === 'master') {
    throw new Error('Refusing Draft PR publication to protected or base branch');
  }
  const secrets = options.redactSecrets ?? [];
  const redactedWorkerSummary = redactText(
    (options.workerSummary ?? task.latestWorkerSummary ?? '').trim(),
    secrets,
  ).slice(0, 4000);
  const changeSummary: DeliveryChangeSummary = {
    files: changedFiles,
    totalFiles: changedFiles.length,
    totalInsertions,
    totalDeletions,
    workerSummary: redactedWorkerSummary,
  };

  const title = redactText(`[HIVEMIND] ${task.title}`, secrets).slice(0, 180);
  const body = buildDraftPrBody(task, attestation, prTreeHash, secrets, changeSummary);

  const response = await options.github.publishDraftPr(
    {
      repository: task.delivery.repository,
      baseBranch: task.delivery.baseBranch,
      branchName,
      baseCommit: task.acceptance.baseCommit,
      patch: options.patch,
      expectedTreeHash: attestation.verifiedTreeHash,
      title,
      body,
      draft: true,
    },
    signal,
  );

  if (response.prTreeHash.toLowerCase() !== attestation.verifiedTreeHash.toLowerCase()) {
    throw new Error('Refusing Draft PR acceptance: remote PR tree hash does not match verifiedTreeHash');
  }

  return {
    branchName,
    commitSha: response.commitSha.toLowerCase(),
    prTreeHash: response.prTreeHash.toLowerCase(),
    prNumber: response.prNumber,
    prUrl: response.prUrl,
    verifiedTreeHash: attestation.verifiedTreeHash,
    acceptanceTestDigest: attestation.acceptanceTestDigest,
    patchSha256,
    changeSummary,
    publishedAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
}
