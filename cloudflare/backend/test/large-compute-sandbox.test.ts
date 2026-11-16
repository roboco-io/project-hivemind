import test from 'node:test';
import assert from 'node:assert/strict';
import {computeSandboxArgs} from '../src/runtime/compute-sandbox.ts';
import {validateRuntimeInput} from '../src/runtime/providers.ts';
import {createSnapshot} from '../src/snapshot.ts';
test('large compute keeps sandbox enabled and carves readonly inputs out of denied runtime',()=>{
 const args=computeSandboxArgs({readOnly:['/runtime/large-inputs'],deny:['/runtime']});
 assert.equal(args[0],'codex');assert.equal(args[1],'sandbox');
 assert.ok(args.some(x=>x.includes('"/runtime/large-inputs"="read"')));
 assert.ok(args.some(x=>x.includes('"/runtime"="deny"')));
 assert.throws(()=>computeSandboxArgs({readOnly:['relative'],deny:[]}));
});
test('large artifacts are compute-only and require a bounded read capability',()=>{
 const refs=[{name:'data',sha256:'a'.repeat(64),sizeBytes:3,format:'file',expandedBytes:3,maxFiles:1}];
 const base={version:1,jobId:'job',attempt:'attempt',mode:'compute',snapshot:createSnapshot([]),argv:['true'],timeoutMs:1000,largeArtifacts:{refs,capability:'hma_'+'b'.repeat(64)}};
 assert.ok(validateRuntimeInput(base).largeArtifacts);
 assert.throws(()=>validateRuntimeInput({...base,largeArtifacts:{refs,capability:'operator-secret'}}));
 assert.throws(()=>validateRuntimeInput({...base,mode:'agent'}));
});

import {executeRuntime} from '../src/runtime/run.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
test('runtime prepares verified data before compute and never passes its capability to child env',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'large-runtime-'));
 try{
  const bytes=Buffer.from('abc'),capability='hma_'+'b'.repeat(64);
  const refs=[{name:'data' as const,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:3,format:'file' as const,expandedBytes:3,maxFiles:1}];
  const r=await executeRuntime({version:1,jobId:'j',attempt:'a',mode:'compute',snapshot:createSnapshot([]),argv:['node','-e','const fs=require("fs"); if(Object.values(process.env).some(x=>x.startsWith("hma_")))process.exit(2); console.log(JSON.stringify({data:fs.readFileSync(process.env.HIVEMIND_ARTIFACT_DATA,"utf8"),home:process.env.HOME,input:process.env.HIVEMIND_ARTIFACT_DATA}));'],timeoutMs:10000,largeArtifacts:{refs,capability}},
   {runtimeDir:join(directory,'private'),workspace:join(directory,'work'),home:join(directory,'home'),computePrefix:[],artifactFetch:async()=>new Response(bytes,{headers:{'content-length':'3'}})});
  assert.equal(r.process.status,'passed');const output=JSON.parse(r.process.stdout);assert.equal(output.data,'abc');assert.ok(output.input.startsWith(join(directory,'home','hivemind-inputs-')));assert.equal(await access(output.input).then(()=>true,()=>false),false);assert.ok(output.home.startsWith(join(directory,'home','hivemind-compute-')));assert.equal(await access(output.home).then(()=>true,()=>false),false);assert.equal(r.largeArtifacts?.receipts[0]?.sizeBytes,3);assert.equal(r.sourceUnchanged,true);assert.ok(!JSON.stringify(r).includes(capability));
 }finally{await rm(directory,{recursive:true,force:true});}
});

import {access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
test('failed or expired preparation never launches compute or exposes capability',async()=>{
 for(const expired of [false,true]){
  const directory=await mkdtemp(join(tmpdir(),'large-rejected-'));
  try{
   const capability='hma_'+'c'.repeat(64),bytes=Buffer.from('abc');
   const refs=[{name:'data' as const,sha256:expired?createHash('sha256').update(bytes).digest('hex'):'a'.repeat(64),sizeBytes:3,format:'file' as const,expandedBytes:3,maxFiles:1}];
   const r=await executeRuntime({version:1,jobId:'j',attempt:'a',mode:'compute',snapshot:createSnapshot([]),argv:['node','-e','require("fs").writeFileSync("launched","bad")'],timeoutMs:expired?20:10000,largeArtifacts:{refs,capability}},
    {runtimeDir:join(directory,'private'),workspace:join(directory,'work'),home:join(directory,'home'),computePrefix:[],artifactFetch:async()=>{if(expired)await delay(50);return new Response(bytes,{headers:{'content-length':'3'}})}});
   assert.equal(r.process.status,'error');assert.ok(!JSON.stringify(r).includes(capability));assert.equal(await access(join(directory,'work','launched')).then(()=>true,()=>false),false);
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
