import {workflowApproval,workflowDraft,workflowId,workflowList,workflowRegistration,workflowView} from '../../../packages/contracts/src/workflow.js';
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface McpSettings { apiUrl: string; operatorToken: string }
export interface HivemindMcpOptions extends McpSettings { fetchImpl?: typeof fetch }
const configurationError = () => new Error('Invalid HIVEMIND MCP configuration.');
const toolError = 'HIVEMIND 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
const developmentToken = 'local-development-only';
const taskStates = ['awaiting_execution_approval','queued','running','awaiting_review','completed','rejected','cancelled','failed'];
const taskIdPattern = /^cf-[A-Za-z0-9_-]{1,116}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(toolError);
  return value as Record<string, unknown>;
}
function validateSettings(settings: McpSettings): McpSettings {
  const url = new URL(settings.apiUrl);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (settings.apiUrl !== settings.apiUrl.trim() || settings.apiUrl.length > 4096 || url.href !== url.origin + '/' || !['http:','https:'].includes(url.protocol) || url.username || url.password || (!loopback && url.protocol !== 'https:') || !settings.operatorToken || settings.operatorToken.length > 4096 || /[\s\x00-\x1f\x7f]/.test(settings.operatorToken) || (!loopback && settings.operatorToken === developmentToken)) throw configurationError();
  return { apiUrl: url.href, operatorToken: settings.operatorToken };
}
export function loadMcpSettings(env: NodeJS.ProcessEnv = process.env): McpSettings {
  try {
    if (env.HIVEMIND_OPERATOR_TOKEN !== undefined && env.HIVEMIND_OPERATOR_TOKEN_FILE !== undefined) throw configurationError();
    let operatorToken = env.HIVEMIND_OPERATOR_TOKEN;
    if (env.HIVEMIND_OPERATOR_TOKEN_FILE !== undefined) {
      const descriptor = openSync(env.HIVEMIND_OPERATOR_TOKEN_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(descriptor);
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 64000) throw configurationError();
        const value = record(JSON.parse(readFileSync(descriptor, 'utf8')));
        if (typeof value.OPERATOR_TOKEN !== 'string') throw configurationError();
        operatorToken = value.OPERATOR_TOKEN;
      } finally { closeSync(descriptor); }
    }
    const apiUrl = env.HIVEMIND_API_URL ?? 'http://127.0.0.1:4310';
    return validateSettings({ apiUrl, operatorToken: operatorToken ?? developmentToken });
  } catch { throw configurationError(); }
}

// SDK schema errors can contain rejected property names. Keep those errors out of the protocol output.
class SafeMcpServer extends McpServer {
  override async connect(transport: Transport): Promise<void> {
    const wrapped: Transport = {
      start: () => transport.start(), close: () => transport.close(),
      send: (message, options) => {
        let outgoing: JSONRPCMessage = message;
        if ('error' in message) outgoing = { jsonrpc: '2.0', id: message.id, error: { code: message.error.code, message: toolError } };
        else if ('result' in message && message.result.isError === true) outgoing = { ...message, result: { isError: true, content: [{ type: 'text', text: toolError }] } };
        return transport.send(outgoing, options);
      },
      get sessionId() { return transport.sessionId; },
      setProtocolVersion: version => transport.setProtocolVersion?.(version)
    };
    transport.onmessage = (message, extra) => wrapped.onmessage?.(message, extra);
    transport.onclose = () => wrapped.onclose?.();
    transport.onerror = () => wrapped.onerror?.(new Error('HIVEMIND MCP transport error.'));
    await super.connect(wrapped);
  }
}

/** A stdio-compatible operator HTTP client. It never opens the database or provider credentials. */
export function createHivemindMcpServer(options: HivemindMcpOptions): McpServer {
  let settings: McpSettings;
  try { settings = validateSettings(options); } catch { throw configurationError(); }
  const fetchImpl = options.fetchImpl ?? fetch;
  const redact = (text: string) => text.replaceAll(settings.operatorToken, '[REDACTED]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|control[_-]?token|operator[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,"'}]+/gi, '$1[REDACTED]');
  const text = (value: unknown, maximum: number): string | null => typeof value === 'string' ? redact(value).slice(0, maximum) : null;
  const publicValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(publicValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,child]) => [key,publicValue(child)]));
    return value;
  };
  const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const server = new SafeMcpServer({ name: 'hivemind', version: '0.1.0' }, { maxToolInputElements: 128, instructions: 'Cloudflare 작업의 대상 저장소와 고정 커밋을 먼저 확인하세요. 작업 등록은 실행 승인 전 초안만 만듭니다. 실행 승인·결과 수락·반려·중단은 명시적인 사용자 지시에 따라 별도로 호출하세요. 결과 수락은 검토 이력만 기록하며 적용·병합·푸시를 실행하지 않습니다.' });
  async function api(path: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 64000) throw new Error(toolError);
    const response = await fetchImpl(new URL(path, settings.apiUrl), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + settings.operatorToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(encoded === undefined ? {} : { body: encoded }), signal: AbortSignal.any([signal, AbortSignal.timeout(path.startsWith('/api/cloudflare/workflows')?30000:10000)])
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 2_000_000 || !response.body) { await response.body?.cancel(); throw new Error(toolError); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); throw new Error(toolError); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  async function run(work: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
    try {
      const output = record(publicValue(await work()));
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch { return { isError: true, content: [{ type: 'text', text: toolError }] }; }
  }
  function repository(value: unknown) {
    const item = record(value);
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || typeof item.baseCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(item.baseCommit) || typeof item.testProfile !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(item.testProfile) || !Array.isArray(item.testCommand) || item.testCommand.length < 1 || item.testCommand.length > 32 || !item.testCommand.every(arg => typeof arg === 'string' && !!arg.trim() && arg.length <= 1000 && !arg.includes('\0'))) throw new Error(toolError);
    return { id: item.id, name: text(item.name,200), baseCommit: item.baseCommit, testProfile: item.testProfile, testCommand: item.testCommand.map(arg => text(arg,1000)) };
  }
  function connection(value: unknown) {
    const item = value && typeof value === 'object' ? record(value) : {};
    return { status: ['ready','checking','unavailable'].includes(String(item.status)) ? item.status : 'unavailable', message: text(item.message,300), checkedAt: text(item.checkedAt,40) };
  }
  function cloudTasks(state: Record<string, unknown>): Record<string, unknown>[] {
    if (!state.cloudflare) return [];
    const tasks = record(state.cloudflare).tasks;
    if (!Array.isArray(tasks)) throw new Error(toolError);
    return tasks.map(record).filter(task => task.runtime === 'cloudflare' && typeof task.id === 'string' && taskIdPattern.test(task.id));
  }
  function summary(task: Record<string, unknown>) {
    if (typeof task.id !== 'string' || !taskIdPattern.test(task.id) || task.runtime !== 'cloudflare' || !['codex','claude'].includes(String(task.provider)) || !taskStates.includes(String(task.status))) throw new Error(toolError);
    const remote = record(task.remote);
    return { id: task.id, title: text(task.title,160), provider: task.provider, runtime: 'cloudflare', status: task.status, repositoryId: text(task.repositoryId,120), baseCommit: text(task.baseCommit,40), updatedAt: text(task.updatedAt,40), actualCostMicros: null, remote: { phase: text(remote.phase,100), jobId: text(remote.jobId,200), containerStopped: remote.containerStopped === true, authSynced: remote.authSynced === true } };
  }
  function budget(maxChars: number) {
    let left = maxChars; let truncated = false;
    return {
      take(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const scrubbed = redact(value); const result = scrubbed.slice(0,left);
        if (scrubbed.length > left) truncated = true;
        left -= result.length; return result;
      },
      get truncated() { return truncated; }
    };
  }
  function evidenceProcess(value: unknown, includeLogs: boolean, limit: ReturnType<typeof budget>) {
    if (!value) return null;
    const item = record(value);
    return { status: text(item.status,40), exitCode: typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode) ? item.exitCode : null, durationMs: numeric(item.durationMs), truncated: item.truncated === true, ...(includeLogs ? { stdout: limit.take(item.stdout), stderr: limit.take(item.stderr) } : {}) };
  }
  const noArgs = z.strictObject({});
  const taskId = z.string().regex(taskIdPattern);
  const reason = z.string().trim().min(1).max(2000);
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  server.registerTool('hivemind_status', { title: 'HIVEMIND 상태', description: 'Cloudflare 연결, 설정된 대상 저장소 이름·고정 커밋·검증 명령과 작업 수를 조회합니다. 원하는 프로젝트와 대상 저장소가 같은지 먼저 확인하세요.', inputSchema: noArgs, annotations: readOnly }, async (_args, extra) => run(async () => {
    const [capabilities, state] = await Promise.all([api('/api/capabilities',extra.signal), api('/api/state',extra.signal)]);
    const cloud = capabilities.cloudflare ? record(capabilities.cloudflare) : null;
    const counts = Object.fromEntries(taskStates.map(status => [status,0])); const tasks = cloudTasks(state);
    for (const task of tasks) if (typeof task.status === 'string' && Object.hasOwn(counts,task.status)) counts[task.status]!++;
    return { runtime: 'cloudflare', configured: Boolean(cloud), connection: connection(state.cloudflare ? record(state.cloudflare).connection : cloud?.connection), repository: cloud ? repository(cloud.repository) : null, providers: cloud && Array.isArray(cloud.providers) ? cloud.providers.filter(provider => provider === 'codex' || provider === 'claude') : [], counts, totalTasks: tasks.length, workflowsAvailable: cloud?.workflows === true };
  }));
  server.registerTool('hivemind_list_tasks', { title: 'HIVEMIND 작업 목록', description: '최근 Cloudflare 작업 요약을 최대 20개 조회합니다. 로컬 작업은 포함하지 않습니다.', inputSchema: z.strictObject({ limit: z.number().int().min(1).max(20).default(20) }), annotations: readOnly }, async ({limit}, extra) => run(async () => {
    const tasks = cloudTasks(await api('/api/state',extra.signal));
    tasks.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { tasks: tasks.slice(0,limit).map(summary), totalTasks: tasks.length, hasMore: tasks.length > limit };
  }));
  server.registerTool('hivemind_create_task', { title: 'HIVEMIND 작업 초안 등록', description: '현재 서버의 고정 저장소 정책으로 Cloudflare 초안만 등록합니다. 실행하지 않습니다. status의 저장소·커밋이 사용자가 요청한 프로젝트와 같은지 확인한 뒤 호출하세요. 실행 승인은 명시적인 사용자 지시에 따라 별도 decide 도구로 기록합니다.', inputSchema: z.strictObject({ title: z.string().trim().min(1).max(160), instructions: z.string().trim().min(1).max(10000), provider: z.enum(['codex','claude']), budgetMicros: z.number().int().min(0).max(1_000_000_000) }), annotations: mutation }, async (args, extra) => run(async () => {
    const cloud = record((await api('/api/capabilities',extra.signal)).cloudflare);
    if (connection(cloud.connection).status !== 'ready' || !Array.isArray(cloud.providers) || !cloud.providers.includes(args.provider)) throw new Error(toolError);
    const policy = repository(cloud.repository);
    const task = await api('/api/cloudflare/tasks',extra.signal,{ ...args, runtime: 'cloudflare', repositoryId: policy.id, baseCommit: policy.baseCommit, testProfile: policy.testProfile });
    if (task.status !== 'awaiting_execution_approval' || task.provider !== args.provider || task.repositoryId !== policy.id || task.baseCommit !== policy.baseCommit || task.testProfile !== policy.testProfile) throw new Error(toolError);
    return { task: summary(task), executionApproved: false };
  }));
  server.registerTool('hivemind_decide_task', { title: 'HIVEMIND 사람의 결정 기록', description: '사용자의 명시적인 지시에 따라 실행 승인·결과 수락 또는 반려를 기록합니다. awaiting_execution_approval에서 approve는 유료 원격 실행을 허용합니다. awaiting_review에서 approve는 검토 이력만 기록하며 적용·병합·푸시를 실행하지 않습니다. 초안을 만든 뒤 자동으로 호출하지 마세요.', inputSchema: z.strictObject({ taskId, decision: z.enum(['approve','reject']), reason }), annotations: mutation }, async ({taskId,decision,reason}, extra) => run(async () => ({ task: summary(await api('/api/cloudflare/tasks/' + encodeURIComponent(taskId) + '/decision',extra.signal,{decision,reason})) })));
  server.registerTool('hivemind_cancel_task', { title: 'HIVEMIND 작업 중단 요청', description: '사용자의 명시적인 지시에 따라 Cloudflare 작업 중단을 요청합니다. CANCELLING은 요청 후 실제 종료 확인 중이며, 중단 완료를 뜻하지 않습니다.', inputSchema: z.strictObject({ taskId, reason }), annotations: { ...mutation, destructiveHint: true } }, async ({taskId,reason}, extra) => run(async () => ({ task: summary(await api('/api/cloudflare/tasks/' + encodeURIComponent(taskId) + '/cancel',extra.signal,{reason})) })));
  server.registerTool('hivemind_get_result', { title: 'HIVEMIND 실행 결과', description: 'Cloudflare 작업 상태와 실제 실행·별도 검증 근거를 조회합니다. diff와 로그는 opt-in입니다. maxChars는 diff·로그·요약의 공유 문자 수 상한이며, 상태 메타데이터는 별도로 제한합니다. 실패·미보고·중단 확인 중을 성공과 구분하세요.', inputSchema: z.strictObject({ taskId, includeDiff: z.boolean().default(false), includeLogs: z.boolean().default(false), maxChars: z.number().int().min(1).max(20000).default(12000) }), annotations: readOnly }, async ({taskId,includeDiff,includeLogs,maxChars}, extra) => run(async () => {
    const task = cloudTasks(await api('/api/state',extra.signal)).find(task => task.id === taskId);
    if (!task) throw new Error(toolError);
    const rawRemote = record(task.remote); const limit = budget(maxChars);
    const diff = includeDiff ? limit.take(task.diff) : undefined;
    const taskSummary = summary(task); const rawChecks = rawRemote.checks;
    if (!Array.isArray(rawChecks) || rawChecks.length > 4) throw new Error(toolError);
    const checks = rawChecks.map(value => {
      const check = record(value);
      if (!Array.isArray(check.command) || check.command.length > 32) throw new Error(toolError);
      return { id: text(check.id,120), name: text(check.name,200), status: text(check.status,100), command: check.command.map(arg => text(arg,200)), process: evidenceProcess(check.process,includeLogs,limit), credentialsAbsent: typeof check.credentialsAbsent === 'boolean' ? check.credentialsAbsent : null, sourceUnchanged: typeof check.sourceUnchanged === 'boolean' ? check.sourceUnchanged : null };
    });
    return { task: { ...taskSummary, summary: limit.take(task.summary), remote: { ...taskSummary.remote, inputSnapshotId: text(rawRemote.inputSnapshotId,200), outputSnapshotId: text(rawRemote.outputSnapshotId,200), errorCode: text(rawRemote.errorCode,100), agent: evidenceProcess(rawRemote.agent,includeLogs,limit), checks } }, ...(includeDiff ? {diff} : {}), diffIncluded: includeDiff, logsIncluded: includeLogs, diffTruncated: task.diffTruncated === true, truncated: limit.truncated || task.diffTruncated === true || rawChecks.some(value => record(value).process && record(record(value).process).truncated === true) || Boolean(rawRemote.agent && record(rawRemote.agent).truncated === true) };
  }));
  const workflowPath = '/api/cloudflare/workflows';
  server.registerTool('hivemind_create_workflow', {title:'HIVEMIND 공통 계약 워크플로 등록',
    description:'고정 커밋의 계약 파일과 Codex·Claude 쓰기 범위로 초안만 등록합니다. 재시도 시 같은 requestId를 사용하세요.',
    inputSchema:workflowDraft,annotations:mutation}, async (args,extra) => run(async () => ({
      workflow:workflowRegistration.parse(await api(workflowPath,extra.signal,args)),
    })));
  server.registerTool('hivemind_approve_workflow',{title:'HIVEMIND 워크플로 실행 승인',
    description:'사용자가 명시적으로 실행을 승인한 초안의 ID와 계약 해시를 전달합니다. 두 원격 모델 작업을 시작합니다.',
    inputSchema:workflowApproval,annotations:mutation}, async ({workflowId:id,contractHash},extra) => run(async () => ({
      workflow:workflowRegistration.parse(await api(workflowPath+'/'+id+'/approve',extra.signal,{contractHash})),
    })));
  server.registerTool('hivemind_list_workflows',{title:'HIVEMIND 워크플로 목록',
    description:'이 중앙 서비스에 등록된 최근 20개 워크플로의 ID와 계약을 조회합니다.',
    inputSchema:noArgs,annotations:readOnly}, async (_args,extra) => run(async () => workflowList.parse(await api(workflowPath,extra.signal))));
  server.registerTool('hivemind_get_workflow',{title:'HIVEMIND 워크플로 진행과 통합 결과',
    description:'같은 워크플로 ID로 워커별 랄프 라운드, 검사 상태와 통합 결과를 조회합니다.',
    inputSchema:z.strictObject({workflowId,includeDiff:z.boolean().default(false),includeLogs:z.boolean().default(false),
      maxChars:z.number().int().min(1).max(20000).default(12000)}),annotations:readOnly},
    async ({workflowId:id,includeDiff,includeLogs,maxChars},extra) => run(async () => {
      const path=workflowPath+'/'+id;
      const current=workflowView.parse(await api(path,extra.signal));
      const terminal=current.status==='SUCCEEDED'||current.status==='FAILED';
      const result=terminal?workflowView.parse(await api(path+'/result'+(includeDiff?'?diff=1':''),extra.signal)):current;
      if(result.id!==id||result.contractHash!==current.contractHash||result.inputSnapshotId!==current.inputSnapshotId)throw new Error(toolError);
      const limit=budget(maxChars);
      const {diff,verification,...view}=result;
      return {workflow:{...view,...(includeDiff?{diff:limit.take(diff)}:{}),
        verification:verification?{...verification,process:{
          status:verification.process.status,exitCode:verification.process.exitCode,durationMs:verification.process.durationMs,
          truncated:verification.process.truncated,...(includeLogs?{stdout:limit.take(verification.process.stdout),stderr:limit.take(verification.process.stderr)}:{}),
        }}:null},truncated:limit.truncated||result.diffTruncated===true||verification?.process.truncated===true};
    }));
  return server;
}
