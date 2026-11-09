import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { AgentAdapter, AgentRunEvidence } from '../../contracts/src/index.js';
import { runProcess, processEnvironment } from './process.js';
import { createLocalAdapter, taskPrompt, type LocalExecutionOptions } from './local-execution.js';

export interface CodexOptions extends LocalExecutionOptions { codexCommand?: string }

type JsonRecord = Record<string,unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function createCodexAdapter(options: CodexOptions): AgentAdapter {
  return createLocalAdapter('codex',options,async (workspace,task,signal) => {
      let summary = '', threadId: string | null = null, model = options.model ?? null;
      let usage: AgentRunEvidence['usage'] = null;
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
      const prompt = taskPrompt(task);
      const codex = await runProcess(command,{cwd:workspace.path,signal,timeoutMs:options.timeoutMs ?? 600000,input:prompt,env:processEnvironment(process.env.HOME ?? homedir(),true),maxOutputBytes:1_000_000,onStdout:chunk => consume(decoder.write(chunk))});
      consume(decoder.end());
      if (pending && !dropping) parseLine(pending);
      let codexStatus = codex.status;
      if (codexStatus === 'passed' && (!completed || failed || invalid)) codexStatus = 'error';
      return {summary,evidence:{status:codexStatus,exitCode:codex.exitCode,threadId,model,usage,stderr:codex.stderr.slice(0,16000)}};
  });
}
