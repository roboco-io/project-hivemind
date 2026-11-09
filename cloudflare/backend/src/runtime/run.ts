import {mkdir,readFile,writeFile,open,rename,readdir,stat,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {RuntimeInput,RuntimeResult,ProcessResult,SourceFile} from '../contracts.ts';
import {validateSnapshot} from '../snapshot.ts';
import {readSnapshot,restoreSnapshot} from '../files.ts';
import {validateRuntimeInput,providerArgs,claudeSettings,buildEnv,parseProviderResult,type ProviderPaths} from './providers.ts';
import {runProcess} from './process.ts';
import {computeSandboxArgs} from './compute-sandbox.ts';
import {claudeGuardHome} from './claude-guard-policy.ts';
import {sealAuth,redactKnownTokens} from '../../../scripts/phase0/auth-envelope.ts';
import {MAX_HOOK_BYTES,parseSandboxReceipts,type SandboxReceipt} from './claude-bash-hook.ts';
export interface RuntimeOptions {
 runtimeDir?:string;workspace?:string;home?:string;scriptRoot?:string;
 commands?:{codex?:string;claude?:string};computePrefix?:string[];
 boundaryCheck?:()=>Promise<RuntimeBoundary>;
}
export interface RuntimeBoundary {platform:string;checkedAt:string;capabilities:Record<string,string>;noNewPrivs:number;verified:boolean}
const capabilityNames=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'];
export function checkRuntimeBoundary(status:string,platform:string):RuntimeBoundary {
 const capabilities:Record<string,string>={};let noNewPrivs=-1,unique=true;
 for(const name of [...capabilityNames,'NoNewPrivs']){
  const matches=status.split(/\r?\n/).filter(line=>line.startsWith(name+':'));
  if(matches.length!==1){unique=false;continue;}
  const value=matches[0]!.slice(name.length+1).trim();
  if(name==='NoNewPrivs')noNewPrivs=value==='1'?1:value==='0'?0:-1;
  else capabilities[name]=value;
 }
 return {platform,checkedAt:new Date().toISOString(),capabilities,noNewPrivs,verified:platform==='linux'&&unique&&noNewPrivs===1&&capabilityNames.every(name=>/^0+$/.test(capabilities[name]??''))};
}
export async function readRuntimeBoundary():Promise<RuntimeBoundary> {
 return checkRuntimeBoundary(process.platform==='linux'?await readFile('/proc/self/status','utf8').catch(()=>''):'',process.platform);
}
const notRun=():ProcessResult=>({status:'not_run',exitCode:null,stdout:'',stderr:'',durationMs:0,truncated:false});
const has=(path:string)=>stat(path).then(()=>true,()=>false);
function cleanText(text:string,auth:string|undefined,latest?:string):string {
 let original:unknown,refreshed:unknown;try{original=JSON.parse(auth??'');}catch{}
 try{refreshed=JSON.parse(latest??'');}catch{}
 let clean=redactKnownTokens(text,original,refreshed);
 for(const secret of [auth,latest].filter((s):s is string=>Boolean(s)).sort((a,b)=>b.length-a.length))clean=clean.replaceAll(secret,'[REDACTED]');
 return clean;
}
function snapshotContainsAuth(snapshot:RuntimeInput['snapshot'],...auth:Array<string|undefined>):boolean {
 const secrets=new Set<string>();
 for(const value of auth){if(!value)continue;secrets.add(value);try{const parsed=JSON.parse(value);for(const token of Object.values(parsed.tokens??{}))if(typeof token==='string'&&token.length>=12)secrets.add(token);}catch{}}
 return snapshot.files.some(file=>{const bytes=Buffer.from(file.content,'base64');return [...secrets].some(secret=>bytes.includes(Buffer.from(secret)));});
}
async function receipts(provider:'codex'|'claude',paths:ProviderPaths):Promise<unknown[]> {
 if(provider==='claude'){
  const {claudeAgentReceipt}=await import('../../../scripts/phase0/claude-receipts.ts');
  return (await readFile(join(paths.privateDir,'claude-agents.jsonl'),'utf8').catch(()=>'' )).split(/\r?\n/).filter(Boolean).slice(0,64).flatMap(line=>{try{const r=JSON.parse(line);const checked=claudeAgentReceipt({hook_event_name:r.event,session_id:r.sessionId,agent_id:r.agentId,agent_type:r.agentType},r.timestamp);return checked?[checked]:[];}catch{return [];}});
 }
 const {readNativeThreads}=await import('../../../scripts/phase0/native-thread-receipts.ts');
 const {summarizeRollout}=await import('../../../scripts/phase0/rollout-receipts.ts');
 const root=join(paths.home,'.codex');const databases=(await readdir(root).catch(()=>[])).filter(x=>/^state_\d+\.sqlite$/.test(x)).sort();
 const native=databases.length?readNativeThreads(join(root,databases.at(-1)!)):[];
 const sessionRoot=join(root,'sessions');const files=(await readdir(sessionRoot,{recursive:true}).catch(()=>[])).filter(x=>x.endsWith('.jsonl')).slice(0,16);
 const output:unknown[]=[];
 for(const file of files){const summary=summarizeRollout(await readFile(join(sessionRoot,file),'utf8'));const basename=file.split('/').at(-1);const identity=native.find(x=>x.rolloutFile===basename);output.push({...summary,rolloutFile:basename,storageThreadId:identity?.threadId??null,storageSource:identity?.source??null});}
 return output;
}
const sourceEqual=(files:SourceFile[],actual:SourceFile[])=>files.length===actual.length&&files.every(f=>actual.some(v=>v.path===f.path&&v.sha256===f.sha256&&v.executable===f.executable));
async function sandboxAudit(path:string):Promise<SandboxReceipt[]> {
 const file=await open(path,'r');try{
  const info=await file.stat();if(!info.isFile()||info.size>MAX_HOOK_BYTES)throw new Error('Invalid sandbox audit metadata');
  const chunks:Buffer[]=[];let bytes=0;
  while(true){const chunk=Buffer.alloc(16384),part=await file.read(chunk,0,chunk.length,null);if(!part.bytesRead)break;bytes+=part.bytesRead;if(bytes>MAX_HOOK_BYTES)throw new Error('Invalid sandbox audit metadata');chunks.push(chunk.subarray(0,part.bytesRead));}
  return parseSandboxReceipts(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }finally{await file.close();}
}
export async function executeRuntime(raw:unknown,options:RuntimeOptions={}):Promise<RuntimeResult> {
 const input=validateRuntimeInput(raw);input.snapshot=validateSnapshot(input.snapshot);
 const runtimeDir=options.runtimeDir??'/runtime',workspace=options.workspace??'/workspace',home=options.home??'/home/node';
 const paths:ProviderPaths={home,privateDir:join(home,'.hivemind-phase0'),workspace,scriptRoot:options.scriptRoot??'/opt/hivemind/scripts/phase0'};
 await mkdir(runtimeDir,{recursive:true,mode:0o700});await mkdir(home,{recursive:true,mode:0o700});
 const controller=new AbortController();let timer:ReturnType<typeof setInterval>|undefined;
 const result:RuntimeResult&{boundary?:RuntimeBoundary}={version:1,jobId:input.jobId,attempt:input.attempt,inputSnapshotId:input.snapshot.digest,process:notRun(),summary:'Execution did not start',sourceUnchanged:true,sandboxPolicy:input.mode==='compute'?'compute-workspace':input.provider==='codex'?'codex-workspace':input.claudeNestedCompatible?'claude-nested-compatible':'claude-strict',...(input.provider?{provider:input.provider}:{})};
 let latestAuth=input.auth,codexAuthWritten=false,materialized=false,providerFailureDiagnostic:string|undefined;
 try {
  if(options.boundaryCheck){result.boundary=await options.boundaryCheck();if(!result.boundary.verified)throw new Error('Linux capability boundary failed');}
  await restoreSnapshot(workspace,input.snapshot);materialized=true;
  if(input.mode==='agent'&&snapshotContainsAuth(input.snapshot,input.auth))throw new Error('Input source contains authentication material');
  if(await has(join(runtimeDir,'cancel')))controller.abort();
  timer=setInterval(()=>{void has(join(runtimeDir,'cancel')).then(cancel=>{if(cancel)controller.abort();});},100);timer.unref();
  if(input.mode==='compute'){
   const forbidden=['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLOUDFLARE_API_TOKEN','CF_API_TOKEN','PROBE_TOKEN','AUTH_WRAP_KEY'];
   const isolatedHome=join(runtimeDir,'compute-home');await mkdir(isolatedHome,{recursive:true,mode:0o700});
   const env=buildEnv(process.env,isolatedHome);
   result.credentialsAbsent=forbidden.every(k=>!env[k])&&!await has(join(home,'.codex','auth.json'))&&!await has(join(home,'.claude','.credentials.json'));
   if(!result.credentialsAbsent)throw new Error('Compute credential boundary failed');
   const prefix=options.computePrefix??computeSandboxArgs();
   result.process=await runProcess([...prefix,...input.argv!],{cwd:workspace,env,timeoutMs:input.timeoutMs,signal:controller.signal,maxBytes:32768,captureDirectory:join(runtimeDir,'compute-output')});
   const current=await readSnapshot(workspace);result.sourceUnchanged=sourceEqual(input.snapshot.files,current.files);
   result.summary=result.sourceUnchanged?'Configured verification finished.':'Verification modified its immutable input source.';
   if(!result.sourceUnchanged&&result.process.status==='passed')result.process={...result.process,status:'error',stderr:result.process.stderr+'\nVerification source integrity failed'};
  }else{
   await mkdir(paths.privateDir,{recursive:true,mode:0o700});
   if(input.provider==='codex'){
    await mkdir(join(home,'.codex'),{recursive:true,mode:0o700});await writeFile(join(home,'.codex','auth.json'),input.auth!,{mode:0o600});codexAuthWritten=true;
   }else{
    const guardHome=claudeGuardHome(paths);await mkdir(guardHome,{recursive:true,mode:0o700});
    const guardInfo=await lstat(guardHome);if(!guardInfo.isDirectory()||(guardInfo.mode&0o777)!==0o700)throw new Error('Guard home must be a private directory');
    const guardAuth=await lstat(join(guardHome,'auth.json')).then(()=>true,error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;});if(guardAuth)throw new Error('Guard home must be credential-free');
    await writeFile(join(paths.privateDir,'claude-agents.jsonl'),'0'.slice(0,0),{mode:0o600});
    await writeFile(join(paths.privateDir,'settings.json'),JSON.stringify(claudeSettings(paths,input.claudeNestedCompatible===true)),{mode:0o600});
    await writeFile(join(paths.privateDir,'mcp.json'),JSON.stringify({mcpServers:{phase0:{command:'node',args:[paths.scriptRoot+'/mcp-server.ts']}}}),{mode:0o600});
   }
   const prompt=`Work only in ${workspace}. Do not inspect authentication files, environment secrets or private runtime state. Do not commit, push, or modify Git metadata. Native worker subagents may divide independent files. The service will run the required final checks after you finish.\n\n${input.instructions}`;
   const processResult=await runProcess([options.commands?.[input.provider!]??input.provider!,...providerArgs(input.provider!,prompt,paths)],{cwd:workspace,env:buildEnv(process.env,home,input.provider,input.auth),timeoutMs:input.timeoutMs,signal:controller.signal,maxBytes:1024*1024});
   const parsed:ReturnType<typeof parseProviderResult>=processResult.truncated?{success:false,summary:'',mcpReceipts:[],failureReasons:['CAPTURE_TRUNCATED']}:parseProviderResult(input.provider!,processResult);
   if(processResult.exitCode===0&&!parsed.success&&!processResult.truncated){
    providerFailureDiagnostic=`HIVEMIND_PROVIDER_RESULT_REJECTED:${parsed.failureReasons.join(',')}`;
    if(parsed.trailingEventKinds?.length)providerFailureDiagnostic+=` TRAILING_EVENT_KINDS:${parsed.trailingEventKinds.join(',')}`;
    if(parsed.permissionDenialCount!==undefined)providerFailureDiagnostic+=` PERMISSION_DENIAL_COUNT:${parsed.permissionDenialCount}`;
    if(parsed.resultCount!==undefined)providerFailureDiagnostic+=` RESULT_COUNT:${parsed.resultCount} RESULT_SHAPES:${JSON.stringify(parsed.resultShapes??[])} RESULT_SHAPES_TRUNCATED:${parsed.resultShapesTruncated===true}`;
   }
   // Keep the bounded capture intact until refreshed authentication is available.
   result.process={...processResult,status:processResult.status==='passed'&&!parsed.success?'error':processResult.status,stdout:parsed.summary,stderr:processResult.stderr};
   result.summary=parsed.summary||`${input.provider} ${result.process.status}`;result.sessionId=parsed.sessionId;result.usage=parsed.usage;result.errorCode=parsed.errorCode;result.mcpReceipts=parsed.mcpReceipts;
   if(input.provider==='codex')latestAuth=await readFile(join(home,'.codex','auth.json'),'utf8');
   result.subagentReceipts=await receipts(input.provider!,paths).catch(()=>[]);
   if(input.provider==='claude')result.sandboxReceipts=await sandboxAudit(join(paths.privateDir,'bash-guards.jsonl')).catch(()=>[]);
   result.snapshot=await readSnapshot(workspace);result.sourceUnchanged=result.snapshot.digest===input.snapshot.digest;
  }
 }catch(error){
  result.process={...result.process,status:'error',exitCode:null,stderr:error instanceof Error?error.message:'Runtime execution failed'};
  result.summary='Runtime execution failed';
  result.sourceUnchanged=false;
  if(input.mode==='agent'&&materialized)result.snapshot=await readSnapshot(workspace).catch(()=>undefined);
 }finally{
  if(timer)clearInterval(timer);
  if(input.mode==='agent'){
   if(input.provider==='codex'&&codexAuthWritten)latestAuth=await readFile(join(home,'.codex','auth.json'),'utf8').catch(()=>undefined);
   try{if(latestAuth){if(input.provider==='codex'){const v=JSON.parse(latestAuth);if(v.auth_mode!=='chatgpt'||!v.tokens?.access_token||!v.tokens?.refresh_token||v.OPENAI_API_KEY)throw new Error('Invalid refreshed subscription');}result.authReturn={...sealAuth(latestAuth,input.authReturnPublicKey!),version:1};}}catch{result.summary='Authentication write-back could not be sealed';result.process.status='error';}
  }
 }
 if(result.snapshot&&snapshotContainsAuth(result.snapshot,input.auth,latestAuth)){delete result.snapshot;result.process.status='error';result.process.stderr='Result source contained authentication material';result.summary='Sensitive output was withheld';}
 if(input.mode==='agent'&&result.process.truncated){result.process.status='error';result.process.stdout='';result.process.stderr='Agent output capture limit exceeded';result.summary='Agent output was withheld because the capture limit was exceeded';}
 const scrub=(text:string)=>cleanText(text,input.auth,latestAuth);
 const scrubValue=(value:unknown):unknown=>typeof value==='string'?scrub(value):Array.isArray(value)?value.map(scrubValue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrubValue(v)])):value;
 if(result.subagentReceipts)result.subagentReceipts=scrubValue(result.subagentReceipts) as unknown[];
 if(result.sandboxReceipts)result.sandboxReceipts=scrubValue(result.sandboxReceipts) as SandboxReceipt[];
 result.summary=scrub(result.summary).slice(0,12000);result.process.stdout=scrub(result.process.stdout).slice(0,16000);
 const safeStderr=scrub(result.process.stderr),diagnostic=providerFailureDiagnostic?scrub(providerFailureDiagnostic):'',separator=safeStderr&&diagnostic?'\n':'';
 result.process.stderr=safeStderr.slice(0,16000-diagnostic.length-separator.length)+separator+diagnostic;
 return result;
}
export async function runFromFile(runtimeDir='/runtime',options:RuntimeOptions={}):Promise<RuntimeResult|null> {
 const input=validateRuntimeInput(JSON.parse(await readFile(join(runtimeDir,'input.json'),'utf8')));
 const started=await open(join(runtimeDir,'started.json'),'wx',0o600).catch(error=>{if((error as NodeJS.ErrnoException).code==='EEXIST')return null;throw error;});
 if(!started)return null;
 try{await started.writeFile(JSON.stringify({jobId:input.jobId,attempt:input.attempt,pid:process.pid,startedAt:new Date().toISOString()}));await started.sync();}finally{await started.close();}
 const result=await executeRuntime(input,{...options,runtimeDir,boundaryCheck:options.boundaryCheck??readRuntimeBoundary});
 const temp=join(runtimeDir,'result.pending.json');await writeFile(temp,JSON.stringify(result),{mode:0o600});await rename(temp,join(runtimeDir,'result.json'));return result;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await runFromFile();
