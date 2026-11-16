import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdir,mkdtemp,lstat,rm,writeFile,opendir,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareLargeArtifacts,type ArtifactRef} from '../../src/runtime/large-artifacts.ts';

const CHUNK_BYTES=64*1024;
const origin='https://hivemind-artifacts.invalid';
const expected={
 source:{sha256:'2e1a219620dd1ca6bf055600417bdf9a1700e04c5c1ff41e4029752595137785',sizeBytes:98302940,expandedBytes:260659090,files:14010},
 data:{sha256:'bc49ea1aa6dc112aa79a27e5ca02fa802542cacd00943dc6f1dfc8148ffde8c0',sizeBytes:8158982144},
};
export interface FileArtifact {name:'source'|'data';path:string;sha256:string;sizeBytes:number}
interface RequestEvidence {name:'source'|'data';expectedBytes:number;servedBytes:number;reads:number;maxChunkBytes:number;maxConcurrentReads:number;closed:boolean;servedSha256?:string}
interface TransportEvidence {chunkBytes:number;highWaterMark:number;requests:RequestEvidence[]}

/** Local fake HTTP. It never opens a network connection or uses an actual token. */
export function createFileBackedArtifactFetch(files:FileArtifact[],capability:string):{fetch:typeof fetch;stats:TransportEvidence}{
 const records=new Map(files.map(file=>[file.sha256,file]));
 if(records.size!==files.length||files.some(file=>!['source','data'].includes(file.name)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.sizeBytes)||file.sizeBytes<1||file.sizeBytes>8*1024**3))throw Error('Invalid local artifact fixture');
 const stats:TransportEvidence={chunkBytes:CHUNK_BYTES,highWaterMark:0,requests:[]};
 const fetchImpl:typeof fetch=async(input,init)=>{
  let url:URL;
  try{url=new URL(input instanceof Request?input.url:String(input));}catch{throw Error('Local artifact request rejected');}
  const headers=new Headers(init?.headers),method=init?.method??'GET',file=records.get(url.pathname.slice(1));
  if(url.origin!==origin||url.username||url.password||url.search||url.hash||method!=='GET'||init?.redirect!=='error'||headers.get('authorization')!=='Bearer '+capability||!file||url.pathname!=='/'+file.sha256||!init?.signal)throw Error('Local artifact request rejected');
  const signal=init.signal;if(signal.aborted)throw Error('Local artifact request cancelled');
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let initial;
  try{initial=await handle.stat({bigint:true});if(!initial.isFile()||initial.size!==BigInt(file.sizeBytes))throw Error('Local artifact input mismatch');}catch(error){await handle.close();throw error;}
  const first=initial;
  const evidence:RequestEvidence={name:file.name,expectedBytes:file.sizeBytes,servedBytes:0,reads:0,maxChunkBytes:0,maxConcurrentReads:0,closed:false};stats.requests.push(evidence);
  const digest=createHash('sha256');let active=0,closing:Promise<void>|undefined,controllerRef:{error(reason?:unknown):void}|undefined;
  const close=()=>closing??=(async()=>{signal.removeEventListener('abort',abort);await handle.close();evidence.closed=true;})();
  const abort=()=>{try{controllerRef?.error(Error('Local artifact request cancelled'));}catch{}void close().catch(()=>{});};
  const body=new ReadableStream<Uint8Array>({
   type:'bytes',
   start(controller){controllerRef=controller;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();},
   async pull(controller){
    if(signal.aborted){abort();return;}
    active++;evidence.maxConcurrentReads=Math.max(evidence.maxConcurrentReads,active);
    try{
     // A new 64KiB buffer is allocated only for a consumer pull. No count-based
     // Readable.toWeb conversion or eager producer loop can queue the 8GiB file.
     const bytes=new Uint8Array(CHUNK_BYTES);
     const part=await handle.read(bytes,0,bytes.length,evidence.servedBytes);evidence.reads++;
     if(signal.aborted)throw Error('Local artifact request cancelled');
     if(!part.bytesRead){
      const after=await handle.stat({bigint:true});
      if(after.size!==first.size||after.mtimeNs!==first.mtimeNs||after.ino!==first.ino||after.dev!==first.dev||evidence.servedBytes!==file.sizeBytes)throw Error('Local artifact input changed');
      evidence.servedSha256=digest.digest('hex');await close();controller.close();return;
     }
     evidence.servedBytes+=part.bytesRead;if(evidence.servedBytes>file.sizeBytes)throw Error('Local artifact input changed');
     evidence.maxChunkBytes=Math.max(evidence.maxChunkBytes,part.bytesRead);
     const chunk=bytes.subarray(0,part.bytesRead);digest.update(chunk);controller.enqueue(chunk);
    }catch{await close().catch(()=>{});try{controller.error(Error(signal.aborted?'Local artifact request cancelled':'Local artifact stream failed'));}catch{}}
    finally{active--;}
   },
   async cancel(){await close();},
  },{highWaterMark:0});
  return new Response(body,{status:200,headers:{'content-type':'application/octet-stream','content-length':String(file.sizeBytes)}});
 };
 return {fetch:fetchImpl,stats};
}

async function countSourceTree(root:string,signal:AbortSignal){
 let files=0,bytes=0,entries=0;const pending=[root];
 while(pending.length){
  signal.throwIfAborted();const directory=await opendir(pending.pop()!);
  for await(const entry of directory){
   signal.throwIfAborted();if(++entries>100000)throw Error('Source tree limit exceeded');
   const path=join(directory.path,entry.name);if(entry.isSymbolicLink())throw Error('Source tree link rejected');
   if(entry.isDirectory())pending.push(path);
   else if(entry.isFile()){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Source tree entry changed');files++;bytes+=info.size;if(bytes>2*1024**3)throw Error('Source tree limit exceeded');}
   else throw Error('Source tree entry rejected');
  }
 }
 return {files,expandedBytes:bytes,entries};
}
async function hashFile(path:string,signal:AbortSignal){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const hash=createHash('sha256');let bytes=0;
 try{const chunk=Buffer.alloc(CHUNK_BYTES);while(true){signal.throwIfAborted();const part=await file.read(chunk,0,chunk.length,null);if(!part.bytesRead)break;hash.update(chunk.subarray(0,part.bytesRead));bytes+=part.bytesRead;if(bytes>8*1024**3)throw Error('Readback exceeds data limit');}return {bytes,sha256:hash.digest('hex')};}
 finally{await file.close();}
}

export async function runLocalProof(args:string[]){
 const [sourceArg,dataArg,outputArg]=args;
 if(args.length!==3||!sourceArg||!dataArg||!outputArg)throw Error('Usage: local-proof.ts SOURCE_TAR_GZ SF30_DATABASE OUTPUT_DIRECTORY');
 const source=resolve(sourceArg),data=resolve(dataArg),output=resolve(outputArg);
 const sourceInfo=await lstat(source),dataInfo=await lstat(data);
 if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.size!==expected.source.sizeBytes||!dataInfo.isFile()||dataInfo.isSymbolicLink()||dataInfo.size!==expected.data.sizeBytes)throw Error('Expected pinned DuckDB artifact files are missing or have different sizes');
 await mkdir(output,{recursive:true,mode:0o700});const info=await lstat(output);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Output directory must not be a symlink');
 const disk=await statfs(output);const needed=expected.data.sizeBytes+expected.source.sizeBytes+4*1024**3;if(disk.bavail*disk.bsize<needed)throw Error('Insufficient space for owned proof copy and reserve');
 const recordRoot=await mkdtemp(join(output,'local-proof-'));const work=join(recordRoot,'work');
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)]);
 const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const before=process.resourceUsage(),startedAt=Date.now();let rssPeak=process.memoryUsage().rss;
 const rssTimer=setInterval(()=>{rssPeak=Math.max(rssPeak,process.memoryUsage().rss);},100);rssTimer.unref();
 // Deliberately fake, restricted to the in-process transport. Never persisted.
 const capability='hma_'+'f'.repeat(64);
 const transport=createFileBackedArtifactFetch([{name:'source',path:source,sha256:expected.source.sha256,sizeBytes:expected.source.sizeBytes},{name:'data',path:data,sha256:expected.data.sha256,sizeBytes:expected.data.sizeBytes}],capability);
 const refs:ArtifactRef[]=[{name:'source',sha256:expected.source.sha256,sizeBytes:expected.source.sizeBytes,format:'tar.gz',expandedBytes:2*1024**3,maxFiles:100000},{name:'data',sha256:expected.data.sha256,sizeBytes:expected.data.sizeBytes,format:'file',expandedBytes:expected.data.sizeBytes,maxFiles:1}];
 const evidence:any={version:1,kind:'local-fake-http-artifact-pipeline',success:false,startedAt,inputs:refs,transport:transport.stats,notValidated:['Cloudflare/R2 network or persistence','native sandbox read-only boundary'],cleanup:{ownedWorkRemoved:false}};
 try{
  const prepared=await prepareLargeArtifacts({refs,capability},{directory:work,signal,timeoutMs:1200000,fetchImpl:transport.fetch});
  if(!prepared.paths.source||!prepared.paths.data)throw Error('Prepared paths missing');
  evidence.preparation={durationMs:prepared.durationMs,receipts:prepared.receipts};
  const treeStarted=Date.now(),tree=await countSourceTree(prepared.paths.source,signal);evidence.extractedSource={...tree,verificationMs:Date.now()-treeStarted};
  if(tree.files!==expected.source.files||tree.expandedBytes!==expected.source.expandedBytes)throw Error('Extracted source proof mismatch');
  const dataStarted=Date.now(),readback=await hashFile(prepared.paths.data,signal);evidence.dataReadback={...readback,verificationMs:Date.now()-dataStarted};
  if(readback.bytes!==expected.data.sizeBytes||readback.sha256!==expected.data.sha256)throw Error('Data readback proof mismatch');
  if(transport.stats.requests.length!==2||transport.stats.requests.some(r=>r.servedBytes!==expected[r.name].sizeBytes||r.servedSha256!==expected[r.name].sha256||r.maxChunkBytes>CHUNK_BYTES||r.maxConcurrentReads!==1||!r.closed))throw Error('Bounded transport proof mismatch');
  const dataReceipt=prepared.receipts.find(r=>r.name==='data'),sourceReceipt=prepared.receipts.find(r=>r.name==='source');
  if(dataReceipt?.files!==1||dataReceipt.expandedBytes!==expected.data.sizeBytes||sourceReceipt?.files!==expected.source.files||sourceReceipt.expandedBytes!==expected.source.expandedBytes)throw Error('Preparation receipt mismatch');
  evidence.success=true;
 }catch{evidence.failure=signal.aborted?'cancelled-or-deadline':'artifact-proof-failed';}
 finally{
  clearInterval(rssTimer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  try{await rm(work,{recursive:true,force:true});evidence.cleanup.ownedWorkRemoved=true;}catch{evidence.success=false;evidence.failure='owned-work-cleanup-failed';}
  const usage=process.resourceUsage();rssPeak=Math.max(rssPeak,process.memoryUsage().rss);
  evidence.finishedAt=Date.now();evidence.durationMs=evidence.finishedAt-startedAt;evidence.resources={scope:'Node process only; use external time -l for its separate native measurement',sampledRssPeakBytes:rssPeak,maxRSSKiB:usage.maxRSS,cpuUserMicros:usage.userCPUTime-before.userCPUTime,cpuSystemMicros:usage.systemCPUTime-before.systemCPUTime};
  await writeFile(join(recordRoot,'receipt.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600,flag:'wx'});
 }
 console.log(JSON.stringify({success:evidence.success,kind:evidence.kind,receipt:join(recordRoot,'receipt.json'),durationMs:evidence.durationMs,ownedWorkRemoved:evidence.cleanup.ownedWorkRemoved}));
 if(!evidence.success)throw Error('Local artifact proof did not pass');
 return evidence;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 runLocalProof(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error&&error.message.startsWith('Usage:')?error.message:'Local artifact proof failed; inspect the local receipt.');process.exitCode=1;});
}
