const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;

const usageKeys=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'] as const;
/** Conservative projection of the installed 2.1.319 terminal error schema. */
function quotaErrorResult(r:Record<string,unknown>,sessionId:string):boolean {
  const usage=r.usage;
  return r.type==='result'&&r.session_id===sessionId&&typeof r.uuid==='string'&&uuid.test(r.uuid)&&r.is_error===true&&
    (r.subtype==='error_during_execution'||r.subtype==='success'&&typeof r.result==='string')&&
    ['api_error','blocking_limit'].includes(r.terminal_reason as string)&&
    ['duration_ms','duration_api_ms','num_turns'].every(k=>typeof r[k]==='number'&&timestamp(r[k] as number))&&
    (r.stop_reason===null||typeof r.stop_reason==='string')&&typeof r.total_cost_usd==='number'&&Number.isFinite(r.total_cost_usd)&&r.total_cost_usd>=0&&
    object(usage)&&usageKeys.every(k=>typeof usage[k]==='number'&&timestamp(usage[k] as number))&&object(r.modelUsage)&&
    Array.isArray(r.permission_denials)&&r.permission_denials.length===0&&
    (r.subtype==='success'||Array.isArray(r.errors)&&r.errors.every(e=>typeof e==='string'))&&
    r.runner_exit===undefined&&r.startup_failure_reason===undefined&&r.interrupted_by_shutdown===undefined&&r.stopped_by_permission_check===undefined&&
    (!('parent_tool_use_id' in r)||r.parent_tool_use_id===null);
}

/** Structured evidence only; never authorizes retry. Arguments and returned reset use milliseconds. */
export function parseClaudeQuota(stdout: string, sessionId: string, now: number, endsAt: number): {kind:'rejected';resetsAt:number;evidence:'claude_rate_limit_event'} | undefined {
  if (!uuid.test(sessionId) || !timestamp(now) || !timestamp(endsAt) || endsAt <= now || stdout.length > 4*1024*1024 || Buffer.byteLength(stdout, 'utf8') > 4*1024*1024) return undefined;
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.length > 5000) return undefined;
  const seen = new Set<string>();
  let rateLimitAssistant=false,terminalError=false;
  let wait: ReturnType<typeof parseClaudeQuota>;
  for (const line of lines) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return undefined; }
    if (!object(record) || typeof record.type !== 'string' || !record.type) return undefined;
    if ('session_id' in record && (typeof record.session_id !== 'string' || !uuid.test(record.session_id) || record.session_id !== sessionId)) return undefined;
    if(record.type==='assistant'&&record.error==='rate_limit') {
      if(record.session_id!==sessionId||typeof record.uuid!=='string'||!uuid.test(record.uuid)||record.parent_tool_use_id!==null||!object(record.message)||record.message.role!=='assistant'||!Array.isArray(record.message.content)) return undefined;
      rateLimitAssistant=true;
    } else if(record.error!==undefined&&record.error!==null) return undefined;
    if(record.type==='error') return undefined;
    if(record.is_error===true) { if(!quotaErrorResult(record,sessionId)) return undefined; terminalError=true; }
    else if(record.type==='result'&&record.subtype!=='success') return undefined;
    if (record.type !== 'rate_limit_event') continue;
    if (record.session_id !== sessionId || typeof record.uuid !== 'string' || !uuid.test(record.uuid) || seen.has(record.uuid.toLowerCase()) || ('parent_tool_use_id' in record && record.parent_tool_use_id !== null)) return undefined;
    seen.add(record.uuid.toLowerCase());
    const info = record.rate_limit_info;
    if (!object(info) || !['allowed','allowed_warning','rejected'].includes(info.status as string)) return undefined;
    if ('resetsAt' in info && (typeof info.resetsAt !== 'number' || !Number.isSafeInteger(info.resetsAt) || info.resetsAt <= 0)) return undefined;
    if ('rateLimitType' in info && !['five_hour','seven_day','seven_day_opus','seven_day_sonnet','seven_day_overage_included','overage'].includes(info.rateLimitType as string)) return undefined;
    wait = undefined;
    if (info.status === 'rejected') {
      if (typeof info.resetsAt !== 'number') return undefined;
      const resetsAt = info.resetsAt * 1000;
      if (!Number.isSafeInteger(resetsAt) || resetsAt <= now || resetsAt >= endsAt) return undefined;
      wait = {kind:'rejected',resetsAt,evidence:'claude_rate_limit_event'};
    }
  }
  return terminalError&&!rateLimitAssistant?undefined:wait;
}
