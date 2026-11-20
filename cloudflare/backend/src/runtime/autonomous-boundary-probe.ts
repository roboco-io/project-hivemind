import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {claudeGuardSandboxArgs} from './claude-command-guard.ts';
const checks=['workspaceWrite','outsideWriteDenied','runtimeReadDenied','claudeReadDenied','parentProcDenied','authEnvironmentAbsent','namespaceGuardActive'] as const;
export interface BoundaryProbeReport {passed:boolean;workspaceWrite:boolean;outsideWriteDenied:boolean;runtimeReadDenied:boolean;claudeReadDenied:boolean;parentProcDenied:boolean;authEnvironmentAbsent:boolean;namespaceGuardActive:boolean;cleanup:boolean;errorCategory:'none'|'unsafe-process'|'unexpected-private-files'|'sandbox-failed'|'cleanup-failed'}
export function boundaryParentAuthAbsent(source:NodeJS.ProcessEnv=process.env):boolean {
 return Object.entries(source).every(([key,value])=>!value||!(/^(CONTROL_TOKEN$|AUTH_|AUTONOMOUS_|CLAUDE_CODE_OAUTH_TOKEN$|OPENAI_|ANTHROPIC_|CLOUDFLARE_|CF_API_|AWS_)/.test(key)));
}
export function boundaryProbeEnvironment():Record<string,string>{
 return {PATH:'/opt/hivemind/compat-bin:/usr/local/bin:/usr/bin:/bin',HOME:'/home/node',USER:'node',LOGNAME:'node',CODEX_HOME:'/home/node/.codex-guard',TMPDIR:'/tmp',CI:'1',TERM:'dumb',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
}
export function boundaryProbeCanaryEnvironment():Record<string,string>{
 return {...boundaryProbeEnvironment(),CLAUDE_CODE_OAUTH_TOKEN:'FAKE_PROVIDER_CANARY',CONTROL_TOKEN:'FAKE_CONTROL_CANARY',AUTH_STORAGE_KEY:'FAKE_STORE_CANARY'};
}
/** Fixed no-model command. Caller supplies only the parent PID, never task argv. */
export function boundaryProbeArgs(parentPid:number=process.pid):string[]{
 if(!Number.isSafeInteger(parentPid)||parentPid<1)throw new Error('Invalid parent identity');
 const script=`
const fs=require('node:fs');
const denied=p=>{try{fs.readFileSync(p);return false;}catch(e){return ['EACCES','EPERM','ENOENT'].includes(e.code);}};
const result={workspaceWrite:false,outsideWriteDenied:false,runtimeReadDenied:denied('/runtime/private/canary'),claudeReadDenied:denied('/home/node/.claude/.credentials.json'),parentProcDenied:['environ','cmdline','status','mem','root/runtime/private/canary','root/home/node/.claude/.credentials.json'].every(p=>denied('/proc/${parentPid}/'+p)),namespaceGuardActive:process.env.HIVEMIND_NAMESPACE_GUARD==='seccomp-v1',authEnvironmentAbsent:Object.keys(process.env).filter(k=>k!=='HIVEMIND_NAMESPACE_GUARD').every(k=>!(/^(CONTROL_TOKEN$|AUTH_|AUTONOMOUS_|HIVEMIND_|CLAUDE_CODE_OAUTH_TOKEN$|OPENAI_|ANTHROPIC_|CLOUDFLARE_|CF_API_|AWS_|NODE_OPTIONS$)/.test(k)))};
fs.writeFileSync('/workspace/.hivemind-autonomous-boundary-write','inside');result.workspaceWrite=fs.readFileSync('/workspace/.hivemind-autonomous-boundary-write','utf8')==='inside';
try{fs.writeFileSync('/home/node/.hivemind-autonomous-boundary-outside','escaped');}catch(e){result.outsideWriteDenied=['EACCES','EPERM','ENOENT','EROFS'].includes(e.code);}
fs.writeFileSync('/workspace/.hivemind-autonomous-boundary-result',JSON.stringify(result),{flag:'r+'});
if(!Object.values(result).every(v=>v===true))process.exitCode=1;
`;
 return claudeGuardSandboxArgs(['/usr/local/bin/node','-e',script]);
}
export interface OwnedBoundaryPath {path:string;dev:number;ino:number}
/** Refuse replaced paths: cleanup must never adopt somebody else's file or directory. */
export async function cleanupBoundaryFixtures(owned:readonly OwnedBoundaryPath[]):Promise<boolean>{
 let clean=true;const preserved:string[]=[];
 for(const entry of [...owned].reverse())try{
  if(preserved.some(path=>path===entry.path||path.startsWith(entry.path+'/'))){clean=false;continue;}
  const info=await lstat(entry.path);
  if(info.dev!==entry.dev||info.ino!==entry.ino||info.isSymbolicLink()){clean=false;preserved.push(entry.path);continue;}
  await rm(entry.path,{recursive:info.isDirectory(),force:false});
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){clean=false;preserved.push(entry.path);}}
 return clean;
}
/** Fixed sandbox command; detached group ensures a timeout cannot leave a writer behind. */
export async function runBoundaryProbeChild(spawnImpl:typeof spawn=spawn,timeoutMs=20000):Promise<boolean>{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000)throw Error('Invalid probe timeout');
 let child:ReturnType<typeof spawn>;
 try{child=spawnImpl('/usr/local/bin/codex',boundaryProbeArgs(),{cwd:'/workspace',env:boundaryProbeCanaryEnvironment(),stdio:'ignore',detached:true});}catch{return false;}
 return new Promise(resolve=>{
  let settled=false,timedOut=false,cleanupFailed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH'){cleanupFailed=true;child.kill('SIGKILL');}}};
  const finish=(passed:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);stop();resolve(passed&&!timedOut&&!cleanupFailed);};
  child.once('error',()=>finish(false));child.once('exit',(code,signal)=>finish(code===0&&signal===null));
  timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
 });
}
/** Run only before prepare/auth transfer; cleanup owns exclusively-created fixtures/cache. */
export async function runAutonomousBoundaryProbe():Promise<BoundaryProbeReport>{
 const report:BoundaryProbeReport={passed:false,workspaceWrite:false,outsideWriteDenied:false,runtimeReadDenied:false,claudeReadDenied:false,parentProcDenied:false,authEnvironmentAbsent:false,namespaceGuardActive:false,cleanup:true,errorCategory:'unsafe-process'};
 const owned:OwnedBoundaryPath[]=[];
 try{
  if(!boundaryParentAuthAbsent())return report;
  const status=await readFile('/proc/self/status','utf8');
  if(process.getuid?.()!==1000||!/^NoNewPrivs:\s+1$/m.test(status)||!['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(k=>new RegExp('^'+k+':\\s+0+$','m').test(status)))return report;
  report.errorCategory='unexpected-private-files';
  for(const dir of ['/runtime','/home/node','/workspace']){const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())return report;}
  if((await readdir('/runtime')).length)return report;
  for(const path of ['/home/node/.claude','/home/node/.claude.json','/home/node/.codex','/home/node/.codex-guard','/home/node/.hivemind-phase0']){
   try{await lstat(path);return report;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  for(const dir of ['/runtime/private','/home/node/.claude','/home/node/.codex-guard']){await mkdir(dir,{mode:0o700});const info=await lstat(dir);owned.push({path:dir,dev:info.dev,ino:info.ino});}
  const fixtures=[['/runtime/private/canary','FAKE_RUNTIME_CANARY'],['/home/node/.claude/.credentials.json','FAKE_AUTH_CANARY'],['/home/node/.hivemind-autonomous-boundary-outside','before'],['/workspace/.hivemind-autonomous-boundary-write','before'],['/workspace/.hivemind-autonomous-boundary-result','']];
  for(const [path,value] of fixtures){const file=await open(path!,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{const info=await file.stat();owned.push({path:path!,dev:info.dev,ino:info.ino});await file.writeFile(value!);}finally{await file.close();}}
  report.errorCategory='sandbox-failed';
  if(!await runBoundaryProbeChild())return report;
  const resultPath='/workspace/.hivemind-autonomous-boundary-result',identity=owned.find(entry=>entry.path===resultPath)!;
  const file=await open(resultPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let raw:string;
  try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.dev!==identity.dev||info.ino!==identity.ino||info.size>4096)return report;const bytes=await file.readFile();if(bytes.length>4096)return report;raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}finally{await file.close();}
  const observed=JSON.parse(raw);
  for(const key of checks)report[key]=observed?.[key]===true;
  report.outsideWriteDenied=report.outsideWriteDenied&&await readFile('/home/node/.hivemind-autonomous-boundary-outside','utf8')==='before';
  report.passed=checks.every(key=>report[key]);if(report.passed)report.errorCategory='none';
 }catch{/* Fixed categories only; no child output or private bytes escape. */}
 finally{
  if(!await cleanupBoundaryFixtures(owned)){report.cleanup=false;report.passed=false;report.errorCategory='cleanup-failed';}
 }
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==2){console.log(JSON.stringify({passed:false,errorCategory:'unexpected-arguments'}));process.exitCode=1;}
 else {const result=await runAutonomousBoundaryProbe();console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;}
}
