import {constants} from 'node:fs';
import {open,lstat,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readSnapshot,restoreSnapshot} from '../files.ts';
import {validateSnapshot,excludedSourcePath} from '../snapshot.ts';
import type {Snapshot} from '../contracts.ts';
export interface AutonomousSessionBundle {version:1;sessionId:string;model:string;workspacePath:'/workspace';snapshot:Snapshot;transcripts:{path:string;content:string}[]}
export interface AutonomousSessionPaths {home:string;workspace:string}
export const sessionUUID=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(x);
export function rejectSessionSecrets(bytes:Buffer|string,secrets:string[]=[]):void{
 const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
 if(/sk-ant-(?:oat01|api03)-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]{16,}/.test(b.toString())||secrets.some(s=>s&&b.includes(Buffer.from(s))))throw Error('Private material is not permitted in session bundle');
}
export function validateAutonomousSession(value:unknown,sessionId:string,model:string,secrets:string[]=[]):AutonomousSessionBundle{
 const b=value as AutonomousSessionBundle;
 if(!b||Object.keys(b).sort().join(',')!=='model,sessionId,snapshot,transcripts,version,workspacePath'||!sessionUUID(sessionId)||b.version!==1||b.sessionId!==sessionId||b.model!==model||b.workspacePath!=='/workspace'||!Array.isArray(b.transcripts)||!b.transcripts.length||b.transcripts.length>65||Buffer.byteLength(JSON.stringify(b))>11*1024*1024)throw Error('Invalid private session bundle');
 const snapshot=validateSnapshot(b.snapshot);for(const f of snapshot.files)rejectSessionSecrets(Buffer.from(f.content,'base64'),secrets);
 const seen=new Set<string>();let bytes=0;
 for(const t of b.transcripts){if(!t||Object.keys(t).sort().join(',')!=='content,path'||typeof t.path!=='string'||!(t.path===sessionId+'.jsonl'||new RegExp('^'+sessionId+'/subagents/agent-[A-Za-z0-9_-]{1,128}\\.jsonl$').test(t.path))||seen.has(t.path)||typeof t.content!=='string')throw Error('Invalid private transcript');seen.add(t.path);bytes+=Buffer.byteLength(t.content);if(bytes>4*1024*1024)throw Error('Transcript limit');rejectSessionSecrets(t.content,secrets);for(const line of t.content.split('\n').filter(Boolean)){try{const v=JSON.parse(line);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();}catch{throw Error('Invalid transcript JSONL');}}}
 if(!seen.has(sessionId+'.jsonl'))throw Error('Missing parent transcript');return {...b,snapshot};
}
export function autonomousProjectDirectory(home:string):string{return join(home,'.claude','projects','-workspace');}
async function safeDirectory(path:string,create=false):Promise<void>{
 let current='/';for(const part of resolve(path).split('/').filter(Boolean)){current=join(current,part);if(create)await mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe session directory');}
}
async function readTranscript(root:string,path:string,limit:number):Promise<string>{
 await safeDirectory(join(root,...path.split('/').slice(0,-1)));const f=await open(join(root,path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await f.stat({bigint:true});if(!s.isFile()||s.nlink!==1n||s.size>BigInt(limit))throw Error('Unsafe transcript file');const chunks:Buffer[]=[];let bytes=0;
 while(true){const buffer=Buffer.alloc(Math.min(65536,limit-bytes+1)),part=await f.read(buffer,0,buffer.length,null);if(!part.bytesRead)break;bytes+=part.bytesRead;if(bytes>limit)throw Error('Transcript limit');chunks.push(buffer.subarray(0,part.bytesRead));}
 const after=await f.stat({bigint:true}),current=await lstat(join(root,path),{bigint:true});if(s.ino!==after.ino||s.dev!==after.dev||s.size!==after.size||s.mtimeNs!==after.mtimeNs||s.ctimeNs!==after.ctimeNs||current.isSymbolicLink()||current.ino!==after.ino||current.dev!==after.dev)throw Error('Transcript changed');
 return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}finally{await f.close();}
}
export async function collectAutonomousSession(paths:AutonomousSessionPaths,sessionId:string,model:string,secrets:string[]=[]):Promise<AutonomousSessionBundle>{
 if(!sessionUUID(sessionId))throw Error('Invalid session');const root=autonomousProjectDirectory(paths.home),transcripts=[{path:sessionId+'.jsonl',content:await readTranscript(root,sessionId+'.jsonl',4*1024*1024)}];
 const children=join(root,sessionId,'subagents');let names:string[]=[];try{await safeDirectory(children);names=await readdir(children);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 // Claude Code 2.1.319 writes agent-<id>.meta.json (and may write other agent-<id>.<kind>.json) beside each subagent
 // transcript. They are CLI metadata, not transcripts: skip regular files of that exact form, never bundle them.
 if(names.length>256)throw Error('Transcript count limit');
 const sidecar=/^agent-[A-Za-z0-9_-]{1,128}(?:\.[a-z][a-z-]{0,31}){1,2}\.json$/;
 const kept:string[]=[];for(const name of names){if(sidecar.test(name)){const s=await lstat(join(children,name));if(!s.isFile()||s.isSymbolicLink())throw Error('Unexpected subagent file');continue;}kept.push(name);}
 if(kept.length>64)throw Error('Transcript count limit');
 let remaining=4*1024*1024-Buffer.byteLength(transcripts[0]!.content);for(const name of kept){if(!/^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(name))throw Error('Unexpected subagent file');const path=sessionId+'/subagents/'+name;const content=await readTranscript(root,path,remaining);remaining-=Buffer.byteLength(content);transcripts.push({path,content});}
 // readSnapshot excludes private source paths; reject hardlinks independently before reading.
 const entries=new Map<string,string>();
 const fingerprint=(s:Awaited<ReturnType<typeof lstat>>)=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
 const walk=async(dir:string,verify=false):Promise<void>=>{for(const name of await readdir(dir)){if(excludedSourcePath(name))continue;const full=join(dir,name),s=await lstat(full);if(s.isSymbolicLink()||!s.isDirectory()&&(!s.isFile()||s.nlink!==1))throw Error('Unsafe workspace entry');
  if(verify){if(entries.get(full)!==fingerprint(s))throw Error('Workspace changed during collection');entries.delete(full);}else entries.set(full,fingerprint(s));
  if(s.isDirectory())await walk(full,verify);}};
 await walk(paths.workspace);const snapshot=await readSnapshot(paths.workspace);await walk(paths.workspace,true);if(entries.size)throw Error('Workspace changed during collection');
 return validateAutonomousSession({version:1,sessionId,model,workspacePath:'/workspace',snapshot,transcripts},sessionId,model,secrets);
}
export async function restoreAutonomousSession(value:unknown,paths:AutonomousSessionPaths,sessionId:string,model:string,secrets:string[]=[]):Promise<void>{
 const bundle=validateAutonomousSession(value,sessionId,model,secrets),root=autonomousProjectDirectory(paths.home);await safeDirectory(root,true);
 for(const t of bundle.transcripts){const destination=join(root,t.path);await safeDirectory(join(destination,'..'),true);const file=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(t.content);}finally{await file.close();}}
 await restoreSnapshot(paths.workspace,bundle.snapshot);
}
