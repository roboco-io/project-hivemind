import {createHash} from 'node:crypto';
import {constants,openAsBlob} from 'node:fs';
import {lstat,mkdir,mkdtemp,open,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {duckdbCacheMaxBytes,duckdbCacheOrigin,duckdbCachePath} from '../duckdb-build-cache.ts';
import {extractTarArchive} from './large-artifacts.ts';
import {runProcess} from './process.ts';

const endpoint=duckdbCacheOrigin+duckdbCachePath;
const packer=fileURLToPath(new URL('./duckdb-cache-pack.py',import.meta.url));
const maxExpandedBytes=768*1024**2;
const maxEntries=50_000;
const digestPattern=/^[a-f0-9]{64}$/;
const lengthHeader='x-hivemind-cache-length';
const digestHeader='x-hivemind-cache-sha256';

interface CachePreparation {
 directory:string;
 mode:'seed'|'cold'|'warm';
 capability?:string;
 signal?:AbortSignal;
 timeoutMs?:number;
 fetchImpl?:typeof fetch;
}

function validSize(bytes:number){
 return Number.isSafeInteger(bytes)&&bytes>0&&bytes<=duckdbCacheMaxBytes;
}

async function downloadCache(response:Response,archive:string,signal:AbortSignal) {
 const length=response.headers.get(lengthHeader)??'';
 const sizeBytes=Number(length);
 const sha256=response.headers.get(digestHeader)??'';
 const encoding=response.headers.get('content-encoding');
 const contentLength=response.headers.get('content-length');
 if(response.status!==200||!response.body||!/^[1-9][0-9]*$/.test(length)||!validSize(sizeBytes)||
    !digestPattern.test(sha256)||(encoding!==null&&encoding!=='identity')||
    (contentLength!==null&&contentLength!==length)){
  await response.body?.cancel().catch(()=>{});
  throw Error('R2 DuckDB cache response rejected');
 }
 const reader=response.body.getReader();
 const cancel=()=>{void reader.cancel().catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try {
  const file=await open(archive,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
   const hash=createHash('sha256');let total=0;
   while(true){
    signal.throwIfAborted();
    const part=await reader.read();
    signal.throwIfAborted();
    if(part.done)break;
    total+=part.value.byteLength;
    if(total>sizeBytes)throw Error('R2 DuckDB cache exceeds declared size');
    hash.update(part.value);
    let offset=0;
    while(offset<part.value.byteLength){
     const {bytesWritten}=await file.write(part.value,offset,part.value.byteLength-offset);
     if(!bytesWritten)throw Error('DuckDB cache archive write failed');
     offset+=bytesWritten;
    }
   }
   if(total!==sizeBytes||hash.digest('hex')!==sha256)throw Error('R2 DuckDB cache integrity mismatch');
  } finally {await file.close();}
 } finally {
  signal.removeEventListener('abort',cancel);
  await reader.cancel().catch(()=>{});
  reader.releaseLock();
 }
 return {sizeBytes,sha256};
}

export async function prepareDuckdbCache(options:CachePreparation) {
 const {mode,capability,timeoutMs=600_000,fetchImpl=fetch}=options;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3_600_000)throw Error('Invalid DuckDB cache deadline');
 if(mode!=='cold'&&(typeof capability!=='string'||!/^hma_[a-f0-9]{64}$/.test(capability)))throw Error('Invalid DuckDB cache capability');
 const directory=resolve(options.directory);
 const info=await lstat(directory);
 if(!info.isDirectory()||(await readdir(directory)).length)throw Error('DuckDB cache requires an empty directory');
 const cacheDir=join(directory,'cache');
 const headers={authorization:'Bearer '+capability};
 const deadline=()=>options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
 const cleanup=()=>rm(cacheDir,{force:true,recursive:true});

 async function publish(){
  if(mode!=='seed')throw Error('Only a seed job may publish a DuckDB cache');
  const started=performance.now(),signal=deadline();
  signal.throwIfAborted();
  const stage=await mkdtemp(join(directory,'.publish-'));
  try{
   const archive=join(stage,'payload.tgz');
   const result=await runProcess(['python3',packer,cacheDir,archive,String(duckdbCacheMaxBytes),String(maxExpandedBytes),String(maxEntries)],{
    cwd:stage,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},timeoutMs,signal,maxBytes:2048,
   });
   if(result.status!=='passed')throw Error('DuckDB cache archive rejected');
   const {sizeBytes,sha256}=JSON.parse(result.stdout) as {sizeBytes:number;sha256:string};
   const body=await openAsBlob(archive);
   if(!validSize(sizeBytes)||body.size!==sizeBytes||!digestPattern.test(sha256))
    throw Error('DuckDB cache archive rejected');
   const response=await fetchImpl(endpoint,{method:'PUT',headers:{...headers,
    'content-type':'application/octet-stream','content-length':String(sizeBytes),[lengthHeader]:String(sizeBytes),[digestHeader]:sha256,
   },body,signal,redirect:'error'});
   await response.body?.cancel().catch(()=>{});
   if(!response.ok)throw Error('R2 DuckDB cache publication failed: HTTP '+response.status);
   return {sha256,sizeBytes,durationMs:Math.round(performance.now()-started)};
  } finally {await rm(stage,{force:true,recursive:true});}
 }
 if(mode!=='warm'){
  options.signal?.throwIfAborted();
  await mkdir(cacheDir,{mode:0o700});
  return {cacheDir,restoreMs:0,restoredSha256:undefined,restoredBytes:undefined,publish,cleanup};
 }
 const started=performance.now(),signal=deadline();
 signal.throwIfAborted();
 const stage=await mkdtemp(join(directory,'.restore-'));
 try{
  const archive=join(stage,'payload.tgz');
  const response=await fetchImpl(endpoint,{method:'GET',headers,signal,redirect:'error'});
  const {sha256,sizeBytes}=await downloadCache(response,archive,signal);
  await extractTarArchive(archive,cacheDir,{maxBytes:maxExpandedBytes,maxFiles:maxEntries,timeoutMs,signal});
  return {cacheDir,restoreMs:Math.round(performance.now()-started),restoredSha256:sha256,restoredBytes:sizeBytes,publish,cleanup};
 } catch {
  // extractTarArchive removes its own partial output if extraction fails.
  throw Error(signal.aborted?'DuckDB cache restoration cancelled':'DuckDB cache restoration failed');
 } finally {await rm(stage,{force:true,recursive:true});}
}
