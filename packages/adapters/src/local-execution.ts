import type { AgentAdapter, AgentRunEvidence, ProcessEvidence, RunResult, Task } from '../../contracts/src/index.js';
import { runProcess, processEnvironment } from './process.js';
import { createWorkspace, collectWorkspaceDiff, type Workspace } from './workspace.js';

export interface LocalExecutionOptions {
  repositoryPath: string;
  worktreeRoot: string;
  repositoryId?: string;
  model?: string;
  testCommand: string[];
  setupCommand?: string[];
  timeoutMs?: number;
  testTimeoutMs?: number;
}
export interface AgentInvocation { summary: string; evidence: AgentRunEvidence }
export type LocalProvider = 'codex' | 'claude';
export type InvokeAgent = (workspace: Workspace, task: Task, signal: AbortSignal) => Promise<AgentInvocation>;
const validCommand = (command: string[]) => Array.isArray(command) && command.length > 0 && command.length <= 32 && command.every(part => typeof part === 'string' && !!part.trim() && part.length <= 1000 && !part.includes('\0'));
const notRun = (command: string[]): ProcessEvidence => ({command:[...command],status:'not_run',exitCode:null,durationMs:0,stdout:'',stderr:'',truncated:false});
export const taskPrompt = (task: Task): string => `Perform the requested change only in this Git worktree. Do not commit, push, merge, create branches, or alter Git metadata. The worker will run the configured tests after you finish.\n\nTask: ${task.title}\n\n${task.instructions}\n`;

export function createLocalAdapter(provider: LocalProvider, options: LocalExecutionOptions, invoke: InvokeAgent): AgentAdapter {
  if (!validCommand(options.testCommand) || (options.setupCommand && !validCommand(options.setupCommand))) throw new Error('Configured test/setup command must be a nonempty argument array');
  return {provider,execute:(task,signal)=>executeLocalTask(provider,options,task,signal,invoke)};
}

export async function executeLocalTask(provider: LocalProvider, options: LocalExecutionOptions, task: Task, signal: AbortSignal, invoke: InvokeAgent): Promise<RunResult> {
  const label = provider === 'codex' ? 'Codex' : 'Claude Code';
  if (task.provider !== provider || task.runtime !== 'local' || task.repositoryId !== (options.repositoryId ?? 'local') || task.testProfile !== 'default' || !task.runId || !task.baseCommit) throw new Error(`Task does not match the configured ${label} repository and test profile`);
  if (!task.testCommand || JSON.stringify(task.testCommand) !== JSON.stringify(options.testCommand)) throw new Error('Approved test command does not match the worker test profile');
  const workspace = await createWorkspace({repositoryPath:options.repositoryPath,worktreeRoot:options.worktreeRoot,runId:task.runId,baseCommit:task.baseCommit},signal);
  const agent = await invoke(workspace,task,signal);
  let setup: ProcessEvidence | undefined;
  let tests = notRun(options.testCommand);
  if (agent.evidence.status === 'passed') {
    const environment = processEnvironment(`${workspace.artifactPath}/home`);
    if (options.setupCommand) setup = await runProcess(options.setupCommand,{cwd:workspace.path,signal,timeoutMs:options.testTimeoutMs ?? 120000,env:environment});
    if (!setup || setup.status === 'passed') tests = await runProcess(options.testCommand,{cwd:workspace.path,signal,timeoutMs:options.testTimeoutMs ?? 120000,env:environment});
  }
  signal.throwIfAborted();
  const change = await collectWorkspaceDiff(workspace,signal);
  const succeeded = agent.evidence.status === 'passed' && (!setup || setup.status === 'passed') && tests.status === 'passed' && change.headCommit === workspace.baseCommit;
  let summary = agent.summary.trim().slice(0,12000);
  if (!summary) summary = succeeded ? `${label} completed and configured tests passed.` : `${label} execution did not complete successfully.`;
  if (!succeeded) {
    const reason = change.headCommit !== workspace.baseCommit ? 'Unexpected Git HEAD change.' : agent.evidence.status !== 'passed' ? `${label} ${agent.evidence.status}.` : setup && setup.status !== 'passed' ? `Setup ${setup.status}.` : `Tests ${tests.status}.`;
    summary = `${summary.slice(0,11800)}\nExecution failed: ${reason}`;
  }
  return {summary,diff:change.diff,actualCostMicros:null,execution:{repositoryId:options.repositoryId ?? 'local',baseCommit:workspace.baseCommit,headCommit:change.headCommit,worktreePath:workspace.path,diffTruncated:change.diffTruncated,status:succeeded ? 'succeeded' : 'failed',...(setup ? {setup} : {}),tests,...(provider === 'codex' ? {codex:agent.evidence} : {claude:agent.evidence})}};
}
