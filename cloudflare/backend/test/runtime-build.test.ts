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
test('Python extraction helper is bound into runtime revision and changes invalidate the stamp',async()=>{
 const root=await fixture();try{
  const path='backend/src/runtime/safe-tar.py';await writeFile(join(root,path),'# extractor v1\n');
  const first=await writeRuntimeManifest(root);assert.equal(first.files[path],createHash('sha256').update('# extractor v1\n').digest('hex'));
  await writeFile(join(root,path),'# extractor v2\n');const next=await buildRuntimeManifest(root);
  assert.notEqual(first.digest,next.digest);assert.equal(await checkRuntimeManifest(root),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
import * as runtimeBuild from '../scripts/runtime-build.ts';
import {readFile} from 'node:fs/promises';
async function contractFixture(){const root=await fixture(),sourceRoot=join(root,'source-repo');await mkdir(join(sourceRoot,'packages/contracts/src'),{recursive:true});const source='export interface Policy {tools:string[]}\nexport const tool="Bash";\n';await writeFile(join(sourceRoot,'packages/contracts/src/autonomous.ts'),source);return {root,sourceRoot,source};}
const syncContract=(options:{sourceRoot:string;runtimeRoot:string;check:boolean})=>(Reflect.get(runtimeBuild,'syncRuntimeAutonomousContract') as (options:unknown)=>Promise<{sourceHash:string;path:string}>)(options);
test('CLI shared contract seam vendors exact bytes and source hash without changing pure manifest fixtures',async()=>{
 const f=await contractFixture();try{const before=await buildRuntimeManifest(f.root);const result=await syncContract({sourceRoot:f.sourceRoot,runtimeRoot:f.root,check:false});assert.equal(await readFile(join(f.root,result.path),'utf8'),f.source);assert.equal(result.sourceHash,createHash('sha256').update(f.source).digest('hex'));assert.equal((await buildRuntimeManifest(f.root)).files[result.path],result.sourceHash);assert.notEqual((await buildRuntimeManifest(f.root)).digest,before.digest);await syncContract({sourceRoot:f.sourceRoot,runtimeRoot:f.root,check:true});}finally{await rm(f.root,{recursive:true,force:true});}
});
test('shared contract check rejects missing vendor, drift and nonbuiltin runtime dependencies',async()=>{
 const f=await contractFixture();try{const opts={sourceRoot:f.sourceRoot,runtimeRoot:f.root,check:true};await assert.rejects(syncContract(opts));await syncContract({...opts,check:false});await writeFile(join(f.root,'backend/src/runtime-shared/autonomous.ts'),'tampered');await assert.rejects(syncContract(opts));for(const source of ['import {x} from "outside-private";export const tool=x;','export * from "../../private";','export const x=()=>import("../../private");']){await writeFile(join(f.sourceRoot,'packages/contracts/src/autonomous.ts'),source);await assert.rejects(syncContract({...opts,check:false}));}}finally{await rm(f.root,{recursive:true,force:true});}
});
test('vendor sync rejects symlinked source or destination without copying private targets',async()=>{
 const f=await contractFixture();try{const source=join(f.sourceRoot,'packages/contracts/src/autonomous.ts');await rm(source);await writeFile(join(f.root,'private-target'),'PRIVATE_FIXTURE');await symlink(join(f.root,'private-target'),source);await assert.rejects(syncContract({sourceRoot:f.sourceRoot,runtimeRoot:f.root,check:false}));await rm(source);await writeFile(source,f.source);await mkdir(join(f.root,'backend/src/runtime-shared'));await symlink(join(f.root,'private-target'),join(f.root,'backend/src/runtime-shared/autonomous.ts'));await assert.rejects(syncContract({sourceRoot:f.sourceRoot,runtimeRoot:f.root,check:false}));assert.equal(await readFile(join(f.root,'private-target'),'utf8'),'PRIVATE_FIXTURE');}finally{await rm(f.root,{recursive:true,force:true});}
});
import {pathToFileURL} from 'node:url';
test('image-local policy modules import without any root packages directory or model call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hive-image-contract-'));
 try{
  for(const path of ['runtime-shared/autonomous.ts','runtime/autonomous-tool-hook.ts','runtime/autonomous-authorize.ts','autonomous-cloud-protocol.ts','snapshot.ts']){const target=join(root,'backend/src',path);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(new URL('../src/'+path,import.meta.url)));}
  const hook=await import(pathToFileURL(join(root,'backend/src/runtime/autonomous-tool-hook.ts')).href);
  assert.deepEqual(hook.validateAutonomousPolicy({version:1,tools:['Bash'],model:'pinned',subagentModel:'pinned'}).tools,['Bash']);
  const authorizer=await import(pathToFileURL(join(root,'backend/src/runtime/autonomous-authorize.ts')).href);assert.equal(typeof authorizer.guardCanonicalNativePolicy,'function');
  const protocol=await import(pathToFileURL(join(root,'backend/src/autonomous-cloud-protocol.ts')).href);assert.equal(typeof protocol.validateAutonomousCloudInput,'function');
 }finally{await rm(root,{recursive:true,force:true});}
});
