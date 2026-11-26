import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createActionTool} from '../src/runtime/autonomous-action-mcp.ts';
import {largeServer,largeLease} from './large-server-fixture.ts';

const worker='large-worker-token-value',runtimeId='12345678-1234-4234-8234-123456789012',digest='d'.repeat(64);
function privateInput(profiles:string[]){return {version:1 as const,runtimeId,request:{taskId:'task',executionLease:largeLease,maxRunMs:60000,externalProfiles:profiles},control:{origin:'https://control.example',workerToken:worker}};}
const published=(over:object)=>({requestId:'req-1',phase:'broker',actionId:'action-1',status:'succeeded',upperBoundMicros:100,reservedMicros:100,verifiedCostMicros:null,billingFinal:false,cleanupStatus:'none',...over});
interface Call{url:string;body?:any}
// Swappable server: by default large routes hit the real handler and store; SUPERLITE_REAL=1 is the same here because
// the large side is already real, and only the external-action reply is a fixture.
function fixture(reply:(request:any)=>object){
 const large=largeServer(runtimeId,worker),calls:Call[]=[];
 const fetchImpl=(async(url:string,init?:RequestInit)=>{
  if(String(url).includes('/external-large/'))return large.fetchImpl(url,init);
  const body=JSON.parse(String(init!.body));calls.push({url:String(url),body});
  if(String(url).endsWith('/external-artifact'))return Response.json({artifactDigest:digest});
  return Response.json(reply(body.request));
 }) as typeof fetch;
 return {large,calls,fetchImpl};
}
const none=undefined as unknown as string;void none;
test('aws.s3.put forwards exactly keySuffix and artifactDigest; extra or unsafe fields never reach the network',async()=>{
 const f=fixture(r=>published({operation:'aws.s3.put',effect:'retained',requestId:r.requestId}));
 const tool=createActionTool(privateInput(['s3']),{fetchImpl:f.fetchImpl});
 const ok=await tool({profileId:'s3',requestId:'req-1',operation:'aws.s3.put',parameters:{keySuffix:'t1/model.json',artifactDigest:digest}});
 assert.equal(ok.isError,undefined);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0]!.body.request,{profileId:'s3',requestId:'req-1',operation:'aws.s3.put',parameters:{keySuffix:'t1/model.json',artifactDigest:digest}});
 f.calls.length=0;
 for(const parameters of [{keySuffix:'t1/m.json',artifactDigest:digest,bucket:'other'},{keySuffix:'../x',artifactDigest:digest},{keySuffix:'a//b',artifactDigest:digest},{keySuffix:'/a',artifactDigest:digest},{keySuffix:'a/',artifactDigest:digest},{keySuffix:'a\\b',artifactDigest:digest},{keySuffix:'%2e%2e/x',artifactDigest:digest},{keySuffix:'x'.repeat(241),artifactDigest:digest},{keySuffix:'ok',artifactDigest:'zz'}]){
  const bad=await tool({profileId:'s3',requestId:'req-2',operation:'aws.s3.put',parameters});assert.equal(bad.isError,true,JSON.stringify(parameters));
 }
 assert.equal(f.calls.length,0);
});
test('aws.s3.put accepts an inline artifact like the other commit operations',async()=>{
 const f=fixture(r=>published({operation:'aws.s3.put',effect:'retained',requestId:r.requestId}));
 const tool=createActionTool(privateInput(['s3']),{fetchImpl:f.fetchImpl});
 const result=await tool({profileId:'s3',requestId:'req-1',operation:'aws.s3.put',artifact:{files:[{path:'a.txt',contentBase64:Buffer.from('hi').toString('base64')}]},parameters:{keySuffix:'a.txt',artifactDigest:digest}});
 assert.equal(result.isError,undefined);assert.deepEqual(f.calls.map(c=>c.url.split('/').at(-1)),['external-artifact','external-action']);
});
test('aws.s3.inspect takes only putActionId',async()=>{
 const f=fixture(r=>published({operation:'aws.s3.inspect',effect:'none',requestId:r.requestId}));
 const tool=createActionTool(privateInput(['s3']),{fetchImpl:f.fetchImpl});
 assert.equal((await tool({profileId:'s3',requestId:'req-3',operation:'aws.s3.inspect',parameters:{putActionId:'action-1'}})).isError,undefined);
 assert.deepEqual(f.calls[0]!.body.request.parameters,{putActionId:'action-1'});
 f.calls.length=0;
 for(const parameters of [{putActionId:'action-1',key:'x'},{},{putActionId:'bad id'},{artifactDigest:digest}])assert.equal((await tool({profileId:'s3',requestId:'req-4',operation:'aws.s3.inspect',parameters})).isError,true);
 assert.equal(f.calls.length,0);
});
test('hf.model.lfs_commit uploads largeArtifact paths, then submits the manifest digest returned by the server',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcp-large-')),f=fixture(r=>published({operation:'hf.model.lfs_commit',effect:'retained',requestId:r.requestId,providerResult:{kind:'hf_commit',oid:'c'.repeat(40)}}));
 try{
  const data=Buffer.alloc(1000,3);await writeFile(join(root,'w.bin'),data);
  const tool=createActionTool(privateInput(['hf']),{fetchImpl:f.fetchImpl,workspaceRoot:root});
  const result=await tool({profileId:'hf',requestId:'req-5',operation:'hf.model.lfs_commit',largeArtifact:{paths:['w.bin']},parameters:{message:'add weights'}}) as any;
  assert.equal(result.isError,undefined,JSON.stringify(result));
  const [manifestDigest]=[...f.large.manifests.keys()];assert.match(manifestDigest!,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.at(-1)!.body.request,{profileId:'hf',requestId:'req-5',operation:'hf.model.lfs_commit',parameters:{manifestDigest,message:'add weights'}});
  assert.deepEqual(f.large.seen.map(x=>x.op),['begin','part','complete','manifest']);
  assert.deepEqual(result.structuredContent.providerResult,{kind:'hf_commit',oid:'c'.repeat(40)});
  // The large routes receive the approved profile, runtime and lease, never a model-chosen owner.
  assert.equal(f.large.seen[0]!.json.profileId,'hf');assert.equal(f.large.seen[0]!.json.runtimeId,runtimeId);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('hf.model.lfs_commit needs exactly one source and refuses unsafe paths before any request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcp-large-')),outside=await mkdtemp(join(tmpdir(),'mcp-outside-')),f=fixture(r=>published({requestId:r.requestId,operation:'hf.model.lfs_commit',effect:'retained'}));
 try{
  await writeFile(join(root,'w.bin'),'x');await writeFile(join(outside,'s.bin'),'secret');await symlink(join(outside,'s.bin'),join(root,'link.bin'));
  const tool=createActionTool(privateInput(['hf']),{fetchImpl:f.fetchImpl,workspaceRoot:root});
  const base={profileId:'hf',requestId:'req-6',operation:'hf.model.lfs_commit'};
  for(const input of [
   {...base,parameters:{message:'m'}},
   {...base,largeArtifact:{paths:['w.bin']},parameters:{message:'m',manifestDigest:digest}},
   {...base,largeArtifact:{paths:['../x']},parameters:{message:'m'}},
   {...base,largeArtifact:{paths:['link.bin']},parameters:{message:'m'}},
   {...base,largeArtifact:{paths:[]},parameters:{message:'m'}},
   {...base,largeArtifact:{paths:['w.bin'],extra:1},parameters:{message:'m'}},
   {...base,largeArtifact:{paths:['w.bin']},parameters:{message:'m '.repeat(101)}},
   {...base,largeArtifact:{paths:['w.bin']},parameters:{message:'leak '+worker}},
  ])assert.equal((await tool(input)).isError,true,JSON.stringify(input));
  assert.equal(f.calls.length,0);assert.equal(f.large.seen.filter(x=>x.op!=='begin'||false).length,0,'only validated files may reach begin');
  // A previously uploaded manifest can be committed again without re-sending files.
  const again=await tool({...base,parameters:{manifestDigest:digest,message:'m'}});assert.equal(again.isError,undefined);assert.equal(f.calls.length,1);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('result projection: lfs commit must carry an hf commit and s3 results carry no provider result',async()=>{
 const mismatched=fixture(r=>published({operation:'hf.model.lfs_commit',effect:'retained',requestId:r.requestId,providerResult:{kind:'aws_instance',id:'i-0123456789abcdef0'}}));
 assert.equal((await createActionTool(privateInput(['hf']),{fetchImpl:mismatched.fetchImpl})({profileId:'hf',requestId:'req-7',operation:'hf.model.lfs_commit',parameters:{manifestDigest:digest,message:'m'}})).isError,true);
 const s3=fixture(r=>published({operation:'aws.s3.put',effect:'retained',requestId:r.requestId,providerResult:{kind:'hf_commit',oid:'c'.repeat(40)}}));
 assert.equal((await createActionTool(privateInput(['s3']),{fetchImpl:s3.fetchImpl})({profileId:'s3',requestId:'req-8',operation:'aws.s3.put',parameters:{keySuffix:'a',artifactDigest:digest}})).isError,true);
 const wrongEffect=fixture(r=>published({operation:'hf.model.lfs_commit',effect:'resource',requestId:r.requestId,providerResult:{kind:'hf_commit',oid:'c'.repeat(40)}}));
 assert.equal((await createActionTool(privateInput(['hf']),{fetchImpl:wrongEffect.fetchImpl})({profileId:'hf',requestId:'req-9',operation:'hf.model.lfs_commit',parameters:{manifestDigest:digest,message:'m'}})).isError,true);
});
