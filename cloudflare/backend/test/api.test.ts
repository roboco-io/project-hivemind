import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi,MAX_BODY_BYTES,type ApiService,ApiError} from '../src/cloudflare/api.ts';
import {createSnapshot} from '../src/snapshot.ts';

const token='fixture-control-token';
const snapshot=createSnapshot([]);
const spec={provider:'codex',credentialId:'primary',snapshotId:snapshot.digest,instructions:'Change the fixture',checks:[{id:'test',argv:['node','--test'],timeoutMs:10000}],timeoutMs:60000,idempotencyKey:'request-1'};
function fixture(){const calls:{method:string;args:unknown[]}[]=[];const service=Object.fromEntries(['putSnapshot','registerCredential','credentials','submit','jobs','job','cancel','result'].map(method=>[method,async(...args:unknown[])=>{calls.push({method,args});return {accepted:true};}])) as unknown as ApiService;return {calls,service};}
function request(path:string,method='GET',value?:unknown,auth=true){return new Request(`https://fixture${path}`,{method,headers:{...(auth?{authorization:`Bearer ${token}`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});}
test('public health has no operational details and no service invocation',async()=>{const f=fixture();const response=await handleApi(request('/health'),undefined,f.service);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,service:'hivemind-cloudflare'});assert.equal(f.calls.length,0);});
test('authentication precedes parsing and service calls',async()=>{const f=fixture();const malformed=()=>new Request('https://fixture/v1/jobs',{method:'POST',body:'not-json'});assert.equal((await handleApi(malformed(),undefined,f.service)).status,503);assert.equal((await handleApi(malformed(),token,f.service)).status,401);assert.equal(f.calls.length,0);});
test('bounded streaming rejects oversized bodies even without content length',async()=>{const f=fixture();const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_BODY_BYTES));controller.enqueue(new Uint8Array(1));controller.close();}});const r=new Request('https://fixture/v1/jobs',{method:'POST',headers:{authorization:`Bearer ${token}`},body:stream,duplex:'half'} as RequestInit);assert.equal((await handleApi(r,token,f.service)).status,413);assert.equal(f.calls.length,0);});
test('invalid JSON, fields, digest and subscription auth fail before service calls',async()=>{const f=fixture();for(const r of [new Request('https://fixture/v1/jobs',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{' }),request('/v1/jobs','POST',{...spec,exec:'arbitrary'}),request(`/v1/snapshots/${'a'.repeat(64)}`,'PUT',snapshot),request('/v1/credentials/main','POST',{provider:'codex',auth:JSON.stringify({OPENAI_API_KEY:'fixture'})}),request('/v1/credentials/main','POST',{provider:'claude',auth:'two words'})])assert.equal((await handleApi(r,token,f.service)).status,400);assert.equal(f.calls.length,0);});
test('only fixed documented routes dispatch and job input is validated',async()=>{const f=fixture();const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh'}});const routes:[string,string,unknown,number,string][]=[[`/v1/snapshots/${snapshot.digest}`,'PUT',snapshot,201,'putSnapshot'],['/v1/credentials/main','POST',{provider:'codex',auth},201,'registerCredential'],['/v1/credentials','GET',undefined,200,'credentials'],['/v1/jobs','POST',spec,202,'submit'],['/v1/jobs','GET',undefined,200,'jobs'],['/v1/jobs/fixture','GET',undefined,200,'job'],['/v1/jobs/fixture/cancel','POST',undefined,202,'cancel'],['/v1/jobs/fixture/result','GET',undefined,200,'result']];for(const [path,method,body,status,called]of routes){assert.equal((await handleApi(request(path,method,body),token,f.service)).status,status);assert.equal(f.calls.at(-1)?.method,called);}assert.deepEqual(f.calls.find(c=>c.method==='submit')?.args,[spec]);for(const path of ['/v1/exec','/v1/jobs/fixture/exec','/v1/credentials/main/auth','/v1/jobs/fixture/result/extra'])assert.equal((await handleApi(request(path,'POST',{}),token,f.service)).status,404);assert.equal(f.calls.length,routes.length);});
test('internal error details never enter responses',async()=>{const f=fixture();f.service.jobs=async()=>{throw new Error('fixture-sensitive-internal-data');};const response=await handleApi(request('/v1/jobs'),token,f.service);assert.equal(response.status,500);assert.doesNotMatch(await response.text(),/fixture-sensitive/);f.service.jobs=async()=>{throw new ApiError(409);};assert.equal((await handleApi(request('/v1/jobs'),token,f.service)).status,409);});

test('fixed RealWorld command replay accepts only a Terra probe',async()=>{
 const f=fixture();
 const calls:unknown[][]=[];
 const service={...f.service,createCarbon:async(...args:unknown[])=>{calls.push(args);return {ok:true};}};
 const body={snapshotId:'a'.repeat(64),requestId:'replay',probe:true,latency:'replay'};
 assert.equal((await handleApi(request('/v1/terra-benchmarks','POST',{...body,probe:false}),token,service)).status,400);
 assert.equal((await handleApi(request('/v1/carbon-benchmarks','POST',body),token,service)).status,400);
 assert.equal((await handleApi(request('/v1/terra-benchmarks','POST',body),token,service)).status,202);
 assert.deepEqual(calls,[[body.snapshotId,'replay',true,'terra',undefined,undefined,'replay']]);
});

test('npm cache replay requires an explicit supported size and a probe',async()=>{
 const f=fixture();
 const calls:unknown[][]=[];
 const service={...f.service,createCarbon:async(...args:unknown[])=>{calls.push(args);return {ok:true};}};
 const body={snapshotId:'a'.repeat(64),requestId:'cache-replay',probe:true,latency:'cache-replay'};
 for(const invalid of [body,{...body,instance:'standard-4'},{...body,instance:'standard-3',probe:false}]){
  assert.equal((await handleApi(request('/v1/terra-benchmarks','POST',invalid),token,service)).status,400);
 }
 assert.equal((await handleApi(request('/v1/terra-benchmarks','POST',{...body,instance:'standard-3'}),token,service)).status,202);
 assert.deepEqual(calls,[[body.snapshotId,'cache-replay',true,'terra','standard-3',undefined,'cache-replay']]);
});

test('compute groups authenticate, validate their bound workload and dispatch explicit lifecycle routes',async()=>{
 const f=fixture();
 const calls:unknown[]=[];
 const service={...f.service,
  createComputeGroup:async(spec:unknown)=>{calls.push(spec);return {id:'11111111-1111-4111-8111-111111111111',status:'DRAFT'};},
  approveComputeGroup:async(id:string)=>({id,status:'RUNNING'}),
  computeGroup:async(id:string)=>({group:{id,status:'RUNNING'},jobs:[]}),
  cancelComputeGroup:async(id:string)=>({id,status:'CANCELLED'}),
 };
 const body={snapshotId:'a'.repeat(64),idempotencyKey:'group',concurrency:2,instance:'standard-3',
  checks:[0,1,2,3].map(i=>({id:'s'+i,argv:['node','run-shard.mjs',String(i)],timeoutMs:10000})),
  integration:{id:'all',argv:['node','run-shard.mjs','all'],timeoutMs:10000}};
 assert.equal((await handleApi(request('/v1/compute-groups','POST',body,false),token,service)).status,401);
 assert.equal((await handleApi(request('/v1/compute-groups','POST',{...body,concurrency:3}),token,service)).status,400);
 assert.equal((await handleApi(request('/v1/compute-groups','POST',body),token,service)).status,201);
 assert.equal(calls.length,1);
 const root='/v1/compute-groups/11111111-1111-4111-8111-111111111111';
 assert.equal((await handleApi(request(root+'/approve','POST',{}),token,service)).status,202);
 assert.equal((await handleApi(request(root),token,service)).status,200);
 assert.equal((await handleApi(request(root+'/cancel','POST',{}),token,service)).status,202);
});

test('large artifact multipart routes authenticate before bounded binary parsing',async()=>{
 const f=fixture(),calls:unknown[]=[];
 const service={...f.service,beginLargeArtifact:async(ref:unknown)=>{calls.push(ref);return {id:'11111111-1111-4111-8111-111111111111'}},putLargeArtifactPart:async(id:string,n:number,data:Uint8Array)=>{calls.push([id,n,data.length]);return {accepted:true}},completeLargeArtifact:async()=>({status:'complete'}),abortLargeArtifact:async()=>({status:'aborted'}),largeArtifact:async()=>({contentHashVerification:'runtime-required'})};
 const ref={name:'data',sha256:'a'.repeat(64),sizeBytes:3,format:'file',expandedBytes:3,maxFiles:1};
 assert.equal((await handleApi(request('/v1/large-artifact-uploads','POST',{ref},false),token,service)).status,401);
 assert.equal((await handleApi(request('/v1/large-artifact-uploads','POST',{ref}),token,service)).status,201);
 const path='https://fixture/v1/large-artifact-uploads/11111111-1111-4111-8111-111111111111/parts/1';
 const part=(length:string,auth=true)=>new Request(path,{method:'PUT',headers:{'content-length':length,...(auth?{authorization:'Bearer '+token}:{})},body:new Uint8Array(3)});
 assert.equal((await handleApi(part('999999999',false),token,service)).status,401);
 assert.equal((await handleApi(part('999999999'),token,service)).status,413);
 assert.equal((await handleApi(part('4'),token,service)).status,400);
 assert.equal((await handleApi(part('3'),token,service)).status,200);
 assert.deepEqual(calls[1],['11111111-1111-4111-8111-111111111111',1,3]);
});
