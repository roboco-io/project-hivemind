import {createHash} from 'node:crypto';
import type {ExternalLargeManifest} from '../../contracts/src/autonomous-external-large.js';
import {assertHfLfsAllowed,assertHfVisibility,resolveHfVisibility} from './autonomous-external-hf-visibility.ts';

import {preflightHfFiles} from './autonomous-external-hf-preflight.ts';

// HTTP LFS compatibility, checked against huggingface_hub v2.4.0 lfs.py/_commit_api.py.
// Regular files: 16 MiB each and total; streamed commit: 24 MiB wire; input chunks: 1 MiB.
// No native Xet implementation or real-provider verification is claimed.
export const HF_REGULAR_MAX_BYTES=16*1024*1024;
const MAX_COMMIT_WIRE_BYTES=24*1024*1024;
export const HF_LFS_MAX_FILE_BYTES=5*1024*1024*1024;
const MAX_FILES=64,MAX_JSON_BYTES=1024*1024,API_TIMEOUT_MS=15000,UPLOAD_TIMEOUT_MS=30*60*1000;
const HF_ORIGIN='https://huggingface.co';

/** The invocation fields this module needs; structurally compatible with ExternalInvocation. */
export interface HfLfsInvocation{taskId:string;revision:number;ownershipToken:string;idempotencyKey:string;parametersHash:string;expiresAt:number}
export interface HfLfsOptions{
  repository:string;revision:string;
  /** The approved `message` parameter, used as the commit description. */
  message:string;
  /** Omitted visibility retains private behavior. */
  visibility?:unknown;
  allowPublicLarge?:boolean;forbiddenValues?:readonly string[];
  fetch?:typeof globalThis.fetch;now?:()=>number;signal?:AbortSignal;
  /** Server-owned host names that may receive upload PUTs. */
  uploadHosts:readonly string[];
  /** Streams the stored bytes of one manifest file (the large store's `open`). */
  open(file:ExternalLargeManifest['files'][number]):Promise<ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>>;
}

const fail=()=>new Error('Hugging Face LFS unavailable');
/** A refusal whose reason is safe to record: a host name, an HTTP method and status, never a query string or token. */
const failBecause=(detail:string)=>new Error(`Hugging Face LFS unavailable: ${detail.replace(/[^\x20-\x7e]/g,'?').slice(0,300)}`);
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

function toStream(it:AsyncIterable<Uint8Array>):ReadableStream<Uint8Array>{
  const iterator=it[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(c){const n=await iterator.next();if(n.done)c.close();else c.enqueue(n.value);},
    async cancel(){await iterator.return?.();},
  });
}
function active(i:HfLfsInvocation,o:HfLfsOptions){o.signal?.throwIfAborted();need((o.now??Date.now)()<i.expiresAt);}
async function interrupt<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();let abort!:()=>void;
  const stop=new Promise<never>((_,reject)=>{abort=()=>reject(fail());signal?.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([work,stop]);}finally{signal?.removeEventListener('abort',abort);}
}
async function* fileChunks(f:ExternalLargeManifest['files'][number],i:HfLfsInvocation,o:HfLfsOptions,assertActive=()=>active(i,o)):AsyncGenerator<Uint8Array>{
  assertActive();const opening=o.open(f);let source;
  try{source=await interrupt(opening,o.signal);}catch(e){
    void opening.then(s=>{try{void Promise.resolve('cancel' in s?s.cancel():s[Symbol.asyncIterator]().return?.()).catch(()=>{});}catch{/* Cleanup must not expose source errors. */}},()=>{});
    throw e;
  }
  const stream=Symbol.asyncIterator in source?toStream(source as AsyncIterable<Uint8Array>):source as ReadableStream<Uint8Array>,reader=stream.getReader();
  const hash=createHash('sha256');let size=0;
  try{for(;;){assertActive();const n=await interrupt(reader.read(),o.signal);assertActive();if(n.done)break;
    need(n.value instanceof Uint8Array&&n.value.length<=1024*1024&&n.value.length<=f.size-size);
    size+=n.value.length;hash.update(n.value);yield n.value;
  }need(size===f.size&&hash.digest('hex')===f.sha256);}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
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
  need(u.protocol==='https:'&&!u.username&&!u.password&&u.port===''&&!u.hash);
  if(!hosts.some(h=>h.toLowerCase()===u.hostname))throw failBecause(`upload host not allowed: ${u.hostname}`);
  return u.toString();
}

function context(i:HfLfsInvocation,token:string,o:HfLfsOptions,readOnly=false){
  need(typeof token==='string'&&token.length>0&&token.length<=8192&&Array.isArray(o.uploadHosts)&&o.uploadHosts.every(h=>typeof h==='string'&&/^[a-z0-9.-]+$/i.test(h)&&h.toLowerCase()!=='huggingface.co'));
  const fetcher=o.fetch??globalThis.fetch,now=o.now??Date.now;
  const base=`${HF_ORIGIN}/api/models/${repo(o.repository)}`,r=rev(o.revision);
  const assertActive=()=>{o.signal?.throwIfAborted();if(!readOnly)need(now()<i.expiresAt);};
  async function call(url:string,init:{method:string;headers:Record<string,string>;body?:BodyInit;duplex?:'half'},timeoutMs=API_TIMEOUT_MS):Promise<Response>{
    assertActive();need(!readOnly||init.method==='GET');
    const stop=new AbortController();
    const signal=AbortSignal.any([stop.signal,AbortSignal.timeout(Math.min(timeoutMs,readOnly?API_TIMEOUT_MS:Math.max(1,i.expiresAt-now()))),...(o.signal?[o.signal]:[])]);
    let pipe:Promise<void>|undefined;
    try{
      const FixedLength=(globalThis as typeof globalThis&{FixedLengthStream?:new(length:number)=>{readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>}}).FixedLengthStream;
      const length=init.headers['content-length'];
      if(FixedLength&&length!==undefined&&init.body instanceof ReadableStream){
        need(/^[0-9]+$/.test(length)&&Number.isSafeInteger(Number(length)));
        // Workers derives Content-Length from this native readable, not a header
        // on a generic stream. pipeTo preserves backpressure without part buffers.
        const fixed=new FixedLength(Number(length));
        pipe=init.body.pipeTo(fixed.writable,{signal});
        void pipe.catch(()=>stop.abort());
        init={...init,body:fixed.readable};
      }
      const response=fetcher(url,{...init,redirect:'manual',signal} as RequestInit);
      const res=await interrupt(response,signal);
      assertActive();
      if(!(res.status>=200&&res.status<300&&res.ok&&!res.redirected)){const u=new URL(url);throw failBecause(`${init.method} ${u.hostname}${u.pathname} returned HTTP ${res.status}`);}
      if(pipe)await interrupt(pipe,signal);
      return res;
    }catch(e){stop.abort();if(pipe)void pipe.catch(()=>{});throw e;}
  }
  async function readJson(res:Response):Promise<unknown>{
    const len=res.headers.get('content-length');if(len!==null)need(/^\d+$/.test(len)&&Number(len)<=MAX_JSON_BYTES);
    const reader=res.body?.getReader();need(reader);const chunks:Uint8Array[]=[];let n=0;
    try{for(;;){const p=await interrupt(reader.read(),o.signal);if(p.done)break;n+=p.value.byteLength;if(n>MAX_JSON_BYTES){await reader.cancel();throw fail();}chunks.push(p.value);}}finally{reader.releaseLock();}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }
  const auth={authorization:`Bearer ${token}`,'user-agent':'hivemind-external/1'};
  const api=async(url:string,method:string,body?:unknown,type='application/json')=>readJson(await call(url,{method,headers:{...auth,accept:'application/json',...(body===undefined?{}:{'content-type':type})},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}));
  return {base,r,api,call,readJson,auth,now,assertActive};
}

/** Read-only recovery checks the original invocation mark and every LFS or regular blob. */
export async function hfLfsProof(i:HfLfsInvocation,token:string,manifest:ExternalLargeManifest,o:HfLfsOptions,expected?:string):Promise<{commitOid:string}|null>{
  assertHfLfsAllowed(o.visibility,o.allowPublicLarge);checkManifest(i,manifest);
  // Recovery reads do not renew execution authority. context rejects every non-GET.
  o.signal?.throwIfAborted();o={...o,signal:AbortSignal.any([AbortSignal.timeout(API_TIMEOUT_MS),...(o.signal?[o.signal]:[])])};
  const {base,r,api,assertActive}=context(i,token,o,true);
  const commits=await api(`${base}/commits/${r}`,'GET');need(Array.isArray(commits)&&commits.length<=100);
  const found=commits.map(record).find(c=>c.title===mark(i)&&(expected===undefined||c.id===expected));
  if(!found)return null;
  const id=hash40(found.id);
  const info=record(await api(`${base}/revision/${id}?blobs=true`,'GET'));
  assertHfVisibility(info,resolveHfVisibility(o.visibility));need(info.sha===id&&Array.isArray(info.siblings));
  for(const f of manifest.files){
    const s=info.siblings.map(record).find(x=>x.rfilename===f.path);
    need(s);
    if(s.lfs!==undefined){const lfs=record(s.lfs);need(lfs.sha256===f.sha256&&lfs.size===f.size);}
    else{need(f.size<=HF_REGULAR_MAX_BYTES&&s.size===f.size);const git=createHash('sha1').update(`blob ${f.size}\0`);for await(const chunk of fileChunks(f,i,o,assertActive))git.update(chunk);need(s.blobId===git.digest('hex'));}
  }
  return {commitOid:id};
}

/**
 * Commits the manifest to Hugging Face. A refusal names the step it happened in (for example
 * "lfs-batch" or "upload model.safetensors part 3"), never a token, URL query or file content.
 */
export async function hfLfsCommit(i:HfLfsInvocation,token:string,manifest:ExternalLargeManifest,o:HfLfsOptions):Promise<{commitOid:string}>{
  const at={step:'validate'};
  try{return await commitSteps(i,token,manifest,o,at);}
  catch(e){if(e instanceof Error&&e.message==='Hugging Face LFS unavailable')throw failBecause(`${at.step} check failed`);throw e;}
}

async function commitSteps(i:HfLfsInvocation,token:string,manifest:ExternalLargeManifest,o:HfLfsOptions,at:{step:string}):Promise<{commitOid:string}>{
  assertHfLfsAllowed(o.visibility,o.allowPublicLarge);checkManifest(i,manifest);
  active(i,o);o={...o,signal:AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.min(UPLOAD_TIMEOUT_MS,i.expiresAt-(o.now??Date.now)()))),...(o.signal?[o.signal]:[])])};
  // Validate the message before any upload so a bad message cannot orphan LFS objects.
  need(typeof o.message==='string'&&o.message.length>0&&o.message.length<=512&&!/[\p{Cc}]/u.test(o.message));
  const {base,r,api,call,readJson,auth}=context(i,token,o);
  const configuredValues=o.forbiddenValues??[];
  need(Array.isArray(configuredValues)&&configuredValues.length<=1024);
  const protectedValues=[...new Set([token,...configuredValues])];
  const metadata=Buffer.from(JSON.stringify({message:o.message,paths:manifest.files.map(f=>f.path)}));
  const metadataFile={path:'metadata',size:metadata.length,sha256:createHash('sha256').update(metadata).digest('hex'),storageRef:'metadata'};
  at.step='preflight';
  await preflightHfFiles([metadataFile],{open:async()=>new Blob([metadata]).stream(),forbiddenValues:protectedValues,signal:o.signal,assertActive:()=>active(i,o)});
  await preflightHfFiles(manifest.files,{open:o.open,forbiddenValues:protectedValues,signal:o.signal,assertActive:()=>active(i,o)});
  at.step='revision';
  const info=record(await api(`${base}/revision/${r}?blobs=true`,'GET'));
  assertHfVisibility(info,resolveHfVisibility(o.visibility));const parent=hash40(info.sha);
  at.step='prior-commit-proof';
  const prior=await hfLfsProof(i,token,manifest,o);if(prior)return prior;
  at.step='sample';
  const samples=[];
  for(const f of manifest.files){
    let sample=Buffer.alloc(0);
    for await(const chunk of fileChunks(f,i,o)){sample=Buffer.concat([sample,chunk.subarray(0,512-sample.length)]);if(sample.length===Math.min(512,f.size))break;}
    samples.push({path:f.path,size:f.size,sample:sample.toString('base64')});
  }
  at.step='preupload';
  const preupload=record(await api(`${base}/preupload/${r}`,'POST',{files:samples}));
  need(Array.isArray(preupload.files)&&preupload.files.length===manifest.files.length);
  const modes=new Map<string,string>();let regularBytes=0;
  for(const entry of preupload.files){const f=record(entry);need(typeof f.path==='string'&&!modes.has(f.path)&&manifest.files.some(x=>x.path===f.path)&&f.shouldIgnore===false&&(f.uploadMode==='regular'||f.uploadMode==='lfs')&&(f.oid===undefined||f.oid===null||typeof f.oid==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(f.oid)));modes.set(f.path,f.uploadMode);}
  for(const f of manifest.files)if(modes.get(f.path)==='regular'){need(f.size<=HF_REGULAR_MAX_BYTES);regularBytes+=f.size;}
  need(regularBytes<=HF_REGULAR_MAX_BYTES);
  const files=[...new Map(manifest.files.filter(f=>modes.get(f.path)==='lfs').map(f=>[f.sha256,f])).values()];
  need(files.every(f=>manifest.files.every(g=>g.sha256!==f.sha256||g.size===f.size)));
  at.step='lfs-batch';
  const lfsBase=`${HF_ORIGIN}/${repo(o.repository)}.git/info/lfs`;
  const batch=files.length?record(await api(`${lfsBase}/objects/batch`,'POST',{operation:'upload',transfers:['basic','multipart'],hash_algo:'sha256',ref:{name:o.revision},objects:files.map(f=>({oid:f.sha256,size:f.size}))},'application/vnd.git-lfs+json')):{objects:[]};
  need(batch.transfer===undefined||batch.transfer==='basic'||batch.transfer==='multipart');
  need(Array.isArray(batch.objects)&&batch.objects.length===files.length);
  const byOid=new Map(batch.objects.map(record).map(x=>[x.oid,x]));need(byOid.size===files.length);
  const endpoint=(action:Record<string,unknown>,kind:'verify'|'multipart/complete')=>{
    need(typeof action.href==='string');let url:URL;try{url=new URL(action.href);}catch{throw fail();}
    if(url.hostname==='huggingface.co'){
      need(url.origin===HF_ORIGIN&&!url.username&&!url.password&&!url.port&&!url.hash);
      const legacy=new URL(lfsBase).pathname;
      need(kind==='verify'
        ? !url.search&&(url.pathname===`${legacy}/verify`||url.pathname===`${legacy}/objects/verify`)
        : url.pathname==='/api/complete_multipart'||url.pathname===`${legacy}/multipart/complete`);
      return url.href;
    }
    return checkUploadHref(action.href,o.uploadHosts);
  };
  const headersFor=(action:Record<string,unknown>,url:string,verify=false)=>{
    const headers:Record<string,string>={};
    for(const [k,v] of Object.entries(action.header===undefined?{}:record(action.header))){
      need(typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(k)&&!/[\r\n]/.test(v));
      if(!['authorization','host','content-length','cookie','proxy-authorization'].includes(k.toLowerCase())&&k!=='chunk_size'&&!/^\d+$/.test(k))headers[k]=v;
    }
    if(verify&&new URL(url).origin===HF_ORIGIN)Object.assign(headers,auth);
    return headers;
  };
  // Validate every destination before beginning any transfer.
  const transfers=files.map(f=>{
    at.step=`lfs-batch ${f.path}`;
    const obj=byOid.get(f.sha256);need(obj&&obj.size===f.size&&obj.error===undefined);
    if(obj.actions===undefined)return {f};
    const actions=record(obj.actions),upload=record(actions.upload),h=upload.header===undefined?{}:record(upload.header);
    const verify=actions.verify===undefined?undefined:record(actions.verify);
    const verifyUrl=verify?endpoint(verify,'verify'):undefined;
    if(verify)headersFor(verify,verifyUrl!,true);
    if(h.chunk_size!==undefined){
      need(typeof h.chunk_size==='string'&&/^[1-9][0-9]*$/.test(h.chunk_size));
      const size=Number(h.chunk_size);need(Number.isSafeInteger(size)&&size>0);
      const keys=Object.keys(h).filter(k=>/^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
      need(keys.length===Math.ceil(f.size/size)&&keys.length<=10000&&keys.every((k,n)=>/^[0-9]{1,6}$/.test(k)&&Number(k)===n+1));
      const urls=keys.map(k=>checkUploadHref(h[k],o.uploadHosts)),url=endpoint(upload,'multipart/complete');headersFor(upload,url);
      return {f,upload,url,urls,size,verify,verifyUrl};
    }
    need(!Object.keys(h).some(k=>/^\d+$/.test(k)));
    const url=checkUploadHref(upload.href,o.uploadHosts);headersFor(upload,url);
    return {f,upload,url,urls:[url],size:f.size,verify,verifyUrl};
  });
  for(const t of transfers){
    if(!t.upload)continue;
    const uploadStop=new AbortController(),uploadOptions={...o,signal:AbortSignal.any([o.signal!,uploadStop.signal])};
    const iterator=fileChunks(t.f,i,uploadOptions),reader={read:()=>iterator.next(),cancel:()=>iterator.return(undefined),releaseLock:()=>{}};
    let pending:Uint8Array=new Uint8Array(0),total=0;
    const checkActive=()=>active(i,o);
    const parts:{partNumber:number;etag:string}[]=[];
    try{
      for(let n=0;n<t.urls!.length;n++){
        at.step=`upload ${t.f.path} part ${n+1}/${t.urls!.length}`;
        let remaining=Math.min(t.size!,t.f.size-total),consumed=false;
        const body=new ReadableStream<Uint8Array>({async pull(c){
          try{checkActive();if(remaining===0){consumed=true;c.close();return;}
            while(!pending.length){const next=await reader.read();checkActive();need(!next.done&&next.value instanceof Uint8Array);pending=next.value;}
            const length=Math.min(remaining,pending.length,1024*1024),chunk=pending.subarray(0,length);
            total+=length;remaining-=length;pending=pending.subarray(length);c.enqueue(chunk);
            if(remaining===0){consumed=true;c.close();}
          }catch(e){c.error(e);}
        },cancel(){uploadStop.abort();}},{highWaterMark:0});
        const headers=t.urls!.length===1&&t.upload.header!==undefined&&record(t.upload.header).chunk_size===undefined?headersFor(t.upload,t.urls![n]!):{};
        const length=Math.min(t.size!,t.f.size-total);
        const res=await call(t.urls![n]!,{method:'PUT',headers:{...headers,'content-length':String(length)},body,duplex:'half'},UPLOAD_TIMEOUT_MS);
        need(consumed&&remaining===0);checkActive();
        if(record(t.upload.header??{}).chunk_size!==undefined){const etag=res.headers.get('etag');need(etag&&etag.trim().length>0&&etag.length<=1024&&!/[\p{Cc}]/u.test(etag));parts.push({partNumber:n+1,etag});}
      }
      checkActive();need(!pending.length&&(await reader.read()).done&&total===t.f.size);checkActive();
      at.step=`upload-complete ${t.f.path}`;
      if(parts.length)await call(t.url!,{method:'POST',headers:{...headersFor(t.upload,t.url!),accept:'application/vnd.git-lfs+json','content-type':'application/vnd.git-lfs+json'},body:JSON.stringify({oid:t.f.sha256,parts})});
      at.step=`upload-verify ${t.f.path}`;
      if(t.verify)await call(t.verifyUrl!,{method:'POST',headers:{...headersFor(t.verify,t.verifyUrl!,true),'content-type':'application/vnd.git-lfs+json'},body:JSON.stringify({oid:t.f.sha256,size:t.f.size})});
    }finally{uploadStop.abort();void reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async function* commitLines(){
    const encode=(s:string)=>new TextEncoder().encode(s);
    yield encode(JSON.stringify({key:'header',value:{summary:mark(i),description:o.message,parentCommit:parent}})+'\n');
    for(const f of manifest.files){
      if(modes.get(f.path)==='lfs'){yield encode(JSON.stringify({key:'lfsFile',value:{path:f.path,algo:'sha256',oid:f.sha256,size:f.size}})+'\n');continue;}
      yield encode(`{"key":"file","value":{"path":${JSON.stringify(f.path)},"encoding":"base64","content":"`);
      let carry=Buffer.alloc(0);
      for await(const chunk of fileChunks(f,i,o)){
        const joined=Buffer.concat([carry,chunk]),count=joined.length-joined.length%3;
        if(count)yield encode(joined.subarray(0,count).toString('base64'));
        carry=Buffer.from(joined.subarray(count));
      }
      if(carry.length)yield encode(carry.toString('base64'));
      yield encode('"}}\n');
    }
  }
  let wire=0,complete=false;
  async function* boundedCommit(){for await(const chunk of commitLines()){active(i,o);wire+=chunk.length;need(wire<=MAX_COMMIT_WIRE_BYTES);yield chunk;}complete=true;}
  // Narrow the remote visibility race immediately before publication. HF offers no
  // atomic visibility CAS: visibility may still change between this GET and POST.
  // Keep the original parentCommit CAS instead of accepting a newly observed head.
  at.step='commit-parent-check';
  const latest=record(await api(`${base}/revision/${r}?blobs=true`,'GET'));
  assertHfVisibility(latest,resolveHfVisibility(o.visibility));need(latest.sha===parent);
  at.step='commit';
  const body=toStream(boundedCommit());
  const res=record(await readJson(await call(`${base}/commit/${r}`,{method:'POST',headers:{...auth,accept:'application/json','content-type':'application/x-ndjson'},body,duplex:'half'})));
  need(complete);
  const oid=hash40(res.commitOid);
  at.step='commit-proof';
  const proof=await hfLfsProof(i,token,manifest,o,oid);need(proof);return proof;
}
