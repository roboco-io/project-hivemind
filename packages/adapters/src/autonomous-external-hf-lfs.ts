// Hugging Face LFS commit for large artifacts (hf.model.lfs_commit).
//
// UNVERIFIED AGAINST REAL HUGGING FACE: the LFS batch endpoint, the basic transfer
// actions, the `lfsFile` commit line and the `lfs` field of `siblings` follow the
// conventional Git LFS batch protocol and were written without network access or
// documentation. They are tested only with a fake fetch. Confirm them against the
// real service before any live use.
//
// Safety rules enforced here:
// - Provider API URLs are fixed to https://huggingface.co. Upload hrefs returned by the
//   server must be https on a server-owned host allow-list (no credentials, default port).
// - Redirects are never followed. The Authorization header goes only to huggingface.co,
//   never to an upload href. A server-supplied Authorization header is dropped too.
// - Only private repositories are accepted. No repository creation, no visibility change.
import {createHash} from 'node:crypto';
import type {ExternalLargeManifest} from '../../contracts/src/autonomous-external-large.js';
import {assertHfLfsAllowed,assertHfVisibility} from './autonomous-external-hf-visibility.ts';

export const HF_LFS_MAX_FILE_BYTES=5*1024*1024*1024;
const MAX_FILES=64,MAX_JSON_BYTES=1024*1024,API_TIMEOUT_MS=15000,UPLOAD_TIMEOUT_MS=30*60*1000;
const HF_ORIGIN='https://huggingface.co';

/** The invocation fields this module needs; structurally compatible with ExternalInvocation. */
export interface HfLfsInvocation{taskId:string;revision:number;ownershipToken:string;idempotencyKey:string;parametersHash:string;expiresAt:number}
export interface HfLfsOptions{
  repository:string;revision:string;
  /** The approved `message` parameter, used as the commit description. */
  message:string;
  /** 'private' is required. Anything else is rejected before a request is made. */
  visibility?:unknown;
  fetch?:typeof globalThis.fetch;now?:()=>number;signal?:AbortSignal;
  /** Server-owned host names that may receive upload PUTs. */
  uploadHosts:readonly string[];
  /** Streams the stored bytes of one manifest file (the large store's `open`). */
  open(file:ExternalLargeManifest['files'][number]):Promise<ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>>;
}

const fail=()=>new Error('Hugging Face LFS unavailable');
function need(ok:unknown):asserts ok{if(!ok)throw fail();}
const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
const mark=(i:HfLfsInvocation)=>'hivemind:'+sha256(JSON.stringify([i.ownershipToken,i.idempotencyKey,i.parametersHash]));
function record(x:unknown):Record<string,unknown>{need(x!==null&&typeof x==='object'&&!Array.isArray(x));return x as Record<string,unknown>;}
const hash40=(x:unknown):string=>{need(typeof x==='string'&&/^[a-f0-9]{40}$/.test(x));return x;};
const seg=encodeURIComponent;
function repo(s:string){need(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(s));return s.split('/').map(seg).join('/');}
function rev(s:string){need(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(s)&&!s.includes('..')&&!s.includes('//')&&!s.endsWith('/')&&!s.endsWith('.lock'));return seg(s);}

export function lfsPointer(sha:string,size:number):string{
  need(/^[a-f0-9]{64}$/.test(sha)&&Number.isSafeInteger(size)&&size>0);
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize ${size}\n`;
}

/** Path rules: relative, no `..`/`.` segments, no empty segments, no control characters or backslashes. */
function toStream(it:AsyncIterable<Uint8Array>):ReadableStream<Uint8Array>{
  const iterator=it[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(c){const n=await iterator.next();if(n.done)c.close();else c.enqueue(n.value);},
    async cancel(){await iterator.return?.();},
  });
}
function checkPath(p:unknown):string{
  need(typeof p==='string'&&p.length>0&&p.length<=1024&&!/[\p{Cc}\\]/u.test(p)&&!p.startsWith('/'));
  need(p.split('/').every(s=>s.length>0&&s!=='.'&&s!=='..'));
  return p;
}
function checkManifest(i:HfLfsInvocation,m:ExternalLargeManifest){
  need(m&&m.version===1&&m.taskId===i.taskId&&m.revision===i.revision&&Array.isArray(m.files)&&m.files.length>0&&m.files.length<=MAX_FILES);
  const paths=new Set<string>();
  for(const f of m.files){
    need(!paths.has(checkPath(f.path)));paths.add(f.path);
    need(Number.isSafeInteger(f.size)&&f.size>0&&f.size<=HF_LFS_MAX_FILE_BYTES&&typeof f.sha256==='string'&&/^[a-f0-9]{64}$/.test(f.sha256));
  }
}
function checkUploadHref(href:unknown,hosts:readonly string[]):string{
  need(typeof href==='string'&&href.length<=4096);
  let u:URL;try{u=new URL(href);}catch{throw fail();}
  need(u.protocol==='https:'&&!u.username&&!u.password&&u.port===''&&hosts.some(h=>h.toLowerCase()===u.hostname));
  return u.toString();
}

function context(i:HfLfsInvocation,token:string,o:HfLfsOptions){
  need(typeof token==='string'&&token.length>0&&token.length<=8192&&Array.isArray(o.uploadHosts)&&o.uploadHosts.every(h=>typeof h==='string'&&/^[a-z0-9.-]+$/i.test(h)&&h.toLowerCase()!=='huggingface.co'));
  const fetcher=o.fetch??globalThis.fetch,now=o.now??Date.now;
  const base=`${HF_ORIGIN}/api/models/${repo(o.repository)}`,r=rev(o.revision);
  async function call(url:string,init:{method:string;headers:Record<string,string>;body?:BodyInit;duplex?:'half'},timeoutMs=API_TIMEOUT_MS):Promise<Response>{
    o.signal?.throwIfAborted();
    need(now()<i.expiresAt);
    const signal=AbortSignal.any([AbortSignal.timeout(Math.min(timeoutMs,Math.max(1,i.expiresAt-now()))),...(o.signal?[o.signal]:[])]);
    const res=await fetcher(url,{...init,redirect:'error',signal} as RequestInit);
    need(res.ok&&!res.redirected);return res;
  }
  async function readJson(res:Response):Promise<unknown>{
    const len=res.headers.get('content-length');if(len!==null)need(/^\d+$/.test(len)&&Number(len)<=MAX_JSON_BYTES);
    const reader=res.body?.getReader();need(reader);const chunks:Uint8Array[]=[];let n=0;
    try{for(;;){const p=await reader.read();if(p.done)break;n+=p.value.byteLength;if(n>MAX_JSON_BYTES){await reader.cancel();throw fail();}chunks.push(p.value);}}finally{reader.releaseLock();}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }
  const auth={authorization:`Bearer ${token}`,'user-agent':'hivemind-external/1'};
  const api=async(url:string,method:string,body?:unknown,type='application/json')=>readJson(await call(url,{method,headers:{...auth,accept:'application/json',...(body===undefined?{}:{'content-type':type})},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}));
  return {base,r,api,call,readJson,auth,now};
}

/** Finds the commit carrying this invocation's mark and checks that every LFS file is present with the expected oid and size. */
export async function hfLfsProof(i:HfLfsInvocation,token:string,manifest:ExternalLargeManifest,o:HfLfsOptions,expected?:string):Promise<{commitOid:string}|null>{
  assertHfLfsAllowed(o.visibility);checkManifest(i,manifest);
  const {base,r,api}=context(i,token,o);
  const commits=await api(`${base}/commits/${r}`,'GET');need(Array.isArray(commits)&&commits.length<=100);
  const found=commits.map(record).find(c=>c.title===mark(i)&&(expected===undefined||c.id===expected));
  if(!found)return null;
  const id=hash40(found.id);
  const info=record(await api(`${base}/revision/${id}?blobs=true`,'GET'));
  assertHfVisibility(info,'private');need(info.sha===id&&Array.isArray(info.siblings));
  for(const f of manifest.files){
    const s=info.siblings.map(record).find(x=>x.rfilename===f.path);
    need(s);const lfs=record(s.lfs);need(lfs.sha256===f.sha256&&lfs.size===f.size);
  }
  return {commitOid:id};
}

export async function hfLfsCommit(i:HfLfsInvocation,token:string,manifest:ExternalLargeManifest,o:HfLfsOptions):Promise<{commitOid:string}>{
  assertHfLfsAllowed(o.visibility);checkManifest(i,manifest);
  // Validate the message before any upload so a bad message cannot orphan LFS objects.
  need(typeof o.message==='string'&&o.message.length>0&&o.message.length<=512&&!/[\p{Cc}]/u.test(o.message));
  const {base,r,api,call,readJson,auth}=context(i,token,o);
  const info=record(await api(`${base}/revision/${r}?blobs=true`,'GET'));
  assertHfVisibility(info,'private');const parent=hash40(info.sha);
  const prior=await hfLfsProof(i,token,manifest,o);if(prior)return prior;
  // Git LFS batch: ask where to upload every object. A missing `actions` means the server already has it.
  const lfsBase=`${HF_ORIGIN}/${repo(o.repository)}.git/info/lfs`;
  const batch=record(await api(`${lfsBase}/objects/batch`,'POST',{operation:'upload',transfers:['basic'],hash_algo:'sha256',ref:{name:`refs/heads/${o.revision}`},objects:manifest.files.map(f=>({oid:f.sha256,size:f.size}))},'application/vnd.git-lfs+json'));
  need(Array.isArray(batch.objects)&&batch.objects.length===manifest.files.length);
  const byOid=new Map(batch.objects.map(record).map(x=>[x.oid,x]));need(byOid.size===manifest.files.length);
  for(const f of manifest.files){
    const obj=byOid.get(f.sha256);need(obj&&obj.size===f.size);
    if(obj.error!==undefined)throw fail();
    if(obj.actions===undefined)continue;
    const actions=record(obj.actions),upload=record(actions.upload);
    const href=checkUploadHref(upload.href,o.uploadHosts);
    // Server-supplied headers are forwarded, but Authorization never is.
    const headers:Record<string,string>={};
    for(const [k,v] of Object.entries(upload.header===undefined?{}:record(upload.header))){need(typeof v==='string'&&/^[A-Za-z0-9-]{1,64}$/.test(k)&&!/[\r\n]/.test(v));if(!['authorization','host','content-length'].includes(k.toLowerCase()))headers[k]=v;}
    headers['content-length']=String(f.size);
    const source=await o.open(f);
    const body=Symbol.asyncIterator in source?toStream(source as AsyncIterable<Uint8Array>):source as ReadableStream<Uint8Array>;
    await call(href,{method:'PUT',headers,body,duplex:'half'},UPLOAD_TIMEOUT_MS);
    if(actions.verify!==undefined){
      const v=record(actions.verify),url=new URL(typeof v.href==='string'?v.href:'');
      // Verify runs against Hugging Face itself, so only that fixed origin may receive the token.
      need(url.origin===HF_ORIGIN&&!url.username&&!url.password&&!url.hash);
      await readJson(await call(url.toString(),{method:'POST',headers:{...auth,accept:'application/vnd.git-lfs+json','content-type':'application/vnd.git-lfs+json'},body:JSON.stringify({oid:f.sha256,size:f.size})}));
    }
  }
  const ndjson=[{key:'header',value:{summary:mark(i),description:o.message,parentCommit:parent}},
    ...manifest.files.map(f=>({key:'lfsFile',value:{path:f.path,algo:'sha256',oid:f.sha256,size:f.size}}))].map(x=>JSON.stringify(x)).join('\n')+'\n';
  const res=record(await readJson(await call(`${base}/commit/${r}`,{method:'POST',headers:{...auth,accept:'application/json','content-type':'application/x-ndjson'},body:ndjson})));
  const oid=hash40(res.commitOid);
  const proof=await hfLfsProof(i,token,manifest,o,oid);need(proof);return proof;
}
