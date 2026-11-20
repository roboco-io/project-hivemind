import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {remotePilot} from '../scripts/duckdb-pilot/remote.ts';
const id='11111111-1111-4111-8111-111111111111';
const ref={name:'source',sha256:'2e1a219620dd1ca6bf055600417bdf9a1700e04c5c1ff41e4029752595137785',sizeBytes:98302940,format:'tar.gz',expandedBytes:2147483648,maxFiles:100000};
async function scenario(kind:'pass'|'missing-boundary'|'expired'){
 const root=await mkdtemp(join(tmpdir(),'duckdb-remote-test-')),prior=globalThis.fetch,calls:string[]=[];
 const source=join(root,'source.json'),secret=join(root,'control.json'),out=join(root,'output');await writeFile(source,JSON.stringify({ref}));await writeFile(secret,JSON.stringify({CONTROL_TOKEN:'fixture-control'}),{mode:0o600});
 const approvedAt=Date.now()-600000,deadline=kind==='expired'?Date.now()-31000:Date.now()+60000;
 const body={passed:true,boundaries:{passed:true,credentialsAbsent:true,scratchWritable:true,sourceUnchanged:true,sourceTree:{files:14010,bytes:260659090},checks:kind==='missing-boundary'?[]:['source-write','source-delete','runtime-input-read','proc-root-runtime-input-read'].map(name=>({name,blocked:true,code:'EACCES',classification:'permission-denied'}))}};
 const result={group:{id,status:kind==='expired'?'CANCELLED':'SUCCEEDED',approvedAt,finishedAt:Date.now()},jobs:[{job:{id:'job',status:kind==='expired'?'CANCELLED':'SUCCEEDED',containerStopped:true},result:{process:{stdout:JSON.stringify(body)},boundary:{verified:true},largeArtifacts:{receipts:[ref]}}}],integration:{job:{id:'integration',status:'SUCCEEDED',containerStopped:true},result:{process:{stdout:'{"passed":true}'}}}};
 globalThis.fetch=async(input,init)=>{
  const path=new URL(input instanceof Request?input.url:String(input)).pathname;calls.push((init?.method??'GET')+' '+path);
  if(path==='/health')return Response.json({expectedRuntimeRevision:'d'.repeat(64)});
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-control');
  if(path.startsWith('/v1/snapshots/'))return Response.json({});
  if(path==='/v1/compute-groups'){const spec=JSON.parse(String(init?.body));assert.equal(spec.instance,'standard-4');assert.equal(spec.checks.length,1);return Response.json({id,status:'DRAFT'});}
  if(path.endsWith('/approve'))return Response.json({id,approvedAt,deadline});
  if(path.endsWith('/cancel'))return Response.json({id,status:'CANCELLED'});
  return Response.json(result);
 };
 try{
  const args=['boundary',out,source,'-','https://fixture',secret];
  if(kind==='pass'){await remotePilot(args);const count=calls.length;await remotePilot(args);assert.equal(calls.length,count);}
  else await assert.rejects(remotePilot(args),/did not satisfy verification/);
  const saved=JSON.parse(await readFile(join(out,'boundary','result.json'),'utf8'));assert.equal(saved.validation.passed,kind==='pass');
  assert.equal(calls.filter(p=>p.endsWith('/cancel')).length,kind==='expired'?1:0);
  assert.ok(!JSON.stringify(saved).includes('fixture-control'));
 }finally{globalThis.fetch=prior;await rm(root,{recursive:true,force:true});}
}
test('remote pilot stores one group and reuses completed verified result without a second request',()=>scenario('pass'));
test('remote pilot rejects a successful runtime missing required boundary evidence',()=>scenario('missing-boundary'));
test('remote pilot cancels an expired server deadline and confirms stopped children',()=>scenario('expired'));

test('ccache modes use the same build snapshot and only run C3 and C4',async()=>{
 const root=await mkdtemp(join(tmpdir(),'duckdb-remote-cache-'));
 const priorFetch=globalThis.fetch,priorRevision=process.env.DUCKDB_MATRIX_RUNTIME,priorCampaign=process.env.DUCKDB_CACHE_CAMPAIGN;
 const revision='d'.repeat(64);
 process.env.DUCKDB_MATRIX_RUNTIME=revision;
 process.env.DUCKDB_CACHE_CAMPAIGN='fixture-campaign';
 const source=join(root,'source.json'),data=join(root,'data.json'),control=join(root,'control.json');
 const dataRef={name:'data',sha256:'a'.repeat(64),sizeBytes:1024,format:'file',expandedBytes:1024,maxFiles:1};
 const artifactSha='b'.repeat(64);
 try{
  await writeFile(source,JSON.stringify({ref}));
  await writeFile(data,JSON.stringify({ref:dataRef}));
  await writeFile(control,JSON.stringify({CONTROL_TOKEN:'fixture-control'}),{mode:0o600});
  const snapshots=new Set<string>();
  for(const mode of ['seed','cold','warm','missing-warm'] as const){
   const condition=mode==='missing-warm'?'warm':mode;
   globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/health')return Response.json({expectedRuntimeRevision:revision});
    if(path.startsWith('/v1/snapshots/')){
     const body=JSON.parse(String(init?.body));
     snapshots.add(body.digest);
     const config=body.files.find((f:{path:string})=>f.path==='runner-config.json');
     assert.deepEqual(JSON.parse(Buffer.from(config.content,'base64').toString()),{
      phase:'build',commit:'68d7555f68bd25c1a251ccca2e6338949c33986a',jemallocOff:true,ccache:true,cacheCampaign:'fixture-campaign',
     });
     return Response.json({});
    }
    if(path==='/v1/compute-groups'){
     const spec=JSON.parse(String(init?.body));
     assert.equal(spec.instance,'standard-4');
     assert.equal(spec.concurrency,2);
     assert.deepEqual(spec.checks.map((check:{argv:string[]})=>check.argv),[
      ['node','runner.mjs','C3',condition],['node','runner.mjs','C4',condition],
     ]);
     return Response.json({id,status:'DRAFT'});
    }
    if(path.endsWith('/approve'))return Response.json({id,approvedAt:Date.now(),deadline:Date.now()+60000});
    return Response.json({
     group:{id,status:'SUCCEEDED'},
     jobs:['C3','C4'].map(profile=>{
      const checks=['source-write','source-delete','runtime-input-read','proc-root-runtime-input-read','data-write','data-delete']
       .map(name=>({name,blocked:true,code:'EACCES',classification:'permission-denied'}));
      const receipt={profile,passed:true,cacheStats:{version:'4.14.3',hits:0,directHits:0,preprocessedHits:0,misses:1,uncacheable:0,filesInCache:2,sizeKiB:8},
       boundaries:{passed:true,checks,data:{sha256:dataRef.sha256,bytes:1024,afterSha256:dataRef.sha256,afterBytes:1024,unchanged:true}},
       test:{passed:true,inventoryCount:16},toolchain:{compiler:{id:'Clang'},cmakeVersion:'3.31.6',ninjaVersion:'1.13.0'},
       ninja:{data:'fixture-ninja-evidence'},buildCpu:{usageUsec:1}};
      const buildCache=condition==='cold'?{mode:condition,restoreMs:0}:condition==='seed'
       ?{mode:condition,restoreMs:0,published:{sha256:artifactSha,sizeBytes:1,durationMs:1}}
       :{mode:condition,restoreMs:1,...(mode==='missing-warm'?{}:{restoredSha256:artifactSha,restoredBytes:1})};
      return {job:{status:'SUCCEEDED',checkId:profile,containerStopped:true},
       result:{process:{stdout:JSON.stringify(receipt)},boundary:{verified:true},largeArtifacts:{receipts:[ref,dataRef]},buildCache}};
     }),
     integration:{job:{status:'SUCCEEDED',containerStopped:true},result:{process:{stdout:'{"passed":true}'}}},
    });
   };
   const execution=remotePilot(['ccache-'+condition,join(root,mode),source,data,'https://fixture',control]);
   if(mode==='missing-warm')await assert.rejects(execution,/did not satisfy verification/);
   else await execution;
  }
  assert.equal(snapshots.size,1);
 }finally{
  globalThis.fetch=priorFetch;
  if(priorRevision===undefined)delete process.env.DUCKDB_MATRIX_RUNTIME;
  else process.env.DUCKDB_MATRIX_RUNTIME=priorRevision;
  if(priorCampaign===undefined)delete process.env.DUCKDB_CACHE_CAMPAIGN;
  else process.env.DUCKDB_CACHE_CAMPAIGN=priorCampaign;
  await rm(root,{recursive:true,force:true});
 }
});
