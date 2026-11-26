import {createHash} from 'node:crypto';
import type {ExternalLargeManifest} from '../../contracts/src/autonomous-external-large.js';

type Options={
  open(file:ExternalLargeManifest['files'][number]):Promise<ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>>;
  forbiddenValues:readonly string[];
  signal?:AbortSignal;
  assertActive?:()=>void;
};
const fail=()=>new Error('HF file preflight failed');
const MAX_CHUNK=1024*1024,SLICE=16*1024;
// Bounded checks for known values and common credentials; not complete DLP.
// Latin-1 preserves binary bytes without rejecting arbitrary safetensor payloads.
const credentials=/(?:hf_[a-zA-Z0-9]{20}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|(?:gh[pousr]_|github_pat_)[a-zA-Z0-9_]{20}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:authorization\s*[:=]\s*["']?\s*(?:bearer|basic)\s+[a-zA-Z0-9+/_=-]{8})|(?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[a-zA-Z0-9+/_=.-]{8}))/i;
function patterns(values:readonly string[]):Buffer[]{
  // Bound configured inputs before constructing any expanded variants.
  if(values.length>514)throw fail();
  const unique=new Set<string>();
  let total=0;
  for(const value of values){
    if(typeof value!=='string'||!value.length||value.length>16384)throw fail();
    if(unique.has(value))continue;
    unique.add(value);if(unique.size>257)throw fail();
    total+=Buffer.byteLength(value);if(total>128*1024)throw fail();
  }
  let variantBytes=0;const result:Buffer[]=[];
  for(const value of unique){
    const bytes=Buffer.from(value);
    const unicode=Array.from({length:value.length},(_,i)=>'\\u'+value.charCodeAt(i).toString(16).padStart(4,'0')).join('');
    for(const variant of new Set([value,bytes.toString('base64'),bytes.toString('base64url'),encodeURIComponent(value),encodeURIComponent(value).replace(/%[A-F0-9]{2}/g,s=>s.toLowerCase()),JSON.stringify(value).slice(1,-1),unicode,unicode.toUpperCase().replace(/\\U/g,'\\u')])){
      variantBytes+=Buffer.byteLength(variant);
      if(variantBytes>1024*1024)throw fail();
      result.push(Buffer.from(variant));
    }
  }
  return result;
}

export async function preflightHfFiles(files:ExternalLargeManifest['files'],options:Options):Promise<void>{
  const {signal}=options;
  const active=()=>{if(signal?.aborted)throw fail();options.assertActive?.();};
  // Interrupt held open/read promises. Late sources are disposed below.
  const interrupt=async<T>(promise:Promise<T>):Promise<T>=>{
    let abort!:()=>void;
    const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(fail());signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
    try{return await Promise.race([promise,stopped]);}finally{signal?.removeEventListener('abort',abort);}
  };
  const disposeSource=(source:ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>)=>{
    try{const p='getReader' in source?source.cancel():source[Symbol.asyncIterator]().return?.();void Promise.resolve(p).catch(()=>{});}catch{/* Generic outer error only. */}
  };
  try{
    active();const needles=patterns(options.forbiddenValues);
    // All needles can span chunks/slices. Keep their longest prefix plus a
    // bounded baseline for common credential patterns. Never truncate a value.
    const window=Math.max(12288,...needles.map(value=>value.length-1));
    for(const file of files){
      active();
      if(!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw fail();
      const opening=options.open(file);
      let source:ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>;
      try{source=await interrupt(opening);}catch{void opening.then(disposeSource,()=>{});throw fail();}
      let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      let iterator:AsyncIterator<Uint8Array>|undefined;
      let complete=false;
      try{
        if('getReader' in source)reader=source.getReader();else iterator=source[Symbol.asyncIterator]();
        const hash=createHash('sha256');let size=0,tail=Buffer.alloc(0);
        for(;;){
          active();const next=await interrupt(reader?reader.read():iterator!.next());active();
          if(next.done)break;
          const chunk=next.value;
          if(!(chunk instanceof Uint8Array)||chunk.byteLength>MAX_CHUNK||chunk.byteLength>file.size-size)throw fail();
          size+=chunk.byteLength;hash.update(chunk);
          for(let offset=0;offset<chunk.byteLength;offset+=SLICE){
            active();const scan=Buffer.concat([tail,chunk.subarray(offset,offset+SLICE)]);
            if(needles.some(value=>scan.includes(value))||credentials.test(scan.toString('latin1')))throw fail();
            tail=Buffer.from(scan.subarray(Math.max(0,scan.length-window)));
          }
        }
        if(size!==file.size||hash.digest('hex')!==file.sha256)throw fail();
        active();complete=true;
      }finally{
        if(!complete){
          // Invoke cleanup immediately, but do not await an iterator return queued
          // behind a held next(). Cleanup failures must not expose source data.
          try{void Promise.resolve(reader?reader.cancel():iterator?.return?.()).catch(()=>{});}catch{/* sanitized */}
        }
        reader?.releaseLock();
      }
    }
    active();
  }catch{throw fail();}
}
