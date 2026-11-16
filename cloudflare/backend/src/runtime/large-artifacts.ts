import {createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,rename,rm,lstat,readdir,unlink,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {validateLargeArtifacts,type LargeArtifactRef} from '../large-artifact.ts';

export type ArtifactRef=LargeArtifactRef;
export interface ArtifactPreparationOptions {directory:string;signal?:AbortSignal;fetchImpl?:typeof fetch;timeoutMs?:number;pythonCommand?:string}
export interface ArchiveReceipt {expandedBytes:number;files:number;entries:number}
export interface PreparedArtifactReceipt extends ArtifactRef {files:number}
export interface PreparedArtifacts {root:string;paths:Partial<Record<'source'|'data',string>>;receipts:PreparedArtifactReceipt[];durationMs:number}
interface ExtractOptions {maxBytes:number;maxFiles:number;stripComponents?:0|1;signal?:AbortSignal;timeoutMs?:number;pythonCommand?:string}
const helper=fileURLToPath(new URL('./safe-tar.py',import.meta.url));
const origin='https://hivemind-artifacts.invalid/';
function abortSignal(signal:AbortSignal|undefined,timeoutMs=600000){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw Error('Invalid artifact deadline');
 return AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
}
function ensureActive(signal:AbortSignal){if(signal.aborted)throw Error('Large artifact preparation cancelled');}

export async function extractTarArchive(archive:string,destination:string,options:ExtractOptions):Promise<ArchiveReceipt>{
 const signal=abortSignal(options.signal,options.timeoutMs);
 if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1||options.maxBytes>2*1024**3||!Number.isSafeInteger(options.maxFiles)||options.maxFiles<1||options.maxFiles>100000||![0,1].includes(options.stripComponents??0))throw Error('Invalid archive limits');
 ensureActive(signal);
 // The caller owns the parent directory. Never overwrite or clean an existing target.
 if(await lstat(destination).then(()=>true,()=>false))throw Error('Archive destination already exists');
 const ownerToken=randomBytes(16).toString('hex');
 try{
  const receipt=await new Promise<ArchiveReceipt>((done,reject)=>{
   const child=spawn(options.pythonCommand??'python3',[helper,'--archive',resolve(archive),'--destination',resolve(destination),'--max-bytes',String(options.maxBytes),'--max-files',String(options.maxFiles),'--strip-components',String(options.stripComponents??0),'--owner-token',ownerToken],{env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
   const chunks:Buffer[]=[];let bytes=0,failed=false,settled=false;
   const stop=()=>{if(child.pid)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}};
   const fail=()=>{failed=true;stop();};
   const finish=(value?:ArchiveReceipt)=>{if(settled)return;settled=true;signal.removeEventListener('abort',fail);clearTimeout(hardTimer);value?done(value):reject(Error(signal.aborted?'Archive extraction cancelled':'Artifact archive rejected'));};
   const hardTimer=setTimeout(()=>{fail();finish();},Math.min(options.timeoutMs??600000,3600000)+2000);
   signal.addEventListener('abort',fail,{once:true});
   child.once('spawn',()=>{if(signal.aborted)fail();});
   child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>4096)fail();else chunks.push(b);});
   child.stderr.resume();
   child.once('error',()=>{failed=true;finish();});
   child.once('close',code=>{
    if(failed||signal.aborted||code!==0){finish();return;}
    let value:ArchiveReceipt;
    try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{finish();return;}
    if(Object.keys(value).sort().join(',')!=='entries,expandedBytes,files'||!Number.isSafeInteger(value.expandedBytes)||value.expandedBytes<0||value.expandedBytes>options.maxBytes||!Number.isSafeInteger(value.files)||value.files<1||value.files>options.maxFiles||!Number.isSafeInteger(value.entries)||value.entries<value.files||value.entries>options.maxFiles){finish();return;}
    finish(value);
   });
  });
  ensureActive(signal);return receipt;
 }catch{
  // A failed helper must not remove a raced-in or otherwise unowned directory.
  const marker=await open(join(destination,'.hivemind-extraction-owner'),constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>undefined);
  if(marker){let owned=false;try{const info=await marker.stat();owned=info.isFile()&&info.size===32&&(await marker.readFile('utf8'))===ownerToken;}finally{await marker.close();}if(owned)await rm(destination,{recursive:true,force:true});}
  throw Error(signal.aborted?'Archive extraction cancelled':'Artifact archive rejected');
 }
}

async function download(ref:ArtifactRef,path:string,capability:string,signal:AbortSignal,fetchImpl:typeof fetch){
 ensureActive(signal);
 let response:Response;
 try{response=await fetchImpl(origin+ref.sha256,{headers:{authorization:'Bearer '+capability},redirect:'error',signal});}catch{throw Error('Large artifact download failed');}
 if(response.status!==200||!response.body){await response.body?.cancel().catch(()=>{});throw Error('Large artifact download failed');}
 const declared=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
 if((declared!==null&&(!/^(0|[1-9][0-9]*)$/.test(declared)||Number(declared)!==ref.sizeBytes))||(encoding!==null&&encoding!=='identity')){await response.body.cancel().catch(()=>{});throw Error('Large artifact response rejected');}
 const reader=response.body.getReader();const hash=createHash('sha256');let count=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 const partial=path+'.part';let file;
 try{
  file=await open(partial,constants.O_EXCL|constants.O_NOFOLLOW|constants.O_CREAT|constants.O_WRONLY,0o600);
  while(true){
   ensureActive(signal);const part=await reader.read();ensureActive(signal);if(part.done)break;
   count+=part.value.byteLength;if(count>ref.sizeBytes)throw Error('Large artifact byte limit exceeded');
   hash.update(part.value);let offset=0;
   while(offset<part.value.length){const written=await file.write(part.value,offset,part.value.length-offset);if(!written.bytesWritten)throw Error('Large artifact write failed');offset+=written.bytesWritten;}
  }
  if(count!==ref.sizeBytes||hash.digest('hex')!==ref.sha256)throw Error('Large artifact integrity mismatch');
  await file.sync();await file.close();file=undefined;ensureActive(signal);await rename(partial,path);
 }catch{await reader.cancel().catch(()=>{});throw Error(signal.aborted?'Large artifact preparation cancelled':'Large artifact verification failed');}
 finally{signal.removeEventListener('abort',cancel);reader.releaseLock();await file?.close();await rm(partial,{force:true});}
}

export async function prepareLargeArtifacts(input:{refs:ArtifactRef[];capability:string},options:ArtifactPreparationOptions):Promise<PreparedArtifacts>{
 const started=performance.now();
 const refs=validateLargeArtifacts(input.refs);
 if(typeof input.capability!=='string'||!input.capability||input.capability.length>2048||/[\r\n\0]/.test(input.capability))throw Error('Invalid artifact capability');
 const signal=abortSignal(options.signal,options.timeoutMs);ensureActive(signal);
 const directory=resolve(options.directory);await mkdir(directory,{recursive:true,mode:0o700});
 const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Invalid artifact directory');
 if((await readdir(directory)).length)throw Error('Artifact directory must be empty');
 let lock,stage:string|undefined;
 try{
  lock=await open(join(directory,'.prepare.lock'),constants.O_EXCL|constants.O_NOFOLLOW|constants.O_CREAT|constants.O_WRONLY,0o600);
  stage=await mkdtemp(join(directory,'.stage-'));const inputs=join(stage,'inputs');await mkdir(inputs,{mode:0o700});
  const receipts:PreparedArtifactReceipt[]=[];
  for(const ref of refs){
   const destination=join(inputs,ref.name),archive=ref.format==='file'?destination:join(stage,ref.name+'.tar.gz');
   await download(ref,archive,input.capability,signal,options.fetchImpl??fetch);
   const extracted=ref.format==='tar.gz'?await extractTarArchive(archive,destination,{maxBytes:ref.expandedBytes,maxFiles:ref.maxFiles,signal,pythonCommand:options.pythonCommand,timeoutMs:options.timeoutMs}):{expandedBytes:ref.sizeBytes,files:1};
   if(ref.format==='file')await chmod(destination,0o400);else await rm(archive);
   receipts.push({...ref,expandedBytes:extracted.expandedBytes,files:extracted.files});
  }
  ensureActive(signal);const root=join(directory,'ready');await rename(inputs,root);
  return {root,paths:Object.fromEntries(refs.map(ref=>[ref.name,join(root,ref.name)])),receipts,durationMs:Math.round(performance.now()-started)};
 }catch{throw Error(signal.aborted?'Large artifact preparation cancelled':'Large artifact preparation failed');}
 finally{if(stage)await rm(stage,{recursive:true,force:true});if(lock){await lock.close();await unlink(join(directory,'.prepare.lock'));}}
}
