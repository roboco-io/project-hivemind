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
