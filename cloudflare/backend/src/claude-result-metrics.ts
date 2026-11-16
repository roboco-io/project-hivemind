import type {ClaudeResultMetrics} from './contracts.ts';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const counters=['duration_ms','duration_api_ms','num_turns'] as const;
const usageKeys=new Set(['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','webSearchRequests','costUSD','contextWindow','maxOutputTokens']);
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const usageNumber=(key:string,v:unknown)=>key==='costUSD'?typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER:count(v);
const model=(v:string)=>/^claude-[a-z0-9][a-z0-9._-]{0,90}$/.test(v);
// This is the final native result's reported coverage, not a session total.
export function extractClaudeResultMetrics(raw:unknown):ClaudeResultMetrics|undefined{
 if(!object(raw))return;
 const out:ClaudeResultMetrics={coverage:'final-result-provider-reported'};
 for(const key of counters)if(count(raw[key]))out[key]=raw[key] as number;
 if(object(raw.modelUsage)){
  const entries=Object.entries(raw.modelUsage).filter(([name,value])=>model(name)&&object(value)).slice(0,16);
  const usage=Object.fromEntries(entries.map(([name,value])=>[name,Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key,value])=>usageKeys.has(key)&&usageNumber(key,value)))] as const).filter(([,value])=>Object.keys(value).length));
  if(Object.keys(usage).length)out.modelUsage=usage as Record<string,Record<string,number>>;
 }
 return Object.keys(out).length>1?out:undefined;
}
export function validateClaudeResultMetrics(raw:unknown):ClaudeResultMetrics{
 if(!object(raw)||raw.coverage!=='final-result-provider-reported'||Object.keys(raw).some(k=>!['coverage',...counters,'modelUsage'].includes(k)))throw Error('Invalid Claude metrics');
 for(const key of counters)if(raw[key]!==undefined&&!count(raw[key]))throw Error('Invalid Claude metrics');
 if(raw.modelUsage!==undefined){
  if(!object(raw.modelUsage)||!Object.keys(raw.modelUsage).length||Object.keys(raw.modelUsage).length>16)throw Error('Invalid Claude metrics');
  for(const [name,values] of Object.entries(raw.modelUsage))if(!model(name)||!object(values)||!Object.keys(values).length||Object.entries(values).some(([key,value])=>!usageKeys.has(key)||!usageNumber(key,value)))throw Error('Invalid Claude metrics');
 }
 const clean=extractClaudeResultMetrics(raw);if(!clean)throw Error('Invalid Claude metrics');return clean;
}
