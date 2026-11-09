#!/usr/local/bin/node
import {pathToFileURL} from 'node:url';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,writeSync,closeSync,unlinkSync} from 'node:fs';
import {providerArgs} from './providers.ts';
import {CLAUDE_GUARD_PATHS,claudeGuardHome,claudeGuardEnvironment,type GuardPaths} from './claude-guard-policy.ts';
export {CLAUDE_GUARD_PATHS,claudeGuardHome,claudeGuardEnvironment,claudeOuterSandboxSettings,filteredEnvironment} from './claude-guard-policy.ts';
export const CODEX_SANDBOX_EXECUTABLE='/usr/local/bin/codex';
const tracePath='/workspace/.hivemind-guard-trace.jsonl',traceLock='/workspace/.hivemind-guard-trace.lock',maxTraceBytes=8192;
export function guardTraceMetadata(stage:'node-enter'|'node-exec',command:string[],source:NodeJS.ProcessEnv=process.env){
 let stdinKind='unknown';try{const info=fstatSync(0);stdinKind=info.isFile()?'file':info.isSocket()?'socket':info.isFIFO()?'pipe':info.isCharacterDevice()?'character':'other';}catch{}
 const envNames=Object.keys(source).filter(name=>/^[A-Za-z_][A-Za-z0-9_]{0,95}$/.test(name)).sort().slice(0,96);
 const executable=basename(command[0]??'');
 const record={stage,timestamp:new Date().toISOString(),pid:process.pid,ppid:process.ppid,cwd:process.cwd().slice(0,512),stdinKind,envNames,commandHash:createHash('sha256').update(command[1]==='-c'&&executable==='bash'?command[2]??'':JSON.stringify(command)).digest('hex'),argv0basename:/^[A-Za-z0-9_.-]{1,64}$/.test(executable)?executable:'unknown'};
 while(Buffer.byteLength(JSON.stringify(record))>2048&&record.envNames.length)record.envNames.pop();return record;
}
function trace(stage:'node-enter'|'node-exec',command:string[]):void {
 if(process.env.HIVEMIND_GUARD_TRACE!=='1')return;
 let lock:number|undefined,file:number|undefined;
 try{
  const line=JSON.stringify(guardTraceMetadata(stage,command))+'\n';
  lock=openSync(traceLock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  file=openSync(tracePath,constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  const info=fstatSync(file);if(!info.isFile()||(info.mode&0o077)!==0||info.nlink!==1||info.size+Buffer.byteLength(line)>maxTraceBytes)return;
  writeSync(file,line);
 }catch{/* Optional diagnostics never change guard enforcement. */}
 finally{if(file!==undefined)try{closeSync(file);}catch{}if(lock!==undefined){try{closeSync(lock);}catch{}try{unlinkSync(traceLock);}catch{}}}
}
export function claudeGuardSandboxArgs(command:string[],paths:GuardPaths=CLAUDE_GUARD_PATHS):string[]{
 if(!Array.isArray(command)||command.length<1||command.length>64||!command[0]||command.some(arg=>typeof arg!=='string'||arg.includes('\0')||Buffer.byteLength(arg)>65536)||command.reduce((size,arg)=>size+Buffer.byteLength(arg),0)>262144)throw new Error('Invalid guarded command');
 const production=providerArgs('codex','unused',paths),configs=production.flatMap((arg,index)=>arg==='-c'?[arg,production[index+1]!]:[]);
 const profiles=configs.filter(arg=>arg.startsWith('permissions.hivemind='));
 if(profiles.length!==1||!/^permissions\.hivemind=\{extends=":workspace",filesystem=\{[\s\S]*\}\}$/.test(profiles[0]!))throw new Error('Guard permission profile is unavailable');
 const extra=[`${JSON.stringify(paths.home+'/.claude')}="deny"`,`${JSON.stringify(paths.home+'/.claude.json')}="deny"`,`${JSON.stringify(claudeGuardHome(paths))}="read"`].join(',');
 const profile=profiles[0]!.slice(0,-2)+','+extra+'},network={enabled=true}}';
 return ['sandbox',...configs,'-c',profile,'-P','hivemind','--','/opt/hivemind/bin/namespace-guard','--',...command];
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const input=process.argv.slice(2),command=input[0]==='--'?input.slice(1):[];
 trace('node-enter',command);
 try{
  if(input[0]!=='--')throw new Error('Invalid guarded command');
  const args=claudeGuardSandboxArgs(command);if(typeof process.execve!=='function')throw new Error('Guard execution is unavailable');
  trace('node-exec',command);
  process.execve(CODEX_SANDBOX_EXECUTABLE,[CODEX_SANDBOX_EXECUTABLE,...args],claudeGuardEnvironment(process.env));
 }catch{process.stderr.write('Hivemind protected command could not start\n');process.exitCode=125;}
}
