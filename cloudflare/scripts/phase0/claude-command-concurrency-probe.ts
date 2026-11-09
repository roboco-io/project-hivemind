import {mkdir,writeFile,readFile,readdir,lstat,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {buildEnv} from '../../backend/src/runtime/providers.ts';
import {CLAUDE_GUARD_PATHS,claudeGuardHome,claudeGuardEnvironment,claudeOuterSandboxSettings} from '../../backend/src/runtime/claude-command-guard.ts';
import {bashHookReply,shellQuote,GUARD} from '../../backend/src/runtime/claude-bash-hook.ts';
import {runBounded} from './run-bounded.ts';

const paths=CLAUDE_GUARD_PATHS,settingsFile=paths.privateDir+'/claude-command-concurrency-settings.json';
const causeReceipt='/workspace/claude-nested-bwrap-cause.json',causeStderr='/workspace/claude-nested-bwrap-stderr.log';
const labels=['alpha','beta','serial'] as const;
type Label=typeof labels[number];
const checked=(label:string):Label=>{if(!labels.includes(label as Label))throw new Error('Invalid fixed command label');return label as Label;};
const filename=(label:Label,workspace=paths.workspace)=>join(workspace,'claude-command-'+label+'.txt');
const receiptName=(label:Label,workspace=paths.workspace)=>join(workspace,'claude-command-'+label+'.receipt.json');
const object=(value:unknown):Record<string,any>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
const capNames=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'];
const capZero=(value:unknown)=>!!object(value)&&Object.keys(value as object).length===5&&capNames.every(key=>typeof (value as Record<string,unknown>)[key]==='string'&&/^0+$/.test((value as Record<string,string>)[key]!));
const absent=(path:string)=>lstat(path).then(()=>false,error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;});
const errorCode=(error:unknown)=>{const code=(error as NodeJS.ErrnoException)?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(code)?code:'UNKNOWN';};
export function claudeCommandConcurrencyEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
 return {...claudeGuardEnvironment(buildEnv(source,paths.home),paths),CLAUDE_CODE_OAUTH_TOKEN:'NON_SECRET_CONCURRENCY_FIXTURE',HIVEMIND_GUARD_TRACE:'1'};
}
export async function collectConcurrencyDiagnostics(guardHome=claudeGuardHome(paths),tracePath='/workspace/.hivemind-guard-trace.jsonl'){
 const entries:Array<{name:string;type:string;size:number}>=[],errors:Array<{name:string;error:string}>=[];let truncated=false,authEntriesOmitted=0;
 const walk=async(directory:string,prefix='',depth=0):Promise<void>=>{
  let names:string[];try{names=(await readdir(directory)).sort();}catch(error){errors.push({name:prefix,error:errorCode(error)});return;}
  for(const name of names){
   if(/auth|credential|token|secret/i.test(name)){authEntriesOmitted++;continue;}
   const relative=prefix?prefix+'/'+name:name;
   if(entries.length>=64||relative.length>192){truncated=true;return;}
   try{
    const info=await lstat(join(directory,name));const item={name:relative,type:info.isSymbolicLink()?'symlink':info.isDirectory()?'directory':info.isFile()?'file':'other',size:info.size};
    if(Buffer.byteLength(JSON.stringify([...entries,item]))>8192){truncated=true;return;}entries.push(item);
    if(info.isDirectory()){if(depth<4)await walk(join(directory,name),relative,depth+1);else truncated=true;}
   }catch(error){if(errors.length<16)errors.push({name:relative,error:errorCode(error)});}
  }
 };
 await walk(guardHome);
 const records:Record<string,unknown>[]=[];let bytesRead=0,traceTruncated=false,malformedLines=0,traceError:string|null=null;
 let handle:Awaited<ReturnType<typeof open>>|undefined;
 try{
  handle=await open(tracePath,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
  if(!info.isFile()||info.nlink!==1)throw new Error('Invalid diagnostic file');
  const buffer=Buffer.alloc(Math.min(info.size,8192));const read=await handle.read(buffer,0,buffer.length,0);bytesRead=read.bytesRead;traceTruncated=info.size>8192;
  for(const line of buffer.subarray(0,bytesRead).toString('utf8').split(/\r?\n/).filter(Boolean)){
   if(records.length>=32){traceTruncated=true;break;}
   try{
    const input=object(JSON.parse(line));if(!input||!['node-enter','node-exec','namespace-filter-loaded'].includes(input.stage)||typeof input.timestamp!=='string'||input.timestamp.length!==24||!Number.isFinite(Date.parse(input.timestamp)))throw new Error('Invalid trace record');
    const record:Record<string,unknown>={stage:input.stage,timestamp:input.timestamp};
    for(const key of ['pid','ppid'])if(Number.isSafeInteger(input[key])&&input[key]>=0)record[key]=input[key];
    if(typeof input.cwd==='string'&&input.cwd.startsWith('/')&&input.cwd.length<=512)record.cwd=input.cwd;
    if(['file','socket','pipe','character','other','unknown'].includes(input.stdinKind))record.stdinKind=input.stdinKind;
    if(typeof input.commandHash==='string'&&/^[a-f0-9]{64}$/.test(input.commandHash))record.commandHash=input.commandHash;
    if(typeof input.argv0basename==='string'&&/^[A-Za-z0-9_.-]{1,64}$/.test(input.argv0basename))record.argv0basename=input.argv0basename;
    if(Array.isArray(input.envNames))record.envNames=input.envNames.filter((name:unknown)=>typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,95}$/.test(name)).slice(0,96);
    records.push(record);
   }catch{malformedLines++;}
  }
 }catch(error){traceError=errorCode(error);}
 finally{await handle?.close();}
 return {cache:{entries,truncated,errors,authEntriesOmitted},trace:{records,bytesRead,truncated:traceTruncated,malformedLines,error:traceError}};
}
export async function collectConcurrencyWaitState(procRoot='/proc',temporaryRoot='/tmp'){
 const sampledAt=new Date().toISOString();
 let processNames:string[]=[];let procError:string|null=null;
 try{processNames=(await readdir(procRoot)).filter(name=>/^\d+$/.test(name)).sort((a,b)=>Number(a)-Number(b));}catch(error){procError=errorCode(error);}
 const processRows=await Promise.all(processNames.slice(0,64).map(async name=>{
  const values=await Promise.all(['comm','status','wchan','syscall'].map(async file=>{try{return {file,text:await readFile(join(procRoot,name,file),'utf8'),error:null};}catch(error){return {file,text:'',error:errorCode(error)};}}));
  const data=Object.fromEntries(values.map(value=>[value.file,value.text]));
  const comm=data.comm!.trim(),wchan=data.wchan!.trim(),syscall=data.syscall!.trim().split(/\s+/,1)[0]??'';
  const parent=data.status!.match(/^PPid:\s*(\d+)$/m),state=data.status!.match(/^State:\s*([A-Z])/m),namespace=data.status!.match(/^NSpid:\s*([\d\s]+)$/m);
  return {pid:Number(name),comm:/^[A-Za-z0-9_.:+-]{1,32}$/.test(comm)?comm:null,ppid:parent?Number(parent[1]):null,state:state?.[1]??null,namespacePids:namespace?namespace[1]!.trim().split(/\s+/).map(Number).slice(0,8):[],wchan:/^[A-Za-z0-9_.]{1,96}$/.test(wchan)?wchan:null,syscallNumber:/^-?\d+$/.test(syscall)?Number(syscall):null,syscallRunning:syscall==='running',errors:Object.fromEntries(values.filter(value=>value.error).map(value=>[value.file,value.error]))};
 }));
 const entries:Array<{name:string;type:string;size:number}>=[],registryErrors:Array<{name:string;error:string}>=[];let registryTruncated=false;
 const walk=async(relative:string,depth=0):Promise<void>=>{
  if(entries.length>=64||relative.length>200){registryTruncated=true;return;}
  try{
   const info=await lstat(join(temporaryRoot,relative));const item={name:relative,type:info.isSymbolicLink()?'symlink':info.isDirectory()?'directory':info.isFile()?'file':'other',size:info.size};
   if(Buffer.byteLength(JSON.stringify([...entries,item]))>8192){registryTruncated=true;return;}entries.push(item);
   if(info.isDirectory()){if(depth>=3){registryTruncated=true;return;}for(const name of (await readdir(join(temporaryRoot,relative))).sort())await walk(relative+'/'+name,depth+1);}
  }catch(error){if(registryErrors.length<16)registryErrors.push({name:relative,error:errorCode(error)});}
 };
 try{for(const name of (await readdir(temporaryRoot)).filter(name=>/^codex-bwrap-synthetic-mount-targets-\d+$/.test(name)).sort().slice(0,8))await walk(name);}catch(error){registryErrors.push({name:'.',error:errorCode(error)});}
 return {sampledAt,finishedAt:new Date().toISOString(),processes:processRows,processesTruncated:processNames.length>64,procError,registries:{entries,truncated:registryTruncated,errors:registryErrors}};
}
export function nestedBwrapCauseArgs(){return ['--unshare-user','--unshare-pid','--ro-bind','/','/','--proc','/proc','--dev','/dev','--','/bin/true'];}
export function warmupNestedBwrapPid(spawnTrue:()=>{pid?:number;status:number|null;error?:unknown},probeNamespace:(pid:number)=>{exists:boolean;error:string|null}){
 const startedAt=Date.now();let attempts=0,lastWarmupPid=0,selectedMissingTarget=false;
 for(;attempts<128;){
  const child=spawnTrue();attempts++;
  if(child.error||child.status!==0||!Number.isSafeInteger(child.pid)||Number(child.pid)<1)break;
  lastWarmupPid=child.pid!;
  if(attempts>=64){const lookup=probeNamespace(lastWarmupPid+2);if(!lookup.exists&&lookup.error==='ENOENT'){selectedMissingTarget=true;break;}}
  if(Date.now()-startedAt>=3000)break;
 }
 return {attempts,lastWarmupPid,predictedBwrapPid:lastWarmupPid+1,predictedChildPid:lastWarmupPid+2,selectedMissingTarget,durationMs:Date.now()-startedAt};
}
export function assessNestedBwrapCause(observed:Record<string,unknown>){
 return {hypothesisMatched:observed.parentExitCode===1&&observed.parentExitedBeforeGuard===true&&observed.orphanGroupAliveBeforeKill===true&&typeof observed.stderr==='string'&&/open \/proc\/\d+\/ns(?:\/ns)? failed.*No such file or directory/.test(observed.stderr)};
}
export function nestedBwrapCauseScript(){return `
const fs=require('node:fs'),cp=require('node:child_process');
const stderrPath=${JSON.stringify(causeStderr)},receiptPath=${JSON.stringify(causeReceipt)};
const warmupNestedBwrapPid=${warmupNestedBwrapPid.toString()};
const warmup=warmupNestedBwrapPid(()=>cp.spawnSync('/bin/true',[],{stdio:'ignore',timeout:250}),pid=>{try{return {exists:fs.statSync('/proc/'+pid+'/ns').isDirectory(),error:null}}catch(error){return {exists:false,error:typeof error.code==='string'?error.code:'UNKNOWN'}}});
const stderrFd=fs.openSync(stderrPath,'r+');fs.ftruncateSync(stderrFd,0);
const startedAt=Date.now();const child=cp.spawn('/usr/bin/bwrap',${JSON.stringify(nestedBwrapCauseArgs())},{detached:true,stdio:['ignore','ignore',stderrFd],env:process.env});fs.closeSync(stderrFd);
const result={startedAt,warmup,runnerPid:process.pid,bwrapPid:child.pid||null,parentPidPredictionMatched:child.pid===warmup.predictedBwrapPid,parentExitCode:null,parentExitSignal:null,parentExitedAt:null,parentExitedBeforeGuard:false,orphanGroupAliveBeforeKill:false};
child.on('error',error=>{result.spawnError=typeof error.code==='string'?error.code:'UNKNOWN'});
child.on('exit',(code,signal)=>{result.parentExitCode=code;result.parentExitSignal=signal;result.parentExitedAt=Date.now()});
setTimeout(()=>{result.parentExitedBeforeGuard=result.parentExitedAt!==null;try{process.kill(-child.pid,0);result.orphanGroupAliveBeforeKill=result.parentExitedBeforeGuard}catch{};try{process.kill(-child.pid,'SIGKILL');result.groupKillSent=true}catch(error){result.groupKillError=typeof error.code==='string'?error.code:'UNKNOWN'};setTimeout(()=>{let file;try{file=fs.openSync(stderrPath,'r');const stat=fs.fstatSync(file),buffer=Buffer.alloc(Math.min(stat.size,4096));const bytes=fs.readSync(file,buffer,0,buffer.length,0);result.stderrBytes=stat.size;result.stderr=buffer.subarray(0,bytes).toString('utf8')}catch(error){result.stderrReadError=typeof error.code==='string'?error.code:'UNKNOWN'}finally{if(file!==undefined)fs.closeSync(file)}result.finishedAt=Date.now();const encoded=JSON.stringify(result);fs.writeFileSync(receiptPath,encoded,{flag:'r+',mode:0o600});fs.writeSync(1,'HIVEMIND_NESTED_BWRAP_CAUSE '+encoded+String.fromCharCode(10));},50);},3000);
`;}

export function concurrencyBashCommand(rawLabel:string,nodeExecutable='/usr/local/bin/node',workspace=paths.workspace){
 const label=checked(rawLabel),output=filename(label,workspace),receipt=receiptName(label,workspace),content=label.toUpperCase()+'_DONE\n';
 const program=`const fs=require("node:fs");const descriptor=fd=>{const s=fs.fstatSync(fd);return {regularFile:s.isFile(),pipe:s.isFIFO(),socket:s.isSocket(),character:s.isCharacterDevice()}};const value={label:${JSON.stringify(label)},stage:"node-enter",startedAt:Date.now(),uid:process.getuid(),cwd:process.cwd(),namespaceGuardApplied:process.env.HIVEMIND_NAMESPACE_GUARD==="seccomp-v1",environmentClean:Object.keys(process.env).every(key=>!(/^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CODEX_(?:API_KEY|TOKEN|ACCESS_TOKEN|REFRESH_TOKEN)$|CLOUDFLARE_|CF_API_|AWS_|PROBE_TOKEN$|AUTH_WRAP_KEY$|CONTROL_TOKEN$|AUTH_STORAGE_KEY$)/.test(key)&&process.env[key])),stdio:{stdin:descriptor(0),stdout:descriptor(1),stderr:descriptor(2)},stdinIsTTY:process.stdin.isTTY===true};fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(value));fs.writeSync(1,"NODE_ENTER ${label}"+String.fromCharCode(10));fs.writeSync(2,"NODE_STDERR ${label}"+String.fromCharCode(10));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(output)},${JSON.stringify(content)});value.stage="complete";value.finishedAt=Date.now();fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(value));fs.writeSync(1,"NODE_DONE ${label}"+String.fromCharCode(10));},1000);`;
 return '/usr/bin/printf '+shellQuote('BASH_ENTER '+label+'\n')+' && '+shellQuote(nodeExecutable)+' -e '+shellQuote(program)+' && /bin/cat '+shellQuote(output);
}
export function claudeCommandConcurrencyArgs(rawLabel:string){
 const command=concurrencyBashCommand(checked(rawLabel));
 const reply=bashHookReply({tool_name:'Bash',tool_input:{command}}) as {hookSpecificOutput:{updatedInput:{command:string}}};
 return ['--settings',settingsFile,'--','/bin/bash','-c',reply.hookSpecificOutput.updatedInput.command];
}
export function assessClaudeCommandConcurrency(report:Record<string,unknown>){
 const parallel=Array.isArray(report.parallel)?report.parallel:[];
 const complete=(raw:unknown,label:Label)=>{const run=object(raw),receipt=object(run?.receipt);return !!run&&!!receipt&&run.label===label&&run.exitCode===0&&run.timedOut===false&&run.captureLimit===false&&run.outputMatches===true&&receipt.label===label&&receipt.stage==='complete'&&receipt.uid===1000&&receipt.namespaceGuardApplied===true&&receipt.environmentClean===true&&Number.isSafeInteger(receipt.startedAt)&&Number.isSafeInteger(receipt.finishedAt)&&receipt.finishedAt-receipt.startedAt>=900;};
 const alpha=object(object(parallel[0])?.receipt),beta=object(object(parallel[1])?.receipt);
 const parallelOverlap=!!alpha&&!!beta&&Math.max(alpha.startedAt,beta.startedAt)<Math.min(alpha.finishedAt,beta.finishedAt);
 const checks={noAuthentication:report.authProvided===false&&report.modelCalled===false&&report.guardCacheCredentialsAbsent===true,processBoundary:report.uid===1000&&report.noNewPrivileges==='1'&&capZero(report.capabilities),alpha:complete(parallel[0],'alpha'),beta:complete(parallel[1],'beta'),exactlyTwoParallel:parallel.length===2,serial:complete(report.serial,'serial'),parallelOverlap};
 return {passed:Object.values(checks).every(Boolean),checks};
}
export async function runClaudeCommandConcurrencyProbe(){
 const status=await readFile('/proc/self/status','utf8').catch(()=>'');
 const capabilities=Object.fromEntries([...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*([0-9a-fA-F]+)$/gm)].map(match=>[match[1],match[2]]));
 const baseline={scope:'cloudflare-no-auth-claude-managed-bash-concurrency',authProvided:false,modelCalled:false,uid:process.getuid?.(),noNewPrivileges:status.match(/^NoNewPrivs:\s*(\d+)$/m)?.[1],capabilities,guardPath:GUARD,guardHome:claudeGuardHome(paths),phaseOrder:['parallel','serial'],stdioMode:'stdin-ignore/stdout-pipe/stderr-pipe',parentCwd:process.cwd()};
 const owned:string[]=[];let report:Record<string,unknown>={...baseline};
 try{
  if(baseline.uid!==1000||baseline.noNewPrivileges!=='1'||!capZero(capabilities))throw new Error('Unsafe process boundary');
  await mkdir(paths.privateDir,{recursive:true,mode:0o700});await mkdir(baseline.guardHome,{recursive:true,mode:0o700});
  if(!await absent(baseline.guardHome+'/auth.json'))throw new Error('Guard cache contains authentication');
  const settings=claudeOuterSandboxSettings(paths,true);
  for(const [path,content] of [[settingsFile,JSON.stringify(settings)],[causeReceipt,''],[causeStderr,''],...labels.flatMap(label=>[[filename(label),''],[receiptName(label),'']])]){await writeFile(path!,content!,{flag:'wx',mode:0o600});owned.push(path!);}
  const initialGuardCacheEntries=(await readdir(baseline.guardHome)).length;
  const env=claudeCommandConcurrencyEnvironment(process.env);
  const diagnosticsBefore=await collectConcurrencyDiagnostics();
  const run=async(label:Label)=>{
   const startedAt=Date.now();const result=await runBounded('srt',claudeCommandConcurrencyArgs(label),{cwd:paths.workspace,env,timeoutMs:20000,maxBytes:32768});const finishedAt=Date.now();
   let receipt:unknown=null;try{const raw=await readFile(receiptName(label),'utf8');if(raw.length<16384)receipt=JSON.parse(raw);}catch{/* Empty or incomplete stage remains visible as missing evidence. */}
   const outputMatches=await readFile(filename(label),'utf8').then(value=>value===label.toUpperCase()+'_DONE\n',()=>false);
   return {label,commandHash:createHash('sha256').update(concurrencyBashCommand(label)).digest('hex'),startedAt,finishedAt,durationMs:finishedAt-startedAt,exitCode:result.exitCode,timedOut:result.timedOut,captureLimit:result.captureLimit,stdoutBytes:Buffer.byteLength(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),stdout:result.stdout.slice(-6000),stderr:result.stderr.slice(-6000),receipt,outputMatches,timeline:result.timeline.slice(-32)};
  };
  const parallel=await Promise.all([run('alpha'),run('beta')]);
  const diagnosticsAfterParallel=await collectConcurrencyDiagnostics();
  const serialPromise=run('serial');let sampleTimer:ReturnType<typeof setTimeout>|undefined;
  const serialFirst=await Promise.race([serialPromise.then(value=>({kind:'finished' as const,value})),new Promise<{kind:'sample'}>(resolve=>{sampleTimer=setTimeout(()=>resolve({kind:'sample'}),2000);})]);
  if(sampleTimer)clearTimeout(sampleTimer);
  const serialInFlight=serialFirst.kind==='sample'?{sampled:true,trigger:'serial-pending-after-2000ms',...await collectConcurrencyWaitState(),guardDiagnostics:await collectConcurrencyDiagnostics()}:{sampled:false,reason:'serial-finished-before-2000ms'};
  const serial=serialFirst.kind==='finished'?serialFirst.value:await serialPromise;
  const diagnosticsAfterSerial=await collectConcurrencyDiagnostics();
  const causePromise=runBounded('srt',['--settings',settingsFile,'--','/usr/local/bin/node','-e',nestedBwrapCauseScript()],{cwd:paths.workspace,env,timeoutMs:10000,maxBytes:8192});
  let causeSampleTimer:ReturnType<typeof setTimeout>|undefined;
  const causeFirst=await Promise.race([causePromise.then(value=>({kind:'finished' as const,value})),new Promise<{kind:'sample'}>(resolve=>{causeSampleTimer=setTimeout(()=>resolve({kind:'sample'}),2000);})]);
  if(causeSampleTimer)clearTimeout(causeSampleTimer);
  const causeInFlight=causeFirst.kind==='sample'?await collectConcurrencyWaitState():null;
  const causeProcess=causeFirst.kind==='finished'?causeFirst.value:await causePromise;
  let causeObserved:Record<string,unknown>={};try{const raw=await readFile(causeReceipt,'utf8');if(raw.length<8192)causeObserved=object(JSON.parse(raw))??{};}catch{}
  const nestedBwrapCause={...causeObserved,assessment:assessNestedBwrapCause(causeObserved),inFlight:causeInFlight,outerExitCode:causeProcess.exitCode,outerTimedOut:causeProcess.timedOut,outerCaptureLimit:causeProcess.captureLimit,outerStderr:causeProcess.stderr.slice(-2000)};
  report={...baseline,guardTraceEnabled:env.HIVEMIND_GUARD_TRACE==='1',initialGuardCacheEntries,configuredOuterSettings:settings,proxyEnvironmentPresent:Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].map(key=>[key,!!env[key]])),parallel,serial,serialInFlight,nestedBwrapCause,diagnosticsBefore,diagnosticsAfterParallel,diagnosticsAfterSerial,guardCacheCredentialsAbsent:await absent(baseline.guardHome+'/auth.json'),limitations:['Standalone SRT reproduces the exact managed hook Bash rewrite, without a Claude model or native tool supervisor.','The parallel phase runs before the serial control; existing guard-cache state is recorded.','The final trusted no-auth cause probe runs raw nested bwrap with regular stderr and a 3-second process-group watchdog.']};
 }catch{report={...report,error:'No-auth command concurrency preparation or bounded execution failed'};}
 finally{await Promise.all(owned.map(path=>rm(path,{force:true}).catch(()=>undefined)));}
 return {...report,assessment:assessClaudeCommandConcurrency(report)};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.stdout.write(JSON.stringify(await runClaudeCommandConcurrencyProbe()));
