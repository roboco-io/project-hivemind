import {mkdir,readFile,writeFile,readlink,readdir,rm,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildEnv} from '../../backend/src/runtime/providers.ts';
import {CLAUDE_GUARD_PATHS,claudeGuardHome,claudeOuterSandboxSettings,claudeGuardSandboxArgs,claudeGuardEnvironment} from '../../backend/src/runtime/claude-command-guard.ts';
import {runBounded} from './run-bounded.ts';

// Diagnostic only: this does not launch Claude, call a model, or install a runtime hook.
const paths=CLAUDE_GUARD_PATHS;
const guardHome=claudeGuardHome(paths);
const receipt='/workspace/phase0-claude-codex-layer-result.json';
const outside='/home/node/phase0-claude-codex-layer-outside.txt';
const guardSentinel=guardHome+'/layer-write-sentinel.txt';
const privateFixture=paths.privateDir+'/claude-codex-layer-private.txt';
const runtimeFixture='/runtime/claude-codex-layer-input.json';
const settingsFile=paths.privateDir+'/claude-codex-layer-settings.json';
const required=['workspaceWrite','outsideWriteDenied','outsideSentinelUnchanged','guardCacheWriteDenied','guardCacheSentinelUnchanged','guardCacheCredentialsAbsent','claudeAuthReadDenied','claudeConfigReadDenied','privateReadDenied','runtimeInputReadDenied','procReadDenied','parentProcessInfoDenied','parentRootAliasDenied','parentMemoryDenied','parentEnvironmentDenied','parentReadlinksDenied','threadAliasesDenied','siblingAliasesDenied','privateHardlinkDenied','fixtureCredentialAbsent','managementCredentialsAbsent','devNullWritable','ignoredSpawnWorks','unshareBlocked','mountNamespaceBlocked','bubblewrapBlocked','namespaceSyscallsBlocked','networkDenied','namespaceGuardApplied'];
const capNames=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'];
const absent=(path:string)=>lstat(path).then(()=>false,error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;});
const capZero=(value:unknown)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===5&&capNames.every(key=>typeof (value as Record<string,unknown>)[key]==='string'&&/^0+$/.test((value as Record<string,string>)[key]!));
export function assessClaudeCodexLayer(result:Record<string,unknown>){
 return {passed:result.authProvided===false&&result.modelCalled===false&&result.uid===1000&&result.toolUid===1000&&result.noNewPrivileges==='1'&&capZero(result.capabilities)&&result.exitCode===0&&result.timedOut===false&&result.captureLimit===false&&required.every(key=>result[key]===true),checks:[...required]};
}
export function assessNativeNamespaceProbe(result:{status:number|null;error?:unknown;stdout?:string|null}){
 const observation:Record<string,unknown>={};
 try{
  const value:unknown=JSON.parse(result.stdout??'');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid native evidence');
  const input=value as Record<string,unknown>;
  for(const key of ['passed','capabilitiesZero','noNewPrivileges','unshareDenied','cloneUserDenied','cloneUserMountDenied','clone3Denied'])if(typeof input[key]==='boolean')observation[key]=input[key];
  for(const key of ['uid','unshareErrno','cloneErrno','cloneMountErrno','clone3Errno'])if(Number.isSafeInteger(input[key]))observation[key]=input[key];
 }catch{/* Incomplete evidence cannot pass. */}
 const passed=!result.error&&result.status===0&&observation.passed===true&&observation.uid===1000&&['capabilitiesZero','noNewPrivileges','unshareDenied','cloneUserDenied','cloneUserMountDenied','clone3Denied'].every(key=>observation[key]===true)&&['unshareErrno','cloneErrno','cloneMountErrno','clone3Errno'].every(key=>[1,13,28,87,38].includes(Number(observation[key])));
 return {passed,observation,status:result.status,spawnError:!!result.error};
}
export function claudeCodexLayerSettings(){
 return claudeOuterSandboxSettings(paths,true);
}
export function claudeCodexLayerEnvironment(source:NodeJS.ProcessEnv){
 // Challenge SRT with a fixed fake token after the shared production scrub.
 return {...claudeGuardEnvironment(buildEnv(source,paths.home),paths),CLAUDE_CODE_OAUTH_TOKEN:'NON_SECRET_CLAUDE_ENV_FIXTURE'};
}
interface Context {outerPid:number;threadIds:number[];siblingIds:number[]}
function fixedScript(context:Context){return `
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const outerPid=${context.outerPid};
const threadIds=${JSON.stringify(context.threadIds)},siblingIds=${JSON.stringify(context.siblingIds)};
const code=error=>typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)?error.code:'UNKNOWN';
const accepted=['EACCES','EPERM','ENOENT','ENOTDIR'];
const read=path=>{try{return {denied:false,bytes:fs.readFileSync(path).length}}catch(error){return {denied:accepted.includes(error.code),bytes:null,error:code(error)}}};
const open=path=>{try{const fd=fs.openSync(path,'r');fs.closeSync(fd);return {denied:false}}catch(error){return {denied:accepted.includes(error.code),error:code(error)}}};
const link=path=>{try{fs.readlinkSync(path);return {denied:false}}catch(error){return {denied:accepted.includes(error.code),error:code(error)}}};
const write=path=>{try{fs.writeFileSync(path,'escaped');return {denied:false}}catch(error){return {denied:[...accepted,'EROFS','EXDEV'].includes(error.code),error:code(error)}}};
const proc='/proc/'+outerPid;
const reads={claudeAuth:read('/home/node/.claude/.credentials.json'),claudeConfig:read('/home/node/.claude.json'),private:read('${privateFixture}'),runtime:read('${runtimeFixture}'),selfStatus:read('/proc/self/status'),parentStatus:read(proc+'/status'),parentCommandLine:read(proc+'/cmdline'),parentEnvironment:read(proc+'/environ'),parentRootPrivate:read(proc+'/root${privateFixture}'),parentRootRuntime:read(proc+'/root${runtimeFixture}'),parentRootClaude:read(proc+'/root/home/node/.claude/.credentials.json')};
const parentMemory=open(proc+'/mem'),parentLinks=['cwd','exe','root'].map(name=>({name,...link(proc+'/'+name)}));
const threads=threadIds.map(tid=>({tid,status:read('/proc/'+tid+'/status'),cmdline:read('/proc/'+tid+'/cmdline'),environ:read('/proc/'+tid+'/environ'),memory:open('/proc/'+tid+'/mem'),rootRuntime:read('/proc/'+tid+'/root${runtimeFixture}')}));
const siblings=siblingIds.map(pid=>({pid,private:read('/proc/'+pid+'/root${privateFixture}'),runtime:read('/proc/'+pid+'/root${runtimeFixture}'),nestedParent:read('/proc/'+pid+'/root'+proc+'/environ')}));
const inside='/workspace/phase0-claude-codex-layer-inside.txt';fs.writeFileSync(inside,'inside');
const outsideWrite=write('${outside}'),guardCacheWrite=write('${guardSentinel}');
const hardlink=(()=>{try{fs.linkSync('/proc/'+siblingIds.at(-1)+'/root${runtimeFixture}','/workspace/phase0-claude-codex-layer-hardlink');return {denied:false}}catch(error){return {denied:[...accepted,'EROFS','EXDEV'].includes(error.code),error:code(error)}}})();
const namespaceAttempt=(command,args)=>{const result=cp.spawnSync(command,args,{encoding:'utf8',timeout:2000,maxBuffer:16000,env:process.env});const error=result.error?code(result.error):null;const stderr=result.stderr||'';return {denied:!error&&result.status!==null&&result.status!==0&&/Operation not permitted|Permission denied|No permissions|No space left on device/i.test(stderr),status:result.status,signal:result.signal,error,stderrBytes:Buffer.byteLength(stderr)}};
const namespaceAttempts={unshare:namespaceAttempt('unshare',['-Ur','/bin/true']),mount:namespaceAttempt('unshare',['-m','/bin/true']),bubblewrap:namespaceAttempt('bwrap',['--unshare-user','--unshare-pid','--ro-bind','/','/','--proc','/proc','--dev','/dev','--','/bin/true'])};
const assessNativeNamespaceProbe=${assessNativeNamespaceProbe.toString()};
const nativeNamespace=assessNativeNamespaceProbe(cp.spawnSync('/opt/hivemind/bin/namespace-probe',[],{encoding:'utf8',timeout:2000,maxBuffer:16000,env:process.env}));
const namespace=(()=>{try{return {inode:fs.readlinkSync('/proc/self/ns/pid')}}catch(error){return {inode:null,error:code(error)}}})();
const devNull=(()=>{try{fs.writeFileSync('/dev/null','fixture');return true}catch{return false}})();
const result={namespaceGuardApplied:process.env.HIVEMIND_NAMESPACE_GUARD==='seccomp-v1',toolUid:process.getuid(),workspaceWrite:fs.readFileSync(inside,'utf8')==='inside',outsideWriteDenied:outsideWrite.denied,guardCacheWriteDenied:guardCacheWrite.denied,claudeAuthReadDenied:reads.claudeAuth.denied,claudeConfigReadDenied:reads.claudeConfig.denied,privateReadDenied:reads.private.denied,runtimeInputReadDenied:reads.runtime.denied,procReadDenied:reads.selfStatus.denied,parentProcessInfoDenied:reads.parentStatus.denied&&reads.parentCommandLine.denied,parentRootAliasDenied:reads.parentRootPrivate.denied&&reads.parentRootRuntime.denied&&reads.parentRootClaude.denied,parentMemoryDenied:parentMemory.denied,parentEnvironmentDenied:reads.parentEnvironment.denied,parentReadlinksDenied:parentLinks.every(item=>item.denied),threadAliasesDenied:threads.every(item=>item.status.denied&&item.cmdline.denied&&item.environ.denied&&item.memory.denied&&item.rootRuntime.denied),siblingAliasesDenied:siblings.every(item=>item.private.denied&&item.runtime.denied&&item.nestedParent.denied),privateHardlinkDenied:hardlink.denied,fixtureCredentialAbsent:!process.env.CLAUDE_CODE_OAUTH_TOKEN,managementCredentialsAbsent:Object.keys(process.env).every(key=>!(/^(OPENAI_|ANTHROPIC_|CODEX_(?:API_KEY|TOKEN|ACCESS_TOKEN|REFRESH_TOKEN)$|CLOUDFLARE_|CF_API_|AWS_|PROBE_TOKEN$|AUTH_WRAP_KEY$|CONTROL_TOKEN$|AUTH_STORAGE_KEY$)/.test(key)&&process.env[key])),devNullWritable:devNull,ignoredSpawnWorks:cp.spawnSync('/bin/true',[],{stdio:'ignore',timeout:2000}).status===0,unshareBlocked:namespaceAttempts.unshare.denied,mountNamespaceBlocked:namespaceAttempts.mount.denied,bubblewrapBlocked:namespaceAttempts.bubblewrap.denied,namespaceSyscallsBlocked:nativeNamespace.passed};
let socket,networkTimer,done=false;
const finish=(blocked,outcome,error=null)=>{if(done)return;done=true;if(networkTimer)clearTimeout(networkTimer);if(socket)socket.destroy();const terminal={...result,networkDenied:blocked};const encoded=JSON.stringify({...terminal,network:{outcome,error},reads,parentMemory,parentLinks,threads,siblings,outsideWrite,guardCacheWrite,hardlink,namespaceAttempts,nativeNamespace,childPid:process.pid,childParentPid:process.ppid,childCwd:process.cwd(),innerTmpdir:process.env.TMPDIR,childPidNamespace:namespace});fs.writeFileSync('${receipt}',encoded,{flag:'r+',mode:0o600});fs.writeSync(1,'HIVEMIND_CLAUDE_CODEX_LAYER_RESULT '+encoded+String.fromCharCode(10));if(!Object.entries(terminal).every(([key,value])=>key==='toolUid'?value===1000:value===true))process.exitCode=31;};
try{socket=net.connect({host:'1.1.1.1',port:443});socket.on('connect',()=>finish(false,'connected'));socket.on('error',error=>finish(true,'error',code(error)));networkTimer=setTimeout(()=>finish(true,'timeout'),1500);}catch(error){finish(true,'error',code(error));}
`;}
export function claudeCodexLayerArgs(context:Context={outerPid:process.pid,threadIds:[],siblingIds:[]}){
 if(!Number.isSafeInteger(context.outerPid)||context.outerPid<1||[...context.threadIds,...context.siblingIds].some(id=>!Number.isSafeInteger(id)||id<1)||context.threadIds.length>64||context.siblingIds.length>8)throw new Error('Invalid fixed process fixture');
 return claudeGuardSandboxArgs(['node','-e',fixedScript(context)],paths);
}
export function claudeCodexLayerCommand(context:Context={outerPid:process.pid,threadIds:[],siblingIds:[]}){
 const script=claudeCodexLayerArgs(context).at(-1)!;
 return ['/opt/hivemind/backend/src/runtime/claude-command-guard.ts','--','node','-e',script];
}
export async function runClaudeCodexLayerProbe(){
 const status=await readFile('/proc/self/status','utf8').catch(()=>'');
 const capabilities=Object.fromEntries([...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*([0-9a-fA-F]+)$/gm)].map(match=>[match[1],match[2]]));
 const baseline={scope:'cloudflare-no-auth-claude-codex-layer-prototype',authProvided:false,modelCalled:false,uid:process.getuid?.(),noNewPrivileges:status.match(/^NoNewPrivs:\s*(\d+)$/m)?.[1],capabilities,outerPid:process.pid,outerPidNamespace:await readlink('/proc/self/ns/pid').catch(()=>null),parentCwd:process.cwd(),guardHome,innerTmpdirBridge:{entrypoint:'/opt/hivemind/backend/src/runtime/claude-command-guard.ts',expectedTMPDIR:'/tmp'}};
 const owned:string[]=[];let report:Record<string,unknown>={...baseline,exitCode:null,timedOut:false,captureLimit:false};
 let sibling:ReturnType<typeof spawn>|undefined,siblingClosed:Promise<void>|undefined;
 try{
  if(baseline.uid!==1000||baseline.noNewPrivileges!=='1'||!capZero(capabilities))throw new Error('Unsafe process boundary');
  if(!await absent(guardHome+'/auth.json'))throw new Error('Guard home is not credential-free');
  if(!await absent('/workspace/phase0-claude-codex-layer-hardlink'))throw new Error('Hardlink fixture path already exists');
  owned.push('/workspace/phase0-claude-codex-layer-hardlink');
  await mkdir(paths.privateDir,{recursive:true,mode:0o700});await mkdir(paths.home+'/.claude',{recursive:true,mode:0o700});await mkdir(guardHome,{recursive:true,mode:0o700});
  const settings=claudeCodexLayerSettings();
  for(const [path,content] of [[paths.home+'/.claude/.credentials.json','NON_SECRET_CLAUDE_AUTH_FIXTURE'],[paths.home+'/.claude.json','NON_SECRET_CLAUDE_CONFIG_FIXTURE'],[privateFixture,'NON_SECRET_PRIVATE_FIXTURE'],[runtimeFixture,'NON_SECRET_RUNTIME_FIXTURE'],[outside,'before'],[guardSentinel,'before'],['/workspace/phase0-claude-codex-layer-inside.txt','before'],[receipt,''],[settingsFile,JSON.stringify(settings)]]){await writeFile(path!,content!,{flag:'wx',mode:0o600});owned.push(path!);}
  const threadIds=(await readdir('/proc/self/task')).filter(id=>/^\d+$/.test(id)).map(Number).slice(0,64);
  sibling=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{env:{PATH:process.env.PATH,HIVEMIND_PARENT_AUTH_FIXTURE:'NON_SECRET_SIBLING_FIXTURE'},stdio:'ignore'});
  siblingClosed=new Promise(resolve=>{sibling!.once('close',()=>resolve());sibling!.once('error',()=>resolve());});
  if(!sibling.pid)throw new Error('Sibling fixture did not start');
  const siblingIds=[1,sibling.pid];
  const env=claudeCodexLayerEnvironment(process.env);
  const output=await runBounded('srt',['--settings',settingsFile,'--',...claudeCodexLayerCommand({outerPid:process.pid,threadIds,siblingIds})],{cwd:paths.workspace,env,timeoutMs:20000,maxBytes:128000});
  const file=await readFile(receipt,'utf8').catch(()=>'');
  const lines=output.stdout.split(/\r?\n/).filter(line=>line.startsWith('HIVEMIND_CLAUDE_CODEX_LAYER_RESULT '));
  const observationSource=lines.length===1?'stdout':lines.length===0&&file?'workspace-receipt':'none';
  let observed:Record<string,unknown>={};
  try{const raw=observationSource==='stdout'?lines[0]!.slice('HIVEMIND_CLAUDE_CODEX_LAYER_RESULT '.length):observationSource==='workspace-receipt'?file:'';if(raw.length>128000)throw new Error('Large observation');const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid observation');observed=value;}catch{/* Missing observations fail every required check. */}
  const outsideSentinelUnchanged=await readFile(outside,'utf8').then(value=>value==='before',()=>false);
  const guardCacheSentinelUnchanged=await readFile(guardSentinel,'utf8').then(value=>value==='before',()=>false);
  report={...observed,...baseline,threadIds,siblingIds,configuredOuterSettings:settings,outsideSentinelUnchanged,guardCacheSentinelUnchanged,guardCacheCredentialsAbsent:await absent(guardHome+'/auth.json'),observationSource,receiptBytes:Buffer.byteLength(file),stdoutBytes:Buffer.byteLength(output.stdout),stderrBytes:Buffer.byteLength(output.stderr),exitCode:output.exitCode,timedOut:output.timedOut,captureLimit:output.captureLimit,stderr:output.stderr.slice(-4000),limitations:['No Claude model or mandatory hook integration is exercised.','Network observation covers one direct TCP endpoint only.']};
 }catch{report={...report,error:'No-auth layered prototype preparation or bounded execution failed'};}
 finally{
  if(sibling&&!sibling.killed)sibling.kill('SIGTERM');if(siblingClosed)await siblingClosed;
  await Promise.all(owned.map(path=>rm(path,{force:true}).catch(()=>undefined)));
 }
 return {...report,assessment:assessClaudeCodexLayer(report)};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.stdout.write(JSON.stringify(await runClaudeCodexLayerProbe()));
