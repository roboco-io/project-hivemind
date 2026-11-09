import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { AgentAdapter, ProcessEvidence, RunResult, ExecutionEvidence } from '../../contracts/src/index.js';
import { runProcess, processEnvironment } from './process.js';
import { createWorkspace, collectWorkspaceDiff } from './workspace.js';

export interface CodexOptions {
  repositoryPath: string;
  worktreeRoot: string;
  repositoryId?: string;
  codexCommand?: string;
  model?: string;
  testCommand: string[];
  setupCommand?: string[];
  timeoutMs?: number;
  testTimeoutMs?: number;
}

type JsonRecord = Record<string,unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validCommand = (command: string[]) => Array.isArray(command) && command.length > 0 && command.every(part => typeof part === 'string' && !part.includes('\0')) && Boolean(command[0]);
const notRun = (command: string[]): ProcessEvidence => ({command:[...command],status:'not_run',exitCode:null,durationMs:0,stdout:'',stderr:'',truncated:false});

export function createCodexAdapter(options: CodexOptions): AgentAdapter {
  if (!validCommand(options.testCommand) || (options.setupCommand && !validCommand(options.setupCommand))) throw new Error('Configured test/setup command must be a nonempty argument array');
  return {
    provider: 'codex',
    async execute(task, signal): Promise<RunResult> {
      if (task.provider !== 'codex' || task.runtime !== 'local' || task.repositoryId !== (options.repositoryId ?? 'local') || task.testProfile !== 'default' || !task.runId || !task.baseCommit) throw new Error('Task does not match the configured Codex repository and test profile');
      if (!task.testCommand || JSON.stringify(task.testCommand) !== JSON.stringify(options.testCommand)) throw new Error('Approved test command does not match the worker test profile');
      const workspace = await createWorkspace({repositoryPath:options.repositoryPath,worktreeRoot:options.worktreeRoot,runId:task.runId,baseCommit:task.baseCommit},signal);
      let summary = '', threadId: string | null = null, model = options.model ?? null;
      let usage: ExecutionEvidence['codex']['usage'] = null;
      let completed = false, failed = false, invalid = false, pending = '', dropping = false;
      const decoder = new StringDecoder('utf8');
      const parseLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = record(JSON.parse(line));
          if (!event) { invalid = true; return; }
          if (typeof event.model === 'string') model = event.model.slice(0,160);
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id.slice(0,200);
          if (event.type === 'turn.failed' || event.type === 'error') failed = true;
          if (event.type === 'item.completed') {
            const item = record(event.item);
            if (item?.type === 'agent_message' && typeof item.text === 'string') summary = item.text.trim().slice(0,12000);
          }
          if (event.type === 'turn.completed') {
            completed = true;
            const counts = record(event.usage);
            const cached = counts?.cached_input_tokens ?? 0;
            if (counts && counter(counts.input_tokens) && counter(cached) && counter(counts.output_tokens)) usage = {inputTokens:counts.input_tokens,cachedInputTokens:cached,outputTokens:counts.output_tokens};
          }
        } catch { invalid = true; }
      };
      const consume = (chunk: string) => {
        if (dropping) {
          const end = chunk.indexOf('\n');
          if (end === -1) return;
          chunk = chunk.slice(end+1); dropping = false;
        }
        pending += chunk;
        let end: number;
        while ((end=pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0,end); pending = pending.slice(end+1);
          if (line.length > 1_000_000) invalid = true; else parseLine(line);
        }
        if (pending.length > 1_000_000) { pending = ''; dropping = true; invalid = true; }
      };
      const command = [options.codexCommand ?? 'codex','--ask-for-approval','never','exec','--ignore-user-config','--sandbox','workspace-write','--json','--ephemeral','--cd',workspace.path];
      if (options.model) command.push('--model',options.model);
      command.push('-');
      const prompt = `Perform the requested change only in this Git worktree. Do not commit, push, merge, create branches, or alter Git metadata. The worker will run the configured tests after you finish.\n\nTask: ${task.title}\n\n${task.instructions}\n`;
      const codex = await runProcess(command,{cwd:workspace.path,signal,timeoutMs:options.timeoutMs ?? 600000,input:prompt,env:processEnvironment(process.env.HOME ?? homedir(),true),maxOutputBytes:1_000_000,onStdout:chunk => consume(decoder.write(chunk))});
      consume(decoder.end());
      if (pending && !dropping) parseLine(pending);
      let codexStatus = codex.status;
      if (codexStatus === 'passed' && (!completed || failed || invalid)) codexStatus = 'error';
      let setup: ProcessEvidence | undefined;
      let tests = notRun(options.testCommand);
      if (codexStatus === 'passed') {
        const environment = processEnvironment(`${workspace.artifactPath}/home`);
        if (options.setupCommand) setup = await runProcess(options.setupCommand,{cwd:workspace.path,signal,timeoutMs:options.testTimeoutMs ?? 120000,env:environment});
        if (!setup || setup.status === 'passed') tests = await runProcess(options.testCommand,{cwd:workspace.path,signal,timeoutMs:options.testTimeoutMs ?? 120000,env:environment});
      }
      signal.throwIfAborted();
      const change = await collectWorkspaceDiff(workspace,signal);
      const succeeded = codexStatus === 'passed' && (!setup || setup.status === 'passed') && tests.status === 'passed' && change.headCommit === workspace.baseCommit;
      if (!summary) summary = succeeded ? 'Codex completed and configured tests passed.' : 'Codex execution did not complete successfully.';
      if (!succeeded) {
        const reason = change.headCommit !== workspace.baseCommit ? 'Unexpected Git HEAD change.' : codexStatus !== 'passed' ? `Codex ${codexStatus}.` : setup && setup.status !== 'passed' ? `Setup ${setup.status}.` : `Tests ${tests.status}.`;
        summary = `${summary.slice(0,11800)}\nExecution failed: ${reason}`;
      }
      return {
        summary,diff:change.diff,actualCostMicros:null,
        execution:{repositoryId:options.repositoryId ?? 'local',baseCommit:workspace.baseCommit,headCommit:change.headCommit,worktreePath:workspace.path,diffTruncated:change.diffTruncated,status:succeeded ? 'succeeded' : 'failed',...(setup ? {setup} : {}),tests,codex:{status:codexStatus,exitCode:codex.exitCode,threadId,model,usage,stderr:codex.stderr.slice(0,16000)}},
      };
    },
  };
}
