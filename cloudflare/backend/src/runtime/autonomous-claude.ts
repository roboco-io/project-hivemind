import {createAutonomousActionMcpConfig,ACTION_MODEL_TOOL_NAME} from './autonomous-action-mcp.ts';
import type {NativeClaudeRequest,NativeClaudeResponse} from '../../../../packages/contracts/src/autonomous-native.ts';
import {mkdir,open,lstat,readFile,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readRuntimeBoundary,type RuntimeBoundary} from './run.ts';
import {providerArgs,claudeSettings,buildEnv,parseProviderResult} from './providers.ts';
import {parseClaudeQuota} from './autonomous-quota.ts';
import {runProcess} from './process.ts';
import {restoreSnapshot} from '../files.ts';
import {validateSnapshot} from '../snapshot.ts';
import {claudeGuardHome} from './claude-guard-policy.ts';
import {validateAutonomousPolicy,loadAutonomousPolicy} from './autonomous-tool-hook.ts';
import {sessionUUID,collectAutonomousSession,restoreAutonomousSession,rejectSessionSecrets} from './autonomous-session.ts';
import {nativeAuthorizerFromEnvironment,nativeExecutionLease,guardCanonicalNativePolicy,type NativeAuthorizer} from './autonomous-authorize.ts';
import {nativeReporterFromEnvironment,type NativeReporter} from './autonomous-reporter.ts';
import {foldToolAuditSpool} from './tool-audit-spool.ts';
import {shipToolAudit,ToolAuditSequenceError} from './tool-audit-reporter.ts';
export interface AutonomousClaudeOptions {
 /** Trusted account configuration; never task-controlled. Strict by default. */
 nestedCompatible?:boolean;
 /** Trusted server opt-in only; requires an explicitly capable reporter. Default false. */
 quotaPauseEnabled?:boolean;
 /** Trusted container egress gate, never accepted in NativeClaudeRequest. */
 allowWebFetch?:boolean;
 /** Trusted bootstrap channel. No provider credential is passed to the sidecar. */
 actionChannel?:{origin:string;workerToken:string};
 reporter?:NativeReporter;
 /** Worker-side tool audit shipping (reporter route). Defaults to HIVEMIND_CONTROL_API_URL and HIVEMIND_NATIVE_REPORTER_TOKEN; none configured means no shipping. */
 toolAudit?:{url:string;token:string;fetchImpl?:typeof fetch};
 /** Trusted in-process secret values for injected reporters; never wire input. */
 reporterSecrets?:readonly string[];
 authorizer?:NativeAuthorizer;runtimeId?:string;
 home?:string;workspace?:string;scriptRoot?:string;signal?:AbortSignal;
 boundaryCheck?:()=>Promise<RuntimeBoundary>;runProcess?:typeof runProcess;
 /** Trusted synthetic test seam, never accepted from wire input. */
 verifyPrerequisites?:()=>Promise<void>;
}
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(Error('Native report aborted'));
  signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });
}
const managedPath='/etc/claude-code/managed-settings.json';
export interface PrerequisiteFiles {
 lstat:(path:string)=>Promise<{isSymbolicLink():boolean;uid:number;mode:number}>;
 realpath:(path:string)=>Promise<string>;readFile:(path:string)=>Promise<string>;
}
/** Trusted filesystem seam for packaging tests. Production always uses the real filesystem. */
export async function verifyAutonomousPrerequisiteFiles(files:PrerequisiteFiles={lstat,realpath,readFile:p=>readFile(p,'utf8')}):Promise<void>{
 const immutable=async(path:string)=>{let current=path;while(current!=='/'){const s=await files.lstat(current);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error('Managed runtime unavailable');current=dirname(current);}};
 const manifestPath='/opt/hivemind/backend/runtime-build.json';
 for(const p of [managedPath,manifestPath,'/opt/hivemind/backend/src/runtime/claude-bash-hook.ts','/opt/hivemind/backend/src/runtime/autonomous-tool-hook.ts','/opt/hivemind/backend/src/runtime/tool-audit-hook.ts','/opt/hivemind/backend/src/runtime/claude-command-guard.ts','/opt/hivemind/compat-bin/bwrap','/opt/hivemind/bin/namespace-guard','/opt/hivemind/bin/proc-guard'])await immutable(p);
 for(const [name,root] of [['claude','/usr/local/lib/node_modules/@anthropic-ai/claude-code/'],['codex','/usr/local/lib/node_modules/@openai/codex/']]){
  const path='/usr/local/bin/'+name,info=await files.lstat(path);if(info.uid!==0)throw Error('Executable unavailable');await immutable(dirname(path));const resolved=await files.realpath(path);if(!resolved.startsWith(root!))throw Error('Unexpected executable target');await immutable(resolved);if(((await files.lstat(resolved)).mode&0o111)===0)throw Error('Executable unavailable');
 }
 const bytes=await files.readFile(managedPath),managed=JSON.parse(bytes),manifest=JSON.parse(await files.readFile(manifestPath));
 if(createHash('sha256').update(bytes).digest('hex')!==manifest.files?.['backend/config/claude-managed-settings.json']||managed.sandbox?.enabled!==true||managed.sandbox?.failIfUnavailable!==true||managed.sandbox?.allowUnsandboxedCommands!==false||!isDeepStrictEqual(managed.sandbox?.network?.allowedDomains,[])||managed.allowManagedHooksOnly!==true||managed.disableAllHooks!==false)throw Error('Managed runtime unavailable');
 for(const [matcher,command] of [['^Bash$','/usr/local/bin/node /opt/hivemind/backend/src/runtime/claude-bash-hook.ts'],['^Agent$','/usr/local/bin/node /opt/hivemind/backend/src/runtime/autonomous-tool-hook.ts'],['^WebFetch$','/usr/local/bin/node /opt/hivemind/backend/src/runtime/autonomous-tool-hook.ts'],['^mcp__hivemind__action$','/usr/local/bin/node /opt/hivemind/backend/src/runtime/autonomous-tool-hook.ts']]){const hook=managed.hooks?.PreToolUse?.find((x:{matcher:string})=>x.matcher===matcher);if(!hook||hook.hooks?.length!==1||hook.hooks[0].command!==command||hook.hooks[0].type!=='command'||hook.hooks[0].onFailure!=='block')throw Error('Managed hook unavailable');}
 // Worker-side tool audit: the Pre hook fails closed; Post hooks must never block a tool.
 const audit='/usr/local/bin/node /opt/hivemind/backend/src/runtime/tool-audit-hook.ts ';
 for(const [event,block] of [['PreToolUse',true],['PostToolUse',false],['PostToolUseFailure',false]] as const){
  const hook=managed.hooks?.[event]?.find((x:{matcher:string})=>x.matcher==='.*');
  if(!hook||hook.hooks?.length!==1||hook.hooks[0].command!==audit+event||hook.hooks[0].type!=='command'||(block?hook.hooks[0].onFailure!=='block':hook.hooks[0].onFailure!==undefined))throw Error('Managed hook unavailable');
 }
}
async function verifyPrerequisites():Promise<void>{if(process.getuid?.()!==1000)throw Error('Container user required');await verifyAutonomousPrerequisiteFiles();}
async function privateWrite(path:string,value:unknown,mode=0o400):Promise<void>{const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);try{await f.writeFile(JSON.stringify(value));}finally{await f.close();}}
function validateRequest(r:NativeClaudeRequest):void{
 if(!r||Object.keys(r).some(k=>!['version','taskId','model','subagentModel','tools','goal','session','subscriptionAuth','maxRunMs','initialSnapshot','executionLease','web','externalProfiles'].includes(k))||r.version!==1||typeof r.taskId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(r.taskId)||typeof r.goal!=='string'||!r.goal||r.goal.length>24000||r.goal.includes('\0')||typeof r.subscriptionAuth!=='string'||!/^sk-ant-oat01-[A-Za-z0-9_-]{8,262100}$/.test(r.subscriptionAuth)||!Number.isSafeInteger(r.maxRunMs)||r.maxRunMs<1||r.maxRunMs>3600000||!r.session||Object.keys(r.session).sort().join(',')!=='data,model,sequence,sessionId'||!sessionUUID(r.session.sessionId)||r.session.model!==r.model||!Number.isSafeInteger(r.session.sequence)||r.session.sequence<0)throw Error('Invalid native request');
 validateAutonomousPolicy({version:1,tools:r.tools,model:r.model,subagentModel:r.subagentModel??r.model,...(r.web?{web:r.web}:{}),...(r.externalProfiles?{externalProfiles:r.externalProfiles}:{})});
}
/**
 * Ships the append-only hook spool through the reporter route. The server ignores later updates to a sequence it already
 * holds, so records still `allowed` with unknown duration wait for a later flush, and every record behind them waits too
 * (sequences must stay contiguous). The final flush sends everything. The spool is never truncated or rewritten.
 * Transport failures are swallowed: audit is a worker report and must not fail a paid iteration.
 */
function createToolAuditFlusher(config:{url:string;token:string;fetchImpl?:typeof fetch}|undefined,spoolPath:string,currentLease:()=>AutonomousClaudeLease,signal:AbortSignal){
 let shippedThrough=0,droppedShipped=0,busy:Promise<void>=Promise.resolve();
 async function once(final:boolean):Promise<void>{
  if(!config)return;
  let raw:string;try{raw=await readFile(spoolPath,'utf8');}catch{return;}
  const folded=foldToolAuditSpool(raw);
  for(let attempt=0;attempt<2;attempt++){
   const pending=(r:{outcome:string;durationMs:number|null})=>r.outcome==='allowed'&&r.durationMs===null;
   let ready=folded.records.filter(r=>r.sequence>shippedThrough);
   if(!final){const hold=ready.findIndex(pending);if(hold>=0)ready=ready.slice(0,hold);}
   if(!ready.length&&folded.droppedByWorker===droppedShipped)return;
   try{
    await shipToolAudit({lease:currentLease(),url:config.url,token:config.token,records:ready,droppedByWorker:folded.droppedByWorker,fetchImpl:config.fetchImpl,signal});
    if(ready.length)shippedThrough=ready.at(-1)!.sequence;droppedShipped=folded.droppedByWorker;return;
   }catch(error){
    // The server states the next sequence it expects; resynchronize once, never guess further.
    if(error instanceof ToolAuditSequenceError&&attempt===0&&error.expectedSequence>=1){shippedThrough=error.expectedSequence-1;continue;}
    return;
   }
  }
 }
 return {flush:(final:boolean)=>{busy=busy.then(()=>once(final),()=>once(final));return busy;}};
}
type AutonomousClaudeLease=Parameters<NativeReporter['ready']>[0];
/** One iteration per fresh container. Private files remain until the caller durably saves the returned bundle. */
export async function executeAutonomousClaude(request:NativeClaudeRequest,options:AutonomousClaudeOptions={}):Promise<NativeClaudeResponse>{
 let heartbeatTimer:ReturnType<typeof setInterval>|undefined,pendingHeartbeat:Promise<void>|undefined,auditFlusher:ReturnType<typeof createToolAuditFlusher>|undefined;const lifecycle=new AbortController();
 try{
  validateRequest(request);let lease=nativeExecutionLease(request);const authorizer=options.authorizer??nativeAuthorizerFromEnvironment(),runtimeId=options.runtimeId??randomUUID();const startupSignal=options.signal??lifecycle.signal;
  startupSignal.throwIfAborted();
  const approved=guardCanonicalNativePolicy(request,await abortable(authorizer.start(request,runtimeId,startupSignal),startupSignal));
  if(request.web&&options.allowWebFetch!==true)throw Error('WebFetch egress unavailable');
  if(request.externalProfiles&&!options.actionChannel)throw Error('Action channel unavailable');
  const remaining=Math.min(request.maxRunMs,approved.spec.endsAt-Date.now(),approved.deadline-Date.now());if(remaining<1)throw Error('Native deadline expired');
  const signal=AbortSignal.any([lifecycle.signal,...(options.signal?[options.signal]:[]),AbortSignal.timeout(remaining)]);
  heartbeatTimer=setInterval(()=>{if(pendingHeartbeat||signal.aborted)return;pendingHeartbeat=(async()=>{try{lease=await abortable(authorizer.heartbeat(lease,signal),signal);void auditFlusher?.flush(false);}catch{lifecycle.abort();}finally{pendingHeartbeat=undefined;}})();},5000);heartbeatTimer.unref();
  const billing=approved.spec.billingPolicy;
  if(billing!==undefined&&(!billing||typeof billing!=='object'||Object.keys(billing).sort().join(',')!=='budget,model'||billing.model!=='subscription'||billing.budget!=='external_actions'))throw Error('Native billing policy unavailable');
  const reporter=approved.spec.billingPolicy?.model==='subscription'?(options.reporter??nativeReporterFromEnvironment()):undefined;
  if(reporter){await abortable(reporter.ready(lease,runtimeId,signal),signal);signal.throwIfAborted();}
  const auditConfig=options.toolAudit??(process.env.HIVEMIND_CONTROL_API_URL&&process.env.HIVEMIND_NATIVE_REPORTER_TOKEN?{url:process.env.HIVEMIND_CONTROL_API_URL,token:process.env.HIVEMIND_NATIVE_REPORTER_TOKEN}:undefined);
  const secrets=[request.subscriptionAuth,...(auditConfig?[auditConfig.token]:[]),...(options.actionChannel?[options.actionChannel.workerToken]:[]),...(reporter?[process.env.HIVEMIND_NATIVE_REPORTER_TOKEN,process.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN,process.env.HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN,...(options.reporterSecrets??[])].filter((value):value is string=>typeof value==='string'&&value.length>0):[])];
  const boundary=await abortable((options.boundaryCheck??readRuntimeBoundary)(),signal);
  if(!boundary.verified||boundary.platform!=='linux'||boundary.noNewPrivs!==1||!['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(k=>/^0+$/.test(boundary.capabilities[k]??'')))throw Error('Runtime boundary unavailable');
  await abortable((options.verifyPrerequisites??verifyPrerequisites)(),signal);signal.throwIfAborted();
  const home=options.home??'/home/node',workspace=options.workspace??'/workspace';
  // Physical path overrides are restricted to trusted synthetic runtimes.
  if((options.home||options.workspace||options.scriptRoot)&&(!options.runProcess||!options.boundaryCheck||!options.verifyPrerequisites))throw Error('Native paths are fixed');
  const paths={home,workspace,privateDir:join(home,'.hivemind-phase0'),scriptRoot:options.scriptRoot??'/opt/hivemind/scripts/phase0'};
  await mkdir(paths.privateDir,{recursive:true,mode:0o700});const privateInfo=await lstat(paths.privateDir);if(!privateInfo.isDirectory()||privateInfo.isSymbolicLink()||(privateInfo.mode&0o077))throw Error('Unsafe private runtime');
  const policy={version:1 as const,tools:request.tools,model:request.model,subagentModel:request.subagentModel??request.model,...(request.web?{web:request.web}:{}),...(request.externalProfiles?{externalProfiles:request.externalProfiles}:{})};
  // The hook (running as the same user) appends here; TOOL_AUDIT_SPOOL is this path under the fixed production home.
  auditFlusher=createToolAuditFlusher(auditConfig,join(paths.privateDir,'tool-audit.jsonl'),()=>lease,signal);
  await privateWrite(join(paths.privateDir,'autonomous-policy.json'),policy);
  if(!isDeepStrictEqual(await loadAutonomousPolicy(join(paths.privateDir,'autonomous-policy.json')),policy))throw Error('Policy unavailable');
  const guard=claudeGuardHome(paths);await mkdir(guard,{mode:0o700});
  const guardInfo=await lstat(guard);if(!guardInfo.isDirectory()||guardInfo.isSymbolicLink()||(guardInfo.mode&0o777)!==0o700)throw Error('Guard unavailable');
  const settings=claudeSettings(paths,options.nestedCompatible===true);await privateWrite(join(paths.privateDir,'settings.json'),settings);
  let mcp:object={mcpServers:{}};
  if(request.externalProfiles){
   const channel=options.actionChannel!,origin=new URL(channel.origin);
   if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!channel.workerToken||channel.workerToken.length>4096||/[\s\p{Cc}]/u.test(channel.workerToken)||[request.subscriptionAuth,lease.token].includes(channel.workerToken))throw Error('Invalid action channel');
   const privateInputPath=join(paths.privateDir,'action-input.json');
   await privateWrite(privateInputPath,{version:1,runtimeId,executionDeadline:approved.deadline,request:{taskId:request.taskId,executionLease:lease,maxRunMs:request.maxRunMs,externalProfiles:request.externalProfiles},control:{origin:origin.origin,workerToken:channel.workerToken}},0o600);
   mcp=createAutonomousActionMcpConfig({command:'/usr/local/bin/node',args:['/opt/hivemind/backend/src/runtime/autonomous-action-mcp.ts'],privateInputPath});
  }
  await privateWrite(join(paths.privateDir,'mcp.json'),mcp);
  const resumed=request.session.sequence>0;
  if(resumed){if(request.initialSnapshot!==undefined)throw Error('Unexpected initial snapshot');await restoreAutonomousSession(request.session.data,paths,request.session.sessionId,request.model,secrets);}
  else{if(request.session.data!==null||!request.initialSnapshot)throw Error('Initial snapshot required');const snapshot=validateSnapshot(request.initialSnapshot);for(const f of snapshot.files)rejectSessionSecrets(Buffer.from(f.content,'base64'),secrets);await restoreSnapshot(workspace,snapshot);}
  const prompt='Work only in /workspace. Do not inspect secrets or change policy. Finish all worker subagents before returning. Return only strict JSON: {"outcome":"continue|complete|wait|input|failed","wakeAt":<epoch milliseconds only for wait>}.\n'+request.goal;
  const args=providerArgs('claude',prompt,paths,resumed?request.session.sessionId:undefined);
  const set=(flag:string,value:string)=>{const index=args.indexOf(flag);if(index<0||args.lastIndexOf(flag)!==index)throw Error('Provider contract changed');args[index+1]=value;};
  set('--tools',request.tools.filter(tool=>tool!==ACTION_MODEL_TOOL_NAME).join(','));set('--allowedTools',request.tools.join(','));
  set('--agents',JSON.stringify(request.tools.includes('Agent')?{worker:{description:'Perform approved work.',prompt:'Use only sandboxed Bash. Finish before returning.',tools:['Bash'],model:policy.subagentModel}}:{}));
  args.unshift('--model',request.model,'--setting-sources=');if(!resumed)args.unshift('--session-id',request.session.sessionId);
  signal.throwIfAborted();const cliTimeout=Math.min(request.maxRunMs,approved.deadline-Date.now(),approved.spec.endsAt-Date.now());if(cliTimeout<1)throw Error('Native deadline expired');
  const processResult=await(options.runProcess??runProcess)(['/usr/local/bin/claude',...args],{cwd:workspace,env:buildEnv({PATH:'/usr/local/bin:/usr/bin:/bin',...(process.env.SSL_CERT_FILE?{SSL_CERT_FILE:process.env.SSL_CERT_FILE}:{}),...(process.env.NODE_EXTRA_CA_CERTS?{NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS}:{})},home,'claude',request.subscriptionAuth),timeoutMs:cliTimeout,signal,maxBytes:4*1024*1024});
  signal.throwIfAborted();const parsed=parseProviderResult('claude',processResult);
  const quotaObservedAt=Date.now();
  const quota=options.quotaPauseEnabled===true?parseClaudeQuota(processResult.stdout,request.session.sessionId,quotaObservedAt,approved.spec.endsAt):undefined;
  if(quota) {
    if(!reporter||reporter.quotaPauseEnabled!==true||processResult.truncated||processResult.terminationReason!=='exit'||processResult.signal!=null||!['passed','failed'].includes(processResult.status)||![0,1].includes(processResult.exitCode!)||parsed.errorCode||parsed.permissionDenialCount||parsed.failureReasons.includes('CLAUDE_REFUSAL'))throw Error('Quota pause unavailable');
    const rows=processResult.stdout.trimEnd().split('\n').map(s=>JSON.parse(s));
    const init=rows.filter(x=>x.type==='system'&&x.subtype==='init');
    if(!init.length||init.some(x=>x.model!==request.model||x.session_id!==request.session.sessionId||x.parent_tool_use_id!=null))throw Error('Native model mismatch');
    const results=rows.filter(x=>x.type==='result');if(results.length>1)throw Error('Ambiguous quota terminal result');
    const terminal=results[0];
    if(terminal&&(terminal.session_id!==request.session.sessionId||terminal.parent_tool_use_id!=null||terminal.is_error!==true&&!parsed.success))throw Error('Invalid quota result');
    const u=terminal?.usage,keys=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'];
    const measured=!!terminal&&u&&keys.every(k=>Number.isSafeInteger(u[k])&&u[k]>=0);
    if(terminal&&!measured)throw Error('Invalid quota result usage');
    const usage=measured?{inputTokens:u.input_tokens,cacheReadTokens:u.cache_read_input_tokens,cacheWriteTokens:u.cache_creation_input_tokens,outputTokens:u.output_tokens}:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};
    const data=await collectAutonomousSession(paths,request.session.sessionId,request.model,secrets);
    if(!data.transcripts.some(t=>t.path===request.session.sessionId+'.jsonl'&&t.content.trim().length>0))throw Error('Actual transcript unavailable');
    if(pendingHeartbeat)await pendingHeartbeat;signal.throwIfAborted();await auditFlusher.flush(true);
    // The parser proved future-at-observation; collection latency cannot invent a new reset.
    if(quota.resetsAt<=quotaObservedAt||quota.resetsAt>=approved.spec.endsAt)throw Error('Quota observation invalid');
    const pause={quota,...(!measured?{usageUnavailable:true as const}:{}),outcome:'wait' as const,wakeAt:quota.resetsAt};
    await abortable(reporter.record(lease,{runId:lease.runId,runtimeId,sessionId:request.session.sessionId,model:request.model,sequence:request.session.sequence+1,usage,...pause,stopped:true},signal),signal);
    if(pendingHeartbeat)await pendingHeartbeat;signal.throwIfAborted();
    // Reporter acknowledgement remains mandatory even when the original reset has elapsed.
    if(quota.resetsAt<=quotaObservedAt||quota.resetsAt>=approved.spec.endsAt)throw Error('Quota observation invalid after report');
    return {version:1,session:{sessionId:request.session.sessionId,model:request.model,sequence:request.session.sequence+1,data},usage,...pause,boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
  }
  if(!parsed.success||parsed.sessionId!==request.session.sessionId||Buffer.byteLength(parsed.summary)>4096)throw Error('Native execution failed');
  const rows=processResult.stdout.trim().split(/\r?\n/).map(s=>JSON.parse(s));const init=rows.filter(x=>x.type==='system'&&x.subtype==='init');if(init.length===0||init.some(x=>x.model!==request.model||x.session_id!==request.session.sessionId||x.parent_tool_use_id!=null))throw Error('Native model mismatch');const result=rows.filter(x=>x.type==='result').at(-1),u=result?.usage;
  const keys=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'];if(!u||!keys.every(k=>Number.isSafeInteger(u[k])&&u[k]>=0))throw Error('Usage unavailable');
  const outcome=JSON.parse(parsed.summary);if(!outcome||Object.keys(outcome).some(k=>!['outcome','wakeAt'].includes(k))||!['continue','complete','wait','input','failed'].includes(outcome.outcome)||(outcome.outcome==='wait'? !Number.isSafeInteger(outcome.wakeAt)||outcome.wakeAt<=Date.now():outcome.wakeAt!==undefined))throw Error('Invalid outcome');
  const data=await collectAutonomousSession(paths,request.session.sessionId,request.model,secrets);
  if(pendingHeartbeat)await pendingHeartbeat;signal.throwIfAborted();await auditFlusher.flush(true);
  const usage={inputTokens:u.input_tokens,cacheReadTokens:u.cache_read_input_tokens,cacheWriteTokens:u.cache_creation_input_tokens,outputTokens:u.output_tokens};
  if(reporter){await abortable(reporter.record(lease,{runId:lease.runId,runtimeId,sessionId:request.session.sessionId,model:request.model,sequence:request.session.sequence+1,usage,outcome:outcome.outcome,...(outcome.wakeAt!==undefined?{wakeAt:outcome.wakeAt}:{}),stopped:true},signal),signal);if(pendingHeartbeat)await pendingHeartbeat;signal.throwIfAborted();}
  return {version:1,session:{sessionId:request.session.sessionId,model:request.model,sequence:request.session.sequence+1,data},usage:{inputTokens:u.input_tokens,cacheReadTokens:u.cache_read_input_tokens,cacheWriteTokens:u.cache_creation_input_tokens,outputTokens:u.output_tokens},outcome:outcome.outcome,...(outcome.wakeAt!==undefined?{wakeAt:outcome.wakeAt}:{}),boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 }catch{throw Error('Native Claude iteration refused or failed');}finally{if(heartbeatTimer)clearInterval(heartbeatTimer);lifecycle.abort();if(pendingHeartbeat)await pendingHeartbeat;}
}
