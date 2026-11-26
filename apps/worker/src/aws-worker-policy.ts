import type {
  DeliveryPreflightReport,
  DeliveryProvider,
  WorkerExecutionPolicy,
} from '../../../packages/contracts/src/delivery.js';
import { runExecutable } from '../../../packages/adapters/src/process.js';

export interface WorkerPromptSpec {
  taskId: string;
  runId: string;
  iteration: number;
  maxIterations: number;
  provider: DeliveryProvider;
  title: string;
  instructions: string;
  baseCommit: string;
  acceptancePaths: string[];
  testCommand: string[];
  priorVerificationSummary: string | null;
  executionPolicy?: WorkerExecutionPolicy;
}

export function buildWorkerPrompt(spec: WorkerPromptSpec, restoredCheckpointPatch = false): string {
  const policy = spec.executionPolicy;
  const allowedWebHosts = policy?.allowedWebHosts ?? [];
  const allowSubagents = policy?.allowSubagents ?? false;
  const isDocMode = policy?.verificationKind === 'document_format';

  const lines = [
    `# HIVEMIND ${isDocMode ? 'Research & Document' : 'SW Delivery'} Task (${spec.taskId}, iteration ${spec.iteration}/${spec.maxIterations})`,
    '',
    `Title: ${spec.title}`,
    '',
    '## Instructions',
    spec.instructions,
    '',
    '## Immutable Acceptance Contract (STRICT)',
    '- You MUST NOT modify, delete, or overwrite any of the following pinned acceptance files (the independent verifier will reject your patch immediately):',
    ...spec.acceptancePaths.map((p) => `  - ${p}`),
    `- Fixed independent verification command: ${JSON.stringify(spec.testCommand)}`,
    '- Run relevant checks in this repository before finishing so your patch passes the verification command cleanly.',
    '- Do NOT create git commits or push anything; leave your clean edits in the working tree.',
  ];

  if (allowedWebHosts.length > 0 || allowSubagents || isDocMode) {
    lines.push('', '## Approved Execution Policy');
    if (allowedWebHosts.length > 0) {
      lines.push(
        `- Approved external web hosts (ONLY access these hosts for public read-only research): ${allowedWebHosts.join(', ')}`,
      );
    } else {
      lines.push('- External web research hosts: none approved (stay offline / local repository only).');
    }
    lines.push(
      allowSubagents
        ? '- Subagents: ALLOWED (you may delegate parallel research/synthesis to subagents using the Agent tool).'
        : '- Subagents: DISABLED (complete the task directly without spawning subagents).',
    );
    if (isDocMode) {
      lines.push(
        '- Deliverable mode: DOCUMENT_FORMAT. Cite exact primary source URLs, dates, and version numbers for every factual claim so the operator can audit accuracy.',
      );
    }
  }

  if (restoredCheckpointPatch) {
    lines.push(
      '',
      '## Resumed Workspace State',
      '- Your previous partial edits from the earlier run/iteration have been restored cleanly onto the working tree. Inspect `git status` and continue from where the previous run left off without duplicating completed work.',
    );
  }

  lines.push(
    '',
    '## Final Response Format (Required for Operator Review)',
    'End your final message with a concise structured summary (in Korean if instructions are Korean, otherwise English) containing:',
    '1. **변경 파일별 요약**: each modified/added file and why it was changed',
    '2. **핵심 동작 변화**: externally observable behavior, auth/error handling, and edge cases covered',
    '3. **자체 확인 결과**: exact build/test commands run and their results',
  );

  if (spec.priorVerificationSummary) {
    lines.push(
      '',
      '## Previous Independent Verifier Failure (Fix this root cause)',
      spec.priorVerificationSummary,
    );
  }

  return lines.join('\n') + '\n';
}

export function buildWorkerCliCommand(options: {
  provider: DeliveryProvider;
  cliBin: string;
  workspacePath: string;
  lastMessageFile: string;
  model?: string;
  sandboxMode?: string;
  executionPolicy?: WorkerExecutionPolicy;
}): { cmd: string[]; extraEnv: Record<string, string> } {
  const allowedWebHosts = options.executionPolicy?.allowedWebHosts ?? [];
  const allowSubagents = options.executionPolicy?.allowSubagents ?? false;
  const extraEnv: Record<string, string> = {
    HIVEMIND_ALLOWED_WEB_HOSTS: allowedWebHosts.join(','),
    HIVEMIND_ALLOW_SUBAGENTS: allowSubagents ? 'true' : 'false',
  };

  if (options.provider === 'codex') {
    const sandboxMode = options.sandboxMode ?? 'danger-full-access';
    return {
      cmd: [
        options.cliBin,
        'exec',
        '--ignore-user-config',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        sandboxMode,
        '--cd',
        options.workspacePath,
        '--output-last-message',
        options.lastMessageFile,
        ...(options.model ? ['--model', options.model] : []),
        '-',
      ],
      extraEnv,
    };
  }

  const allowedTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
  if (allowSubagents) {
    allowedTools.push('Agent');
  }
  for (const host of allowedWebHosts) {
    allowedTools.push(`WebFetch(domain:${host})`);
  }

  return {
    cmd: [
      options.cliBin,
      '--print',
      '--permission-mode',
      'acceptEdits',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--allowedTools',
      allowedTools.join(','),
      ...(options.model ? ['--model', options.model] : []),
    ],
    extraEnv,
  };
}

export async function runWorkerPreflight(options: {
  runId: string;
  provider: DeliveryProvider;
  cliBin: string;
  workspacePath: string;
  authReady: boolean;
  executionPolicy?: WorkerExecutionPolicy;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  execImpl?: (executable: string, args: string[]) => Promise<{ status: string; stdout: string; stderr: string }>;
}): Promise<Omit<DeliveryPreflightReport, 'checkedAt'>> {
  const exec =
    options.execImpl ??
    ((executable: string, args: string[]) =>
      runExecutable(executable, args, {
        cwd: options.workspacePath,
        timeoutMs: 10_000,
        env: options.env,
        signal: options.signal ?? AbortSignal.timeout(10_000),
        maxOutputBytes: 16_000,
      }));

  const allowedWebHosts = options.executionPolicy?.allowedWebHosts ?? [];
  const allowSubagents = options.executionPolicy?.allowSubagents ?? false;

  const [cliCheck, gitCheck] = await Promise.all([
    exec(options.cliBin, ['--version']).catch((error: unknown) => ({
      status: 'error' as const,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    })),
    exec('git', ['--version']).catch((error: unknown) => ({
      status: 'error' as const,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    })),
  ]);

  const cliOk = cliCheck.status === 'passed';
  const gitOk = gitCheck.status === 'passed';
  const cliVersion = cliOk
    ? (cliCheck.stdout.trim() || cliCheck.stderr.trim()).split(/\r?\n/)[0]?.slice(0, 120) || 'unknown'
    : null;

  const failures: string[] = [];
  if (!cliOk) failures.push(`${options.provider} CLI unavailable (${cliCheck.stderr.trim() || cliCheck.status})`);
  if (!options.authReady) failures.push(`${options.provider} provider auth materialization failed`);
  if (!gitOk) failures.push(`git CLI unavailable (${gitCheck.stderr.trim() || gitCheck.status})`);

  return {
    runId: options.runId,
    ok: failures.length === 0,
    cliVersion,
    authReady: options.authReady,
    gitReady: gitOk,
    allowedWebHosts,
    allowSubagents,
    reason: failures.length > 0 ? failures.join('; ').slice(0, 1000) : null,
  };
}
