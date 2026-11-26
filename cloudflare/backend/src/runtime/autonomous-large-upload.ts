// Uploads large workspace files to the control plane in 8 MiB parts.
// Container runtime code: it imports no values from packages/*; the wire shapes are local types.
// The protocol steps match external-large/{begin,part,complete,abort,manifest}. `post` is
// injected and owns authentication, so this module never sees a token.
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute,join,sep} from 'node:path';
import {createHash} from 'node:crypto';

export const LARGE_PART_BYTES=8*1024*1024;
const MAX_FILE_BYTES=5*1024*1024*1024,MAX_FILES=64,HASH_CHUNK=1024*1024;
const ERROR='Large upload rejected or unavailable.';
const fail=():never=>{throw new Error(ERROR);};

export interface LargeFileSpec{path:string;size:number;sha256:string}
export interface LargeUploadedFile extends LargeFileSpec{storageRef:string}
/** Parts are numbered from 1, as in the control-plane response. */
export interface LargeBeginResult{uploadId:string;parts:{partNumber:number;sha256:string}[]}
export interface LargePost{
  (op:'begin',body:LargeFileSpec,signal?:AbortSignal):Promise<LargeBeginResult>;
  (op:'part',body:{uploadId:string;partNumber:number;data:Uint8Array},signal?:AbortSignal):Promise<unknown>;
  (op:'complete',body:{uploadId:string},signal?:AbortSignal):Promise<LargeUploadedFile>;
  (op:'abort',body:{uploadId:string},signal?:AbortSignal):Promise<unknown>;
  (op:'manifest',body:{files:LargeUploadedFile[]},signal?:AbortSignal):Promise<{manifestDigest:string}>;
}

function checkRelative(p:unknown):string{
  if(typeof p!=='string'||p.length===0||p.length>1024||isAbsolute(p)||/[\p{Cc}\\]/u.test(p))return fail();
  if(!p.split('/').every(s=>s.length>0&&s!=='.'&&s!=='..'))return fail();
  return p;
}

interface Opened{handle:FileHandle;size:number;parts:string[];sha256:string;ino:bigint;dev:bigint}

async function openChecked(rootReal:string,path:string,signal?:AbortSignal):Promise<Opened>{
  const full=join(rootReal,path);
  // The path itself may not be a symlink, and its real location must stay under the root
  // (this also catches symlinked parent directories).
  const named=await lstat(full,{bigint:true});
  if(named.isSymbolicLink()||!named.isFile())fail();
  const real=await realpath(full);
  if(real!==full||!real.startsWith(rootReal+sep))fail();
  const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await handle.stat({bigint:true});
    if(!info.isFile()||info.nlink!==1n||info.ino!==named.ino||info.dev!==named.dev||info.size<1n||info.size>BigInt(MAX_FILE_BYTES))fail();
    const size=Number(info.size);
    // One streaming pass: whole-file hash plus one hash per part.
    const file=createHash('sha256'),parts:string[]=[];let part=createHash('sha256'),inPart=0,position=0;
    const buffer=Buffer.allocUnsafe(HASH_CHUNK);
    while(position<size){
      signal?.throwIfAborted();
      const {bytesRead}=await handle.read(buffer,0,Math.min(HASH_CHUNK,size-position),position);
      if(bytesRead===0)fail();
      file.update(buffer.subarray(0,bytesRead));part.update(buffer.subarray(0,bytesRead));position+=bytesRead;inPart+=bytesRead;
      if(inPart===LARGE_PART_BYTES){parts.push(part.digest('hex'));part=createHash('sha256');inPart=0;}
    }
    if(inPart>0)parts.push(part.digest('hex'));
    const after=await handle.stat({bigint:true});
    if(after.size!==info.size||after.mtimeNs!==info.mtimeNs)fail();
    return {handle,size,parts,sha256:file.digest('hex'),ino:info.ino,dev:info.dev};
  }catch(error){await handle.close();throw error;}
}

export async function uploadWorkspaceFiles(o:{root:string;paths:string[];post:LargePost;signal?:AbortSignal}):Promise<{manifestDigest:string}>{
  const {post,signal}=o;
  if(typeof o.root!=='string'||!isAbsolute(o.root)||!Array.isArray(o.paths)||o.paths.length<1||o.paths.length>MAX_FILES)fail();
  const paths=o.paths.map(checkRelative);
  if(new Set(paths).size!==paths.length)fail();
  signal?.throwIfAborted();
  const rootReal=await realpath(o.root);
  if(!(await lstat(rootReal)).isDirectory())fail();
  // Validate every file before the first request so a bad path cannot leave partial uploads.
  const opened:{path:string;file:Opened}[]=[];
  const uploaded:LargeUploadedFile[]=[];
  try{
    for(const path of paths)opened.push({path,file:await openChecked(rootReal,path,signal)});
    for(const {path,file} of opened){
      signal?.throwIfAborted();
      const begin=await post('begin',{path,size:file.size,sha256:file.sha256},signal);
      if(!begin||typeof begin.uploadId!=='string'||!Array.isArray(begin.parts))fail();
      const stored=new Map(begin.parts.map(p=>[p.partNumber,p.sha256]));
      for(let partNumber=1;partNumber<=file.parts.length;partNumber++){
        signal?.throwIfAborted();
        const offset=(partNumber-1)*LARGE_PART_BYTES;
        if(stored.get(partNumber)===file.parts[partNumber-1])continue;
        const length=Math.min(LARGE_PART_BYTES,file.size-offset);
        const data=Buffer.allocUnsafe(length);let read=0;
        while(read<length){const {bytesRead}=await file.handle.read(data,read,length-read,offset+read);if(bytesRead===0)fail();read+=bytesRead;}
        // The file changed since it was hashed: do not send bytes that disagree with begin().
        if(createHash('sha256').update(data).digest('hex')!==file.parts[partNumber-1])fail();
        await post('part',{uploadId:begin.uploadId,partNumber,data},signal);
      }
      signal?.throwIfAborted();
      const done=await post('complete',{uploadId:begin.uploadId},signal);
      if(done.path!==path||done.size!==file.size||done.sha256!==file.sha256||typeof done.storageRef!=='string')fail();
      uploaded.push({path,size:done.size,sha256:done.sha256,storageRef:done.storageRef});
    }
    signal?.throwIfAborted();
    const manifest=await post('manifest',{files:uploaded},signal);
    if(typeof manifest.manifestDigest!=='string'||!/^[a-f0-9]{64}$/.test(manifest.manifestDigest))fail();
    return {manifestDigest:manifest.manifestDigest};
  }finally{await Promise.allSettled(opened.map(x=>x.file.handle.close()));}
}

/**
 * HTTP binding of the external-large routes. Authentication and the approved owner (lease, runtimeId, profileId) live
 * here, so uploadWorkspaceFiles never sees a token. JSON steps carry the owner in the body; the binary part request
 * carries it as JSON in the x-large-meta header. Every response is bounded and must be JSON from the same URL.
 */
export function createLargePost(o:{origin:string;workerToken:string;taskId:string;lease:unknown;runtimeId:string;profileId:string;fetchImpl?:typeof fetch;now?:()=>number;deadline?:number}):LargePost{
  const origin=new URL(o.origin);
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!['https:','http:'].includes(origin.protocol)||origin.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))fail();
  if(typeof o.workerToken!=='string'||!o.workerToken||o.workerToken.length>4096||/[\s\p{Cc}]/u.test(o.workerToken)||!/^[A-Za-z0-9_-]{1,128}$/.test(o.taskId))fail();
  const fetcher=o.fetchImpl??fetch,base=`${origin.origin}/v1/autonomous-tasks/${encodeURIComponent(o.taskId)}/external-large/`,owner={lease:o.lease,runtimeId:o.runtimeId,profileId:o.profileId};
  const MAX_RESPONSE=65536;
  async function send(op:string,init:{headers:Record<string,string>;body:string|Uint8Array},signal?:AbortSignal):Promise<any>{
    signal?.throwIfAborted();
    const url=base+op,response=await fetcher(url,{method:'POST',headers:{authorization:'Bearer '+o.workerToken,accept:'application/json',...init.headers},body:init.body as BodyInit,redirect:'error',...(signal?{signal}:{})});
    if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body){void response.body?.cancel().catch(()=>{});return fail();}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>MAX_RESPONSE){await reader.cancel();return fail();}chunks.push(item.value);}}finally{reader.releaseLock();}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return fail();}
  }
  const json=(op:string,body:object,signal?:AbortSignal)=>send(op,{headers:{'content-type':'application/json'},body:JSON.stringify({...owner,...body})},signal);
  return (async(op:string,body:any,signal?:AbortSignal)=>{
    try{
      if(o.deadline!==undefined&&(o.now??Date.now)()>=o.deadline)fail();
      switch(op){
        case 'begin':return await json('begin',{file:body},signal);
        case 'part':return await send('part',{headers:{'content-type':'application/octet-stream','x-large-meta':JSON.stringify({...owner,uploadId:body.uploadId,part:body.partNumber})},body:body.data},signal);
        case 'complete':case 'abort':return await json(op,{uploadId:body.uploadId},signal);
        // The server derives storageRef from the approved owner; the wire carries only path, size and sha256.
        case 'manifest':return await json('manifest',{files:(body.files as LargeUploadedFile[]).map(({path,size,sha256})=>({path,size,sha256}))},signal);
      }
    }catch{/* never expose transport detail */}
    return fail();
  }) as LargePost;
}
