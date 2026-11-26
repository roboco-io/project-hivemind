import {constants} from 'node:fs';
import {open,lstat,link,unlink,realpath} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPublicKey,randomUUID} from 'node:crypto';
import {AUTONOMOUS_CLOUD_MAX_BYTES,validateAutonomousCloudInput,validateAutonomousCloudOutput} from '../autonomous-cloud-protocol.ts';
import type {AutonomousCloudOutput} from '../autonomous-cloud-protocol.ts';
import {executeAutonomousClaude} from './autonomous-claude.ts';
import type {AutonomousClaudeOptions} from './autonomous-claude.ts';
import {createNativeHttpAuthorizer} from './autonomous-authorize.ts';
import {createNativeHttpReporter} from './autonomous-reporter.ts';
import {sealAuth} from '../../../scripts/phase0/auth-envelope.ts';
export const NATIVE_FILES={input:'autonomous-input.json',started:'autonomous-started.json',result:'autonomous-result.json',resultReady:'autonomous-result.ready',cancel:'autonomous-cancel'} as const;
async function privateDirectory(path:string){
 const parent=dirname(path),directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{
  const before=await directory.stat({bigint:true});
  if(!before.isDirectory()||(before.mode&0o022n))throw Error('Unsafe native directory');
  const check=async()=>{const current=await lstat(parent,{bigint:true});if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||(current.mode&0o022n))throw Error('Native directory changed');};
  await check();
  // Linux production uses the open directory descriptor even if a pathname is raced.
  const root=process.platform==='linux'?`/proc/self/fd/${directory.fd}`:await realpath(parent);
  return {directory,root,check};
 }catch(error){await directory.close();throw error;}
}
export async function readNativePrivate(path:string):Promise<unknown>{
 const parent=await privateDirectory(path);let f:FileHandle|undefined;
 try{
  const anchored=join(parent.root,basename(path));f=await open(anchored,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await f.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||(before.mode&0o777n)!==0o600n||before.size>BigInt(AUTONOMOUS_CLOUD_MAX_BYTES))throw Error('Unsafe native file');
  const data=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<data.length){const read=await f.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw Error('Native file changed');offset+=read.bytesRead;}
  if((await f.read(Buffer.alloc(1),0,1,offset)).bytesRead)throw Error('Native file changed');
  const after=await f.stat({bigint:true}),named=await lstat(anchored,{bigint:true});
  if(['dev','ino','size','mode','uid','nlink','mtimeNs','ctimeNs'].some(k=>before[k as keyof typeof before]!==after[k as keyof typeof after])||named.dev!==after.dev||named.ino!==after.ino||!named.isFile())throw Error('Native file changed');
  await parent.check();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
 }finally{await f?.close();await parent.directory.close();}
}
export async function writeNativePrivate(path:string,value:unknown):Promise<void>{
 const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>AUTONOMOUS_CLOUD_MAX_BYTES)throw Error('Native file too large');
 const parent=await privateDirectory(path),temporary=join(parent.root,`.native-${randomUUID()}.pending`),final=join(parent.root,basename(path));let f:FileHandle|undefined;
 try{
  f=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await f.writeFile(bytes);await f.sync();await parent.check();
  const written=await f.stat({bigint:true}),named=await lstat(temporary,{bigint:true});if(written.ino!==named.ino||written.dev!==named.dev||!named.isFile()||named.nlink!==1n)throw Error('Native file changed');
  await link(temporary,final);await unlink(temporary);await parent.directory.sync();await parent.check();
 }finally{await f?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});await parent.directory.close();}
}
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{const abort=()=>reject(Error('Native execution aborted'));signal.addEventListener('abort',abort,{once:true});work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
}
/** The empty exclusive marker is created only after immutable result publication and fsync. */
async function markNativeResultReady(runtimeDir:string):Promise<void>{
 const parent=await privateDirectory(join(runtimeDir,NATIVE_FILES.resultReady));let f:FileHandle|undefined;
 try{f=await open(join(parent.root,NATIVE_FILES.resultReady),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await f.sync();await parent.directory.sync();await parent.check();}
 finally{await f?.close();await parent.directory.close();}
}
export async function nativeResultReady(runtimeDir:string):Promise<boolean>{
 let parent:Awaited<ReturnType<typeof privateDirectory>>|undefined,f:FileHandle|undefined;
 try{
  parent=await privateDirectory(join(runtimeDir,NATIVE_FILES.resultReady));f=await open(join(parent.root,NATIVE_FILES.resultReady),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const marker=await f.stat();if(!marker.isFile()||marker.nlink!==1||(marker.mode&0o777)!==0o600||marker.size!==0)throw Error('Unsafe native completion marker');
  await parent.check();return true;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 finally{await f?.close();await parent?.directory.close();}
}
export interface AutonomousFromFileOptions {execute?:typeof executeAutonomousClaude;pollMs?:number;signal?:AbortSignal}
/** Explicit one-shot entry point. Existing intent is never replayed, even after a crash. */
export async function runAutonomousFromFile(runtimeDir='/runtime',options:AutonomousFromFileOptions={}):Promise<AutonomousCloudOutput|undefined>{
 const dir=await lstat(runtimeDir);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o022))throw Error('Unsafe native directory');
 const file=(name:string)=>join(runtimeDir,name);const input=validateAutonomousCloudInput(await readNativePrivate(file(NATIVE_FILES.input)));
 try{await writeNativePrivate(file(NATIVE_FILES.started),{version:1,jobId:input.jobId,attempt:input.attempt,runtimeId:input.runtimeId});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return undefined;throw e;}
 let result:AutonomousCloudOutput={version:1,jobId:input.jobId,attempt:input.attempt,ok:false,errorCode:'NATIVE_EXECUTION_FAILED'};
 const lifecycle=new AbortController();let timer:ReturnType<typeof setInterval>|undefined;
 try{
  // Validate RSA and seal before any executor or model call. No private key enters this process.
  const publicKey=createPublicKey(input.authReturnPublicKey);if(publicKey.asymmetricKeyType!=='rsa'||(publicKey.asymmetricKeyDetails?.modulusLength??0)<2048)throw Error('Invalid return key');
  result.authReturn=sealAuth(input.request.subscriptionAuth,input.authReturnPublicKey);
  const checkCancel=async()=>{try{await lstat(file(NATIVE_FILES.cancel));lifecycle.abort();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')lifecycle.abort();}};await checkCancel();
  const signal=AbortSignal.any([lifecycle.signal,AbortSignal.timeout(input.request.maxRunMs),...(options.signal?[options.signal]:[])]);signal.throwIfAborted();timer=setInterval(()=>{void checkCancel();},options.pollMs??100);
  const executorOptions:AutonomousClaudeOptions={signal,runtimeId:input.runtimeId,nestedCompatible:input.claudeNestedCompatible===true,allowWebFetch:input.allowWebFetch===true,quotaPauseEnabled:input.quotaPauseEnabled===true,...(input.request.externalProfiles?{actionChannel:{origin:input.control.origin,workerToken:input.control.workerToken}}:{}),authorizer:createNativeHttpAuthorizer({url:input.control.origin,token:input.control.workerToken}),reporter:createNativeHttpReporter({url:input.control.origin,token:input.control.reporterToken,quotaPauseEnabled:input.quotaPauseEnabled===true}),toolAudit:{url:input.control.origin,token:input.control.reporterToken},reporterSecrets:[input.control.workerToken,input.control.reporterToken,input.request.executionLease.token]};
  const response=await abortable((options.execute??executeAutonomousClaude)(input.request,executorOptions),signal);signal.throwIfAborted();
  if(response.session.sessionId!==input.request.session.sessionId||response.session.model!==input.request.model||response.session.sequence!==input.request.session.sequence+1)throw Error('Invalid native response identity');
  const serialized=JSON.stringify(response);for(const secret of [input.request.subscriptionAuth,input.control.workerToken,input.control.reporterToken,input.request.executionLease.token])if(serialized.includes(secret))throw Error('Private material in response');
  result=validateAutonomousCloudOutput({version:1,jobId:input.jobId,attempt:input.attempt,ok:true,response,authReturn:result.authReturn});
 }catch{result={version:1,jobId:input.jobId,attempt:input.attempt,ok:false,errorCode:'NATIVE_EXECUTION_FAILED',...(result.authReturn?{authReturn:result.authReturn}:{})};}
 finally{if(timer)clearInterval(timer);lifecycle.abort();}
 await writeNativePrivate(file(NATIVE_FILES.result),result);await markNativeResultReady(runtimeDir);return result;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)runAutonomousFromFile().catch(()=>{process.exitCode=1;});
