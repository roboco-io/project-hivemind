import type {RuntimeInput,Provider,ProcessResult} from '../contracts.ts';
import {canonicalSourcePath,validateSnapshot} from '../snapshot.ts';
import {claudeOuterSandboxSettings} from './claude-guard-policy.ts';
import {isDeepStrictEqual} from 'node:util';
export interface ProviderPaths {home:string;privateDir:string;workspace:string;scriptRoot:string}
const object=(x:unknown):Record<string,any>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:null;
const string=(x:unknown,max=24000):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!x.includes('\0');
export function validateRuntimeInput(input:unknown):RuntimeInput {
 const v=object(input);if(!v)throw new Error('Invalid runtime input');
 const allowed=['version','jobId','attempt','mode','provider','instructions','snapshot','argv','timeoutMs','auth','authReturnPublicKey','claudeNestedCompatible','ralph'];
 if(Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('Unknown runtime field');
 if(v.version!==1||!string(v.jobId,120)||!string(v.attempt,120)||!/^[A-Za-z0-9_-]+$/.test(v.jobId)||!/^[A-Za-z0-9_-]+$/.test(v.attempt)||!['agent','compute'].includes(v.mode)||!Number.isSafeInteger(v.timeoutMs)||v.timeoutMs<1||v.timeoutMs>3600000)throw new Error('Invalid runtime identity or deadline');
 v.snapshot=validateSnapshot(v.snapshot);
 if(v.mode==='compute'){
  if(v.auth!==undefined||v.provider!==undefined||v.authReturnPublicKey!==undefined||v.instructions!==undefined||v.claudeNestedCompatible!==undefined||v.ralph!==undefined)throw new Error('Compute cannot receive provider authentication or agent settings');
  if(!Array.isArray(v.argv)||!v.argv.length||v.argv.length>32||v.argv.some((x:unknown)=>!string(x,1000)))throw new Error('Invalid compute argv');
 }else{
  if(!['codex','claude'].includes(v.provider)||!string(v.instructions)||!string(v.auth,262144)||!string(v.authReturnPublicKey,10000)||v.argv!==undefined)throw new Error('Agent authentication and instructions are required');
  if(v.claudeNestedCompatible!==undefined&&typeof v.claudeNestedCompatible!=='boolean')throw new Error('Invalid sandbox policy');
  if(v.ralph!==undefined){
   const r=object(v.ralph);
   if(!r||Object.keys(r).some(k=>!['maxRounds','writes','token'].includes(k))||
    !Number.isSafeInteger(r.maxRounds)||r.maxRounds<1||r.maxRounds>4||
    !Array.isArray(r.writes)||r.writes.length<1||r.writes.length>32||
    !r.writes.every((p:unknown)=>canonicalSourcePath(p)===p)||
    typeof r.token!=='string'||!/^[a-f0-9]{64}$/.test(r.token))throw new Error('Invalid Ralph policy');
  }
  if(v.provider==='codex'){
   let auth;try{auth=JSON.parse(v.auth);}catch{throw new Error('Invalid subscription auth');}
   if(auth.auth_mode!=='chatgpt'||!object(auth.tokens)||!string(auth.tokens.access_token,262144)||!string(auth.tokens.refresh_token,262144)||auth.OPENAI_API_KEY)throw new Error('Codex requires subscription authentication');
  }
 }
 return v as unknown as RuntimeInput;
}
export function providerArgs(provider:Provider,instructions:string,paths:ProviderPaths,sessionId?:string):string[] {
 if(sessionId!==undefined&&!/^[a-f0-9-]{36}$/i.test(sessionId))throw new Error('Invalid provider session');
 if(provider==='codex'){
  const denied=[...new Set(['/runtime','/proc',paths.home+'/.codex/auth.json',paths.privateDir])].map(path=>`${JSON.stringify(path)}="deny"`).join(',');
  return ['-a','never','-c','cli_auth_credentials_store="file"','-c','default_permissions="hivemind"','-c',`permissions.hivemind={extends=":workspace",filesystem={${denied}}}`,'-c','agents.enabled=true','-c','agents.max_concurrent_threads_per_session=3','-c','mcp_servers.phase0.command="node"','-c',`mcp_servers.phase0.args=[${JSON.stringify(paths.scriptRoot+'/mcp-server.ts')}]`,'-c','mcp_servers.phase0.required=true','exec',...(sessionId?['resume','--json','--skip-git-repo-check',sessionId]:['--json','--skip-git-repo-check']),instructions];
 }
 return ['-p',...(sessionId?['--resume',sessionId]:[]),'--restricted','--output-format','stream-json','--verbose','--settings',paths.privateDir+'/settings.json','--strict-mcp-config','--mcp-config',paths.privateDir+'/mcp.json','--permission-mode','dontAsk','--permission-prompts','none','--tools','Bash,Agent','--allowedTools','Bash,Agent,mcp__phase0__phase0_probe','--disallowedTools','Write,Edit,NotebookEdit','--disable-slash-commands','--forward-subagent-text','--include-hook-events','--agents',JSON.stringify({worker:{description:'Perform an independent coding task in the workspace.',prompt:'Use sandboxed Bash only. Do not inspect credentials, private runtime state or environment secrets.',tools:['Bash']}}),'--',instructions];
}
export function claudeSettings(paths:ProviderPaths,nested:boolean):Record<string,unknown> {
 const hook=[{matcher:'^worker$',hooks:[{type:'command',command:`node ${paths.scriptRoot}/claude-agent-hook.ts`,timeout:5}]}];
 return {sandbox:{enabled:true,autoAllowBashIfSandboxed:true,failIfUnavailable:true,allowUnsandboxedCommands:false,...claudeOuterSandboxSettings(paths,nested)},hooks:{SubagentStart:hook,SubagentStop:hook}};
}
export function buildEnv(source:NodeJS.ProcessEnv,home:string,provider?:Provider,auth?:string):NodeJS.ProcessEnv {
 const out:NodeJS.ProcessEnv={HOME:home,USER:'node',LOGNAME:'node',CI:'1',TERM:'dumb',DISABLE_AUTOUPDATER:'1'};
 for(const k of ['PATH','TMPDIR','TMP','TEMP','LANG','LC_ALL','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'])if(source[k]!==undefined)out[k]=source[k];
 out.GIT_CONFIG_GLOBAL='/dev/null';out.GIT_CONFIG_SYSTEM='/dev/null';out.GIT_CONFIG_NOSYSTEM='1';
 if(provider==='claude'){if(!auth)throw new Error('Missing Claude subscription token');out.CLAUDE_CODE_OAUTH_TOKEN=auth;out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';}
 if(provider==='codex')out.CODEX_HOME=home+'/.codex';
 return out;
}
function records(raw:string):Record<string,any>[] {
 try {
  const x=JSON.parse(raw);
  if(Array.isArray(x))return x.every(item=>object(item)!==null)?x:[];
  const one=object(x);return one?[one]:[];
 }catch{}
 try {
  const rows=raw.split(/\r?\n/).filter(line=>line.trim()).map(line=>object(JSON.parse(line)));
  return rows.every(row=>row!==null)?rows as Record<string,any>[]:[];
 }catch{return [];}
}
function authFailure(provider:Provider,events:Record<string,any>[],process:ProcessResult):boolean {
 const codes=new Set(['authentication_error','authentication_failed','invalid_grant','login_required','auth_required','token_expired','unauthorized']);
 const login=/^(?:error:\s*)?(?:not logged in(?:[.!:\s]|$)|authentication (?:required|failed)(?:[.!:\s]|$)|(?:please\s+)?(?:run\s+(?:codex\s+login|\/login)|log in|sign in)(?:[.!:\s]|$))/im;
 const message=/(?:\b401\b[^\n]*\bunauthorized\b|\b(?:authentication_error|authentication_failed|invalid_grant)\b|\bplease\s+(?:run\s+(?:codex\s+login|\/login)|log in|sign in)\b|\bnot logged in\b|\b(?:log out and sign in again|log in again)\b)/i;
 const inspect=(value:unknown,depth=0):boolean=>{
  if(depth>4)return false;if(typeof value==='string')return codes.has(value.toLowerCase())||message.test(value);
  const item=object(value);if(!item)return Array.isArray(value)&&value.some(v=>inspect(v,depth+1));
  if(['status','status_code','http_status','http_status_code'].some(key=>item[key]===401||item[key]==='401'))return true;
  return ['type','code','error','message','errors'].some(key=>inspect(item[key],depth+1));
 };
 const nativeErrors=events.filter(e=>provider==='codex'?['error','turn.failed'].includes(e.type):e.type==='error'||e.type==='result'&&e.is_error===true||e.type==='assistant'&&typeof e.error==='string');
 return nativeErrors.some(e=>inspect(e))||(process.status!=='passed'&&login.test(process.stderr));
}
interface McpReceipt {callId:string;nonce:string;marker:'hivemind-phase0-mcp-v1'}
const nonceValid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const callIdValid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
function mcpReceipts(provider:Provider,events:Record<string,any>[]):McpReceipt[]{
 const marker='hivemind-phase0-mcp-v1',receipts:McpReceipt[]=[],seen=new Set<string>();
 const add=(callId:string,nonce:string)=>{if(!seen.has(callId)&&receipts.length<64){seen.add(callId);receipts.push({callId,nonce,marker});}};
 if(provider==='codex'){
  for(const event of events){const item=object(event.item),result=object(item?.result),output=object(result?.structured_content);if(event.type!=='item.completed'||item?.type!=='mcp_tool_call'||item.server!=='phase0'||item.tool!=='phase0_probe'||item.status!=='completed'||item.error!==null||result?.isError===true||result?.is_error===true||!callIdValid(item.id)||!nonceValid(output?.nonce)||output?.marker!==marker)continue;
   if(item.arguments!==undefined){let args:unknown=item.arguments;if(typeof args==='string'){try{args=JSON.parse(args);}catch{continue;}}if(object(args)?.nonce!==output.nonce)continue;}
   add(item.id,output.nonce);
  }
  return receipts;
 }
 const calls=new Map<string,string|null>(),consumed=new Set<string>();
 const returned=(value:unknown,nonce:string,depth=0,budget={remaining:256}):boolean=>{
  if(depth>10||--budget.remaining<0)return false;
  if(typeof value==='string'){if(value.length>65536)return false;try{return returned(JSON.parse(value),nonce,depth+1,budget);}catch{return false;}}
  if(Array.isArray(value))return value.some(item=>returned(item,nonce,depth+1,budget));
  const item=object(value);if(!item||item.isError===true||item.is_error===true)return false;
  if(item.nonce===nonce&&item.marker===marker)return true;
  return Object.values(item).some(item=>returned(item,nonce,depth+1,budget));
 };
 for(const event of events){const content=event.message?.content;if(!Array.isArray(content))continue;
  if(event.type==='assistant')for(const item of content){if(item?.type==='tool_use'&&item.name==='mcp__phase0__phase0_probe'&&callIdValid(item.id)&&nonceValid(item.input?.nonce))calls.set(item.id,calls.has(item.id)?null:item.input.nonce);}
  if(event.type==='user')for(const item of content){if(item?.type!=='tool_result'||!callIdValid(item.tool_use_id)||consumed.has(item.tool_use_id))continue;consumed.add(item.tool_use_id);const nonce=calls.get(item.tool_use_id);if(nonce&&item.is_error!==true&&returned(item.content,nonce))add(item.tool_use_id,nonce);}
 }
 return receipts;
}
export type ProviderFailureReason='AUTHENTICATION_REQUIRED'|'PROCESS_NOT_PASSED'|'CAPTURE_TRUNCATED'|'CODEX_MISSING_COMPLETION'|'CODEX_ERROR_EVENT'|'CLAUDE_NATIVE_ERROR'|'CLAUDE_RESULT_COUNT'|'CLAUDE_RESULT_SCOPE'|'CLAUDE_RESULT_RECEIPTS'|'CLAUDE_RESULT_NOT_LAST'|'CLAUDE_RESULT_SUBTYPE'|'CLAUDE_RESULT_ERROR_FLAG'|'CLAUDE_RESULT_TEXT_MISSING'|'CLAUDE_REFUSAL'|'CLAUDE_PERMISSION_DENIALS';
export type TrailingEventKind='RATE_LIMIT_EVENT'|'SYSTEM_HOOK'|'OTHER';
export interface ClaudeResultShape {initialSession:'ROOT'|'OTHER'|'MISSING';finalSession:'ROOT'|'OTHER'|'MISSING';parentToolUse:'NONEMPTY'|'NULL'|'MISSING';uuidPresent:boolean;uuidDuplicate:boolean;identicalToFinal:boolean;subtype:'SUCCESS'|'OTHER';isError:'TRUE'|'FALSE'|'MISSING'}
export function parseProviderResult(provider:Provider,process:ProcessResult):{success:boolean;summary:string;sessionId?:string;usage?:Record<string,number>;errorCode?:'NEEDS_REAUTH';mcpReceipts:McpReceipt[];failureReasons:ProviderFailureReason[];trailingEventKinds?:TrailingEventKind[];permissionDenialCount?:number;resultCount?:number;resultShapes?:ClaudeResultShape[];resultShapesTruncated?:boolean} {
 const events=records(process.stdout),errorCode=authFailure(provider,events,process)?'NEEDS_REAUTH' as const:undefined,receipts=mcpReceipts(provider,events);let summary='',sessionId:string|undefined,usage:Record<string,number>|undefined;
 const failureReasons:ProviderFailureReason[]=[];
 if(errorCode)failureReasons.push('AUTHENTICATION_REQUIRED');
 if(process.status!=='passed')failureReasons.push('PROCESS_NOT_PASSED');
 if(process.truncated)failureReasons.push('CAPTURE_TRUNCATED');
 if(provider==='codex'){
  for(const e of events){if(e.type==='thread.started'&&typeof e.thread_id==='string')sessionId=e.thread_id;if(e.type==='item.completed'&&e.item?.type==='agent_message'&&typeof e.item.text==='string')summary=e.item.text;}
  const final=events.filter(e=>e.type==='turn.completed').at(-1);if(object(final?.usage))usage=Object.fromEntries(Object.entries(final!.usage).filter(([,v])=>typeof v==='number'&&Number.isSafeInteger(v)&&Number(v)>=0)) as Record<string,number>;
  if(!final)failureReasons.push('CODEX_MISSING_COMPLETION');
  if(events.some(e=>['error','turn.failed'].includes(e.type)))failureReasons.push('CODEX_ERROR_EVENT');
  return {success:!errorCode&&process.status==='passed'&&!process.truncated&&Boolean(final)&&!events.some(e=>['error','turn.failed'].includes(e.type)),summary,sessionId,usage,errorCode,mcpReceipts:receipts,failureReasons};
 }
 const finals=events.filter(e=>e.type==='result'),final=finals.at(-1);
 const nativeError=events.some(event=>event.type==='error'||event.type==='assistant'&&event.error!=null);
 const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
 const inits=events.filter(event=>event.type==='system'&&event.subtype==='init');
 const rootIds=new Set(inits.filter(event=>uuid(event.session_id)).map(event=>event.session_id.toLowerCase()));
 const rootBound=inits.length>0&&rootIds.size===1&&inits.every(event=>uuid(event.session_id)&&event.parent_tool_use_id==null);
 const rootId=rootIds.values().next().value;
 const boundReceipt=(receipt:Record<string,any>)=>rootBound&&uuid(receipt.session_id)&&receipt.session_id.toLowerCase()===rootId&&receipt.parent_tool_use_id==null;
 const multiple=finals.length>1;
 const scopeValid=multiple?rootBound&&finals.every(boundReceipt):inits.length>0?!!final&&boundReceipt(final):final?.parent_tool_use_id==null;
 const successfulReceipt=(receipt:Record<string,any>)=>receipt.subtype==='success'&&receipt.is_error===false&&typeof receipt.result==='string'&&receipt.stop_reason!=='refusal'&&(receipt.permission_denials===undefined||(Array.isArray(receipt.permission_denials)&&receipt.permission_denials.length===0));
 const receiptIds=finals.filter(receipt=>uuid(receipt.uuid)).map(receipt=>receipt.uuid.toLowerCase());
 const receiptsValid=!multiple||(receiptIds.length===finals.length&&new Set(receiptIds).size===finals.length&&finals.every(successfulReceipt));
 const countValid=finals.length===1||(multiple&&finals.length<=16&&scopeValid&&receiptsValid);
 if(typeof final?.result==='string')summary=final.result;else if(Array.isArray(final?.errors))summary=final.errors.filter((x:unknown)=>typeof x==='string').join('\n');
 if(typeof final?.session_id==='string')sessionId=final.session_id;
 if(object(final?.usage))usage=Object.fromEntries(Object.entries(final!.usage).filter(([,v])=>typeof v==='number'&&Number.isSafeInteger(v)&&Number(v)>=0)) as Record<string,number>;
 if(process.status==='passed'&&process.exitCode!==0)failureReasons.push('PROCESS_NOT_PASSED');
 if(nativeError)failureReasons.push('CLAUDE_NATIVE_ERROR');
 if(!countValid)failureReasons.push('CLAUDE_RESULT_COUNT');
 if(!scopeValid)failureReasons.push('CLAUDE_RESULT_SCOPE');
 if(!receiptsValid)failureReasons.push('CLAUDE_RESULT_RECEIPTS');
 if(events.at(-1)!==final)failureReasons.push('CLAUDE_RESULT_NOT_LAST');
 if(final?.subtype!=='success')failureReasons.push('CLAUDE_RESULT_SUBTYPE');
 if(final?.is_error!==false)failureReasons.push('CLAUDE_RESULT_ERROR_FLAG');
 if(typeof final?.result!=='string')failureReasons.push('CLAUDE_RESULT_TEXT_MISSING');
 if(final?.stop_reason==='refusal')failureReasons.push('CLAUDE_REFUSAL');
 if(final?.permission_denials!==undefined&&!(Array.isArray(final.permission_denials)&&final.permission_denials.length===0))failureReasons.push('CLAUDE_PERMISSION_DENIALS');
 let trailingEventKinds:TrailingEventKind[]|undefined;
 if(final&&events.at(-1)!==final){
  const trailing=events.slice(events.lastIndexOf(final)+1).map((event):TrailingEventKind=>event.type==='rate_limit_event'?'RATE_LIMIT_EVENT':event.type==='system'&&['hook_started','hook_progress','hook_response','hook_summary','hook_end'].includes(event.subtype)?'SYSTEM_HOOK':'OTHER');
  trailingEventKinds=[...new Set(trailing)];
 }
 const denialCount=Array.isArray(final?.permission_denials)?final.permission_denials.length:undefined;
 const permissionDenialCount=Number.isSafeInteger(denialCount)?denialCount:undefined;
 let resultCount:number|undefined,resultShapes:ClaudeResultShape[]|undefined,resultShapesTruncated:boolean|undefined;
 if(finals.length!==1){
  const present=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
  const initial=events.find(event=>event.type==='system'&&event.subtype==='init');
  const relation=(value:unknown,reference:unknown):'ROOT'|'OTHER'|'MISSING'=>!present(value)||!present(reference)?'MISSING':value===reference||(uuid(value)&&uuid(reference)&&value.toLowerCase()===reference.toLowerCase())?'ROOT':'OTHER';
  const uuids=new Map<string,number>();for(const record of finals)if(present(record.uuid)){const key=record.uuid.toLowerCase();uuids.set(key,Math.min(2,(uuids.get(key)??0)+1));}
  resultCount=Math.min(finals.length,16);resultShapesTruncated=finals.length>16;
  resultShapes=finals.slice(0,16).map(record=>({initialSession:relation(record.session_id,initial?.session_id),finalSession:relation(record.session_id,final?.session_id),parentToolUse:present(record.parent_tool_use_id)?'NONEMPTY':record.parent_tool_use_id===null?'NULL':'MISSING',uuidPresent:present(record.uuid),uuidDuplicate:present(record.uuid)&&(uuids.get(record.uuid.toLowerCase())??0)>1,identicalToFinal:isDeepStrictEqual(record,final),subtype:record.subtype==='success'?'SUCCESS':'OTHER',isError:record.is_error===true?'TRUE':record.is_error===false?'FALSE':'MISSING'}));
 }
 return {success:!errorCode&&!nativeError&&process.status==='passed'&&process.exitCode===0&&!process.truncated&&countValid&&scopeValid&&receiptsValid&&events.at(-1)===final&&final?.subtype==='success'&&final?.is_error===false&&typeof final?.result==='string'&&final?.stop_reason!=='refusal'&&(final?.permission_denials===undefined||(Array.isArray(final.permission_denials)&&final.permission_denials.length===0)),summary,sessionId,usage,errorCode,mcpReceipts:receipts,failureReasons,trailingEventKinds,permissionDenialCount,resultCount,resultShapes,resultShapesTruncated};
}
