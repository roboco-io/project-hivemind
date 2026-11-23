import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {preflightHfFiles} from '../packages/adapters/src/autonomous-external-hf-preflight.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const file=(b:Uint8Array)=>({path:'private-path',storageRef:'private-source',size:b.length,sha256:sha(b)});
const source=(b:Uint8Array):AsyncIterable<Uint8Array>=>({async *[Symbol.asyncIterator](){yield b;}});
test('rejects incorrect content hash with a generic error',async()=>{
 const b=Buffer.from('weights');
 await assert.rejects(preflightHfFiles([{...file(b),sha256:'0'.repeat(64)}],{open:async()=>source(b),forbiddenValues:[]}),/^Error: HF file preflight failed$/);
});
const generic=/^Error: HF file preflight failed$/;
const secret='canary/"secret+abcdef';
const variants=[secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url'),encodeURIComponent(secret),JSON.stringify(secret).slice(1,-1),Array.from(secret,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')];
for(const [i,value] of [...variants,'hf_'+'a'.repeat(32),'AKIA'+'A'.repeat(16),'Authorization: Bearer abcdefghijklmnop','-----BEGIN PRIVATE KEY-----'].entries()){
 test(`rejects secret variant or credential ${i} across every boundary and repeated sources`,async()=>{
  const b=Buffer.from('prefix '+value+' suffix');
  for(let split=1;split<b.length;split++){
   let disposed=false;
   const open=async()=>({async *[Symbol.asyncIterator](){try{yield b.subarray(0,split);yield b.subarray(split);}finally{disposed=true;}}});
   await assert.rejects(preflightHfFiles([file(b),file(b)],{open,forbiddenValues:[secret]}),generic);
   assert.equal(disposed,true);
  }
 });
}
test('checks every repeated file and binary safetensor-like content',async()=>{
 const b=Buffer.from([8,0,0,0,0,0,0,0,123,125,0,255,254,128]);let opens=0;
 await preflightHfFiles([file(b),file(b)],{open:async()=>{opens++;return source(b);},forbiddenValues:[]});assert.equal(opens,2);
 await assert.rejects(preflightHfFiles([file(b),file(b)],{open:async()=>source(++opens===4?Buffer.alloc(b.length):b),forbiddenValues:[]}),generic);
});
test('rejects truncated, oversized, empty nonempty-file sources and malformed metadata',async()=>{
 const b=Buffer.from('weights');
 for(const bytes of [b.subarray(1),Buffer.concat([b,b]),Buffer.alloc(0)])await assert.rejects(preflightHfFiles([file(b)],{open:async()=>source(bytes),forbiddenValues:[]}),generic);
 for(const size of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(preflightHfFiles([{...file(b),size}],{open:async()=>source(b),forbiddenValues:[]}),generic);
 await preflightHfFiles([file(Buffer.alloc(0))],{open:async()=>source(Buffer.alloc(0)),forbiddenValues:[]});
});
test('bounds known values and source chunk memory',async()=>{
 const b=Buffer.from('ok');let opens=0;const open=async()=>{opens++;return source(b);};
 for(const forbiddenValues of [Array(515).fill('x'),['x'.repeat(16385)],[''],Array.from({length:9},(_,i)=>String(i)+'x'.repeat(16383))])await assert.rejects(preflightHfFiles([file(b)],{open,forbiddenValues}),generic);
 assert.equal(opens,0);
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>source(new Uint8Array(1024*1024+1)),forbiddenValues:[]}),generic);
});
test('cancels held web stream reads deterministically',async()=>{
 const controller=new AbortController();let cancelled=false;let started!:()=>void;
 const ready=new Promise<void>(r=>{started=r;});
 const pending=preflightHfFiles([file(Buffer.from('x'))],{open:async()=>new ReadableStream<Uint8Array>({pull(){started();return new Promise(()=>{});},cancel(){cancelled=true;}}),forbiddenValues:[],signal:controller.signal});
 await ready;controller.abort(new Error('private-path secret'));await assert.rejects(pending,generic);assert.equal(cancelled,true);
});
test('returns held async iterator on abort without awaiting next',async()=>{
 const controller=new AbortController();let returned=0;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
 const pending=preflightHfFiles([file(Buffer.from('x'))],{open:async()=>({[Symbol.asyncIterator](){return {next(){started();return new Promise<IteratorResult<Uint8Array>>(()=>{});},async return(){returned++;return {done:true,value:undefined};}};}}),forbiddenValues:[],signal:controller.signal});
 await ready;controller.abort();await assert.rejects(pending,generic);assert.equal(returned,1);
});
test('sanitizes source and activity errors and honors pre-abort',async()=>{
 const b=Buffer.from('x');let returned=false;
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>{throw Error(secret);},forbiddenValues:[]}),generic);
 let calls=0;
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>({async *[Symbol.asyncIterator](){try{yield b;}finally{returned=true;}}}),forbiddenValues:[],assertActive(){if(++calls>3)throw Error(secret);}}),generic);
 assert.equal(returned,true);
 const c=new AbortController();c.abort();await assert.rejects(preflightHfFiles([file(b)],{open:async()=>{throw Error('must not open');},forbiddenValues:[],signal:c.signal}),generic);
});
test('streams representative weights using a reused bounded chunk',async()=>{
 const chunk=Buffer.alloc(64*1024,0xab),count=512,hash=createHash('sha256');for(let i=0;i<count;i++)hash.update(chunk);
 let reads=0;
 await preflightHfFiles([{...file(chunk),size:chunk.length*count,sha256:hash.digest('hex')}],{open:async()=>({async *[Symbol.asyncIterator](){for(let i=0;i<count;i++){reads++;yield chunk;}}}),forbiddenValues:[]});assert.equal(reads,count);
});
test('disposes a source which opens after cancellation',async()=>{
 const c=new AbortController();let opened!:(s:ReadableStream<Uint8Array>)=>void;let cancelled=0;
 const pending=preflightHfFiles([file(Buffer.from('x'))],{open:()=>new Promise(r=>{opened=r;}),forbiddenValues:[],signal:c.signal});
 c.abort();await assert.rejects(pending,generic);
 opened(new ReadableStream({cancel(){cancelled++;}}));
 await new Promise<void>(r=>setImmediate(r));assert.equal(cancelled,1);
});
test('detects maximum length escaped values over internal scanning slices',async()=>{
 const value='\u1234'.repeat(1024),escaped='\\u1234'.repeat(1024),b=Buffer.from('x'.repeat(16000)+escaped);
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>source(b),forbiddenValues:[value]}),generic);
});
test('invokes failing iterator cleanup once without exposing cleanup errors',async()=>{
 let returns=0;
 await assert.rejects(preflightHfFiles([file(Buffer.from('ok'))],{open:async()=>({[Symbol.asyncIterator](){return {async next(){throw Error(secret);},async return(){returns++;throw Error(secret);}};}}),forbiddenValues:[]}),generic);
 assert.equal(returns,1);
});
test('retains the full maximum URL-encoded Unicode value across chunks',async()=>{
 const value='한'.repeat(1024),b=Buffer.from(encodeURIComponent(value));
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>({async *[Symbol.asyncIterator](){yield b.subarray(0,9000);yield b.subarray(9000);}}),forbiddenValues:[value]}),generic);
});

test('accepts management PEM, 8192 character HF token and 256 configured values on clean weights',async()=>{
 const pem='-----BEGIN PRIVATE KEY-----\n'+'A'.repeat(4096)+'\n-----END PRIVATE KEY-----';
 const token='hf_'+'b'.repeat(8189),b=Buffer.alloc(64*1024,0xaa);
 await preflightHfFiles([file(b)],{open:async()=>source(b),forbiddenValues:[pem,token,...Array.from({length:254},(_,i)=>`configured-secret-${i}`)]});
});
test('detects long secret variants across source and internal boundaries after opening',async()=>{
 for(const value of ['-----BEGIN PRIVATE KEY-----\n'+'A'.repeat(4096)+'\n-----END PRIVATE KEY-----','hf_'+'b'.repeat(8189),'한'.repeat(16384)]){
  const variants=[value,Buffer.from(value).toString('base64'),Buffer.from(value).toString('base64url'),encodeURIComponent(value),JSON.stringify(value).slice(1,-1),Array.from(value,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')];
  for(const variant of variants){
   const b=Buffer.from('prefix '+variant+' suffix');let opens=0,disposed=false;
   await assert.rejects(preflightHfFiles([file(b)],{open:async()=>{opens++;return {async *[Symbol.asyncIterator](){try{for(let i=0;i<b.length;i+=7000)yield b.subarray(i,i+7000);}finally{disposed=true;}}};},forbiddenValues:[value]}),generic);
   assert.equal(opens,1);assert.equal(disposed,true);
  }
 }
});
test('fails closed before opening when variant memory budget is exceeded',async()=>{
 let opens=0;const b=Buffer.from('safe');
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>{opens++;return source(b);},forbiddenValues:Array.from({length:8},(_,i)=>String.fromCharCode(97+i).repeat(16384))}),generic);
 assert.equal(opens,0);
});

test('accepts 256 distinct configured values plus a new duplicated HF authorization token',async()=>{
 const b=Buffer.alloc(1024,0xaa),token='hf_'+'z'.repeat(8189);
 const configured=Array.from({length:256},(_,i)=>`configured-value-${i}`);
 await preflightHfFiles([file(b)],{open:async()=>source(b),forbiddenValues:[token,...configured,token]});
});
test('deduplicates authorization values before raw and variant budget accounting',async()=>{
 const b=Buffer.alloc(1024,0xaa),token='hf_'+'z'.repeat(8189);
 await preflightHfFiles([file(b)],{open:async()=>source(b),forbiddenValues:Array(514).fill(token)});
});
test('rejects 258 unique values before opening',async()=>{
 let opens=0;const b=Buffer.from('safe');
 await assert.rejects(preflightHfFiles([file(b)],{open:async()=>{opens++;return source(b);},forbiddenValues:Array.from({length:258},(_,i)=>`configured-value-${i}`)}),generic);
 assert.equal(opens,0);
});
