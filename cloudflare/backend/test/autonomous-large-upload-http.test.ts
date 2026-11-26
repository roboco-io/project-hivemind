import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {largeServer as server,largeLease as lease} from './large-server-fixture.ts';
import {uploadWorkspaceFiles,createLargePost,LARGE_PART_BYTES} from '../src/runtime/autonomous-large-upload.ts';
import {externalLargeManifestDigest} from '../../../packages/core/src/autonomous-external-large.ts';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const client=(s:ReturnType<typeof server>,token='worker-token')=>createLargePost({origin:'https://control.example',workerToken:token,taskId:'task',lease,runtimeId:'runtime-1',profileId:'hf',fetchImpl:s.fetchImpl});
test('real client and real handler agree on every wire shape; a second run resumes without re-sending parts',async()=>{
 const s=server(),root=await mkdtemp(join(tmpdir(),'large-http-'));
 try{
  const data=Buffer.alloc(LARGE_PART_BYTES+5,9);await writeFile(join(root,'model.bin'),data);
  const first=await uploadWorkspaceFiles({root,paths:['model.bin'],post:client(s)});
  const manifest=s.manifests.get(first.manifestDigest)!;
  assert.equal(externalLargeManifestDigest(manifest),first.manifestDigest);assert.equal(manifest.files[0]!.sha256,sha(data));
  assert.equal(sha(s.objects.get(manifest.files[0]!.storageRef)!),sha(data));
  assert.deepEqual(s.seen.map(x=>x.op),['begin','part','part','complete','manifest']);
  for(const x of s.seen){assert.equal(x.headers.get('authorization'),'Bearer worker-token');}
  const begin=s.seen[0]!.json;assert.deepEqual(Object.keys(begin).sort(),['file','lease','profileId','runtimeId']);assert.deepEqual(begin.file,{path:'model.bin',size:data.byteLength,sha256:sha(data)});
  const meta=JSON.parse(s.seen[1]!.headers.get('x-large-meta')!);assert.deepEqual(Object.keys(meta).sort(),['lease','part','profileId','runtimeId','uploadId']);assert.deepEqual([meta.part,JSON.parse(s.seen[2]!.headers.get('x-large-meta')!).part],[1,2]);
  assert.deepEqual(Object.keys(s.seen[4]!.json).sort(),['files','lease','profileId','runtimeId']);assert.deepEqual(Object.keys(s.seen[4]!.json.files[0]).sort(),['path','sha256','size']);
  s.seen.length=0;
  const again=await uploadWorkspaceFiles({root,paths:['model.bin'],post:client(s)});
  assert.equal(again.manifestDigest,first.manifestDigest);assert.deepEqual(s.seen.map(x=>x.op),['begin','complete','manifest'],'stored parts are skipped');
 }finally{s.db.close();await rm(root,{recursive:true,force:true});}
});
test('wrong worker token, redirects and non-JSON replies all end in the same generic error',async()=>{
 const s=server(),root=await mkdtemp(join(tmpdir(),'large-http-'));
 try{
  await writeFile(join(root,'a.bin'),'small');
  await assert.rejects(uploadWorkspaceFiles({root,paths:['a.bin'],post:client(s,'other-token')}),{message:'Large upload rejected or unavailable.'});
  const html=createLargePost({origin:'https://control.example',workerToken:'worker-token',taskId:'task',lease,runtimeId:'runtime-1',profileId:'hf',fetchImpl:(async()=>new Response('<html>',{headers:{'content-type':'text/html'}})) as typeof fetch});
  await assert.rejects(uploadWorkspaceFiles({root,paths:['a.bin'],post:html}),{message:'Large upload rejected or unavailable.'});
  assert.throws(()=>createLargePost({origin:'http://control.example',workerToken:'t',taskId:'task',lease,runtimeId:'r',profileId:'hf'}));
  assert.throws(()=>createLargePost({origin:'https://u:p@control.example',workerToken:'t',taskId:'task',lease,runtimeId:'r',profileId:'hf'}));
 }finally{s.db.close();await rm(root,{recursive:true,force:true});}
});
