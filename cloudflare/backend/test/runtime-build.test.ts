import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {buildRuntimeManifest,writeRuntimeManifest,checkRuntimeManifest,RUNTIME_FIXED_INPUTS} from '../scripts/runtime-build.ts';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'hive-build-stamp-'));for(const path of [...RUNTIME_FIXED_INPUTS,'backend/src/runtime/run.ts','backend/src/cloudflare/worker.ts','backend/native/guard.c']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'public '+path);}return root;}
test('runtime manifest is deterministic and excludes private, test and scratch files',async()=>{
 const root=await fixture();try{
  for(const path of ['.hivemind/credentials.json','work/private.ts','backend/test/private.test.ts','backend/src/.private/auth.ts']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'PRIVATE_FIXTURE');}
  const first=await buildRuntimeManifest(root),second=await buildRuntimeManifest(root);assert.deepEqual(first,second);assert.equal(first.version,1);assert.equal(first.files['backend/src/runtime/run.ts'],createHash('sha256').update('public backend/src/runtime/run.ts').digest('hex'));assert.ok(Object.keys(first.files).includes('backend/scripts/runtime-build.ts'));assert.ok(!JSON.stringify(first).includes('PRIVATE_FIXTURE'));assert.ok(!Object.keys(first.files).some(path=>/\.hivemind|\.private|\/test\/|^work\//.test(path)));
  await writeRuntimeManifest(root);assert.deepEqual(await buildRuntimeManifest(root),first);assert.equal(await checkRuntimeManifest(root),true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('runtime changes alter the digest and stale or tampered manifests fail checking',async()=>{
 const root=await fixture();try{
  assert.equal(await checkRuntimeManifest(root),false);const first=await writeRuntimeManifest(root);await writeFile(join(root,'backend/src/runtime/run.ts'),'changed public runtime');const next=await buildRuntimeManifest(root);assert.notEqual(first.digest,next.digest);assert.equal(await checkRuntimeManifest(root),false);await writeRuntimeManifest(root);assert.equal(await checkRuntimeManifest(root),true);await writeFile(join(root,'backend/runtime-build.json'),'{}');assert.equal(await checkRuntimeManifest(root),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('public input symlinks are rejected without reading their target',async()=>{
 const root=await fixture();try{await writeFile(join(root,'outside-private'),'PRIVATE_FIXTURE');await symlink(join(root,'outside-private'),join(root,'backend/src/escape.ts'));await assert.rejects(buildRuntimeManifest(root),/Invalid runtime build input/);}finally{await rm(root,{recursive:true,force:true});}
});
test('oversized public inputs fail closed before producing a manifest',async()=>{
 const root=await fixture();try{await writeFile(join(root,'backend/src/oversized.ts'),Buffer.alloc(2*1024*1024+1));await assert.rejects(buildRuntimeManifest(root),/Invalid runtime build input/);}finally{await rm(root,{recursive:true,force:true});}
});
