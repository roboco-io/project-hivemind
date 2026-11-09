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
  for(const [path,content] of [[settingsFile,JSON.stringify(settings)],...labels.flatMap(label=>[[filename(label),''],[receiptName(label),'']])]){await writeFile(path!,content!,{flag:'wx',mode:0o600});owned.push(path!);}
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
  const serial=await run('serial');
  const diagnosticsAfterSerial=await collectConcurrencyDiagnostics();
  report={...baseline,guardTraceEnabled:env.HIVEMIND_GUARD_TRACE==='1',initialGuardCacheEntries,configuredOuterSettings:settings,proxyEnvironmentPresent:Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].map(key=>[key,!!env[key]])),parallel,serial,diagnosticsBefore,diagnosticsAfterParallel,diagnosticsAfterSerial,guardCacheCredentialsAbsent:await absent(baseline.guardHome+'/auth.json'),limitations:['Standalone SRT reproduces the exact managed hook Bash rewrite, without a Claude model or native tool supervisor.','The parallel phase runs before the serial control; existing guard-cache state is recorded.']};
 }catch{report={...report,error:'No-auth command concurrency preparation or bounded execution failed'};}
 finally{await Promise.all(owned.map(path=>rm(path,{force:true}).catch(()=>undefined)));}
 return {...report,assessment:assessClaudeCommandConcurrency(report)};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.stdout.write(JSON.stringify(await runClaudeCommandConcurrencyProbe()));
