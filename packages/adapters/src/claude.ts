import { homedir } from 'node:os';
import type { AgentAdapter, AgentRunEvidence } from '../../contracts/src/index.js';
import { runProcess, processEnvironment } from './process.js';
import { createLocalAdapter, taskPrompt, type LocalExecutionOptions } from './local-execution.js';

export interface ClaudeOptions extends LocalExecutionOptions { claudeCommand?: string }
type JsonRecord = Record<string,unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function terminalResult(value: unknown): JsonRecord | null {
  if (!Array.isArray(value)) return record(value);
  const last = record(value.at(-1));
  if (!last || last.type !== 'result' || value.some(entry=>record(entry) === null)) return null;
  return value.filter(entry=>record(entry)?.type === 'result').length === 1 ? last : null;
}
function usageFrom(value: unknown): AgentRunEvidence['usage'] {
  const usage = record(value);
  if (!usage) return null;
  const read = usage.cache_read_input_tokens ?? 0, created = usage.cache_creation_input_tokens ?? 0;
  if (!counter(usage.input_tokens) || !counter(read) || !counter(created) || !counter(usage.output_tokens)) return null;
  const input = usage.input_tokens+read+created;
  return Number.isSafeInteger(input) ? {inputTokens:input,cachedInputTokens:read,outputTokens:usage.output_tokens} : null;
}

export function createClaudeAdapter(options: ClaudeOptions): AgentAdapter {
  return createLocalAdapter('claude',options,async (workspace,task,signal) => {
    const tools = 'Read,Edit,Write,Glob,Grep';
    const command = [options.claudeCommand ?? 'claude','--print','--output-format','json','--restricted','--safe-mode','--permission-mode','acceptEdits','--tools',tools,'--allowedTools',tools,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--disable-slash-commands','--settings','{"disableAllHooks":true}'];
    if (options.model) command.push('--model',options.model);
    const execution = await runProcess(command,{cwd:workspace.path,signal,timeoutMs:options.timeoutMs ?? 600000,input:taskPrompt(task),env:processEnvironment(process.env.HOME ?? homedir(),'claude'),maxOutputBytes:1_000_000});
    let result: JsonRecord | null = null, rejection = '';
    if (execution.truncated) rejection = 'Claude JSON output exceeded the capture limit.';
    else {
      try { result = terminalResult(JSON.parse(execution.stdout)); }
      catch { rejection = 'Claude did not return valid JSON.'; }
      if (!result && !rejection) rejection = 'Claude did not return a result object.';
    }
    if (result) {
      if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || typeof result.result !== 'string') rejection = 'Claude did not report a successful result.';
      else if (result.stop_reason === 'refusal') rejection = 'Claude refused the requested task.';
      else if (result.permission_denials !== undefined && (!Array.isArray(result.permission_denials) || result.permission_denials.length > 0)) rejection = 'Claude reported denied tool permissions.';
    }
    const status = execution.status === 'passed' && rejection ? 'error' : execution.status;
    let summary = typeof result?.result === 'string' ? result.result.slice(0,12000) : '';
    if (!summary && Array.isArray(result?.errors)) summary = result.errors.filter((entry):entry is string=>typeof entry === 'string').join('\n').slice(0,12000);
    if (rejection) summary = `${summary.slice(0,11600)}${summary ? '\n' : ''}${rejection}`;
    const models = record(result?.modelUsage);
    const modelNames = models ? Object.keys(models) : [];
    const model = options.model ?? (typeof result?.model === 'string' ? result.model.slice(0,160) : modelNames.length === 1 ? modelNames[0]!.slice(0,160) : null);
    return {summary,evidence:{status,exitCode:execution.exitCode,threadId:typeof result?.session_id === 'string' ? result.session_id.slice(0,200) : null,model,usage:usageFrom(result?.usage),stderr:`${execution.stderr}${rejection ? `\n${rejection}` : ''}`.slice(0,16000)}};
  });
}
