import type {RuntimeInput,Provider,ProcessResult} from '../contracts.ts';
import {validateSnapshot} from '../snapshot.ts';
import {claudeOuterSandboxSettings} from './claude-guard-policy.ts';
export interface ProviderPaths {home:string;privateDir:string;workspace:string;scriptRoot:string}
const object=(x:unknown):Record<string,any>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:null;
const string=(x:unknown,max=24000):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!x.includes('\0');
export function validateRuntimeInput(input:unknown):RuntimeInput {
 const v=object(input);if(!v)throw new Error('Invalid runtime input');
 const allowed=['version','jobId','attempt','mode','provider','instructions','snapshot','argv','timeoutMs','auth','authReturnPublicKey','claudeNestedCompatible'];
 if(Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('Unknown runtime field');
 if(v.version!==1||!string(v.jobId,120)||!string(v.attempt,120)||!/^[A-Za-z0-9_-]+$/.test(v.jobId)||!/^[A-Za-z0-9_-]+$/.test(v.attempt)||!['agent','compute'].includes(v.mode)||!Number.isSafeInteger(v.timeoutMs)||v.timeoutMs<1||v.timeoutMs>3600000)throw new Error('Invalid runtime identity or deadline');
 v.snapshot=validateSnapshot(v.snapshot);
 if(v.mode==='compute'){
  if(v.auth!==undefined||v.provider!==undefined||v.authReturnPublicKey!==undefined||v.instructions!==undefined||v.claudeNestedCompatible!==undefined)throw new Error('Compute cannot receive provider authentication or agent settings');
  if(!Array.isArray(v.argv)||!v.argv.length||v.argv.length>32||v.argv.some((x:unknown)=>!string(x,1000)))throw new Error('Invalid compute argv');
 }else{
  if(!['codex','claude'].includes(v.provider)||!string(v.instructions)||!string(v.auth,262144)||!string(v.authReturnPublicKey,10000)||v.argv!==undefined)throw new Error('Agent authentication and instructions are required');
  if(v.claudeNestedCompatible!==undefined&&typeof v.claudeNestedCompatible!=='boolean')throw new Error('Invalid sandbox policy');
  if(v.provider==='codex'){
   let auth;try{auth=JSON.parse(v.auth);}catch{throw new Error('Invalid subscription auth');}
   if(auth.auth_mode!=='chatgpt'||!object(auth.tokens)||!string(auth.tokens.access_token,262144)||!string(auth.tokens.refresh_token,262144)||auth.OPENAI_API_KEY)throw new Error('Codex requires subscription authentication');
  }
 }
 return v as unknown as RuntimeInput;
}
export function providerArgs(provider:Provider,instructions:string,paths:ProviderPaths):string[] {
 if(provider==='codex'){
  const denied=[...new Set(['/runtime','/proc',paths.home+'/.codex/auth.json',paths.privateDir])].map(path=>`${JSON.stringify(path)}="deny"`).join(',');
  return ['-a','never','-c','cli_auth_credentials_store="file"','-c','default_permissions="hivemind"','-c',`permissions.hivemind={extends=":workspace",filesystem={${denied}}}`,'-c','agents.enabled=true','-c','agents.max_concurrent_threads_per_session=3','-c','mcp_servers.phase0.command="node"','-c',`mcp_servers.phase0.args=[${JSON.stringify(paths.scriptRoot+'/mcp-server.ts')}]`,'-c','mcp_servers.phase0.required=true','exec','--json','--skip-git-repo-check',instructions];
 }
 return ['-p','--restricted','--output-format','stream-json','--verbose','--settings',paths.privateDir+'/settings.json','--strict-mcp-config','--mcp-config',paths.privateDir+'/mcp.json','--permission-mode','dontAsk','--permission-prompts','none','--tools','Bash,Agent','--allowedTools','Bash,Agent,mcp__phase0__phase0_probe','--disallowedTools','Write,Edit,NotebookEdit','--disable-slash-commands','--forward-subagent-text','--include-hook-events','--agents',JSON.stringify({worker:{description:'Perform an independent coding task in the workspace.',prompt:'Use sandboxed Bash only. Do not inspect credentials, private runtime state or environment secrets.',tools:['Bash']}}),'--',instructions];
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
export function parseProviderResult(provider:Provider,process:ProcessResult):{success:boolean;summary:string;sessionId?:string;usage?:Record<string,number>;errorCode?:'NEEDS_REAUTH';mcpReceipts:McpReceipt[]} {
 const events=records(process.stdout),errorCode=authFailure(provider,events,process)?'NEEDS_REAUTH' as const:undefined,receipts=mcpReceipts(provider,events);let summary='',sessionId:string|undefined,usage:Record<string,number>|undefined;
 if(provider==='codex'){
  for(const e of events){if(e.type==='thread.started'&&typeof e.thread_id==='string')sessionId=e.thread_id;if(e.type==='item.completed'&&e.item?.type==='agent_message'&&typeof e.item.text==='string')summary=e.item.text;}
  const final=events.filter(e=>e.type==='turn.completed').at(-1);if(object(final?.usage))usage=Object.fromEntries(Object.entries(final!.usage).filter(([,v])=>typeof v==='number'&&Number.isSafeInteger(v)&&Number(v)>=0)) as Record<string,number>;
  return {success:!errorCode&&process.status==='passed'&&!process.truncated&&Boolean(final)&&!events.some(e=>['error','turn.failed'].includes(e.type)),summary,sessionId,usage,errorCode,mcpReceipts:receipts};
 }
 const finals=events.filter(e=>e.type==='result'),final=finals.at(-1);
 if(typeof final?.result==='string')summary=final.result;else if(Array.isArray(final?.errors))summary=final.errors.filter((x:unknown)=>typeof x==='string').join('\n');
 if(typeof final?.session_id==='string')sessionId=final.session_id;
 if(object(final?.usage))usage=Object.fromEntries(Object.entries(final!.usage).filter(([,v])=>typeof v==='number'&&Number.isSafeInteger(v)&&Number(v)>=0)) as Record<string,number>;
 return {success:!errorCode&&process.status==='passed'&&!process.truncated&&finals.length===1&&events.at(-1)===final&&final?.subtype==='success'&&final?.is_error===false&&typeof final?.result==='string'&&final?.stop_reason!=='refusal'&&(final?.permission_denials===undefined||(Array.isArray(final.permission_denials)&&final.permission_denials.length===0)),summary,sessionId,usage,errorCode,mcpReceipts:receipts};
}
