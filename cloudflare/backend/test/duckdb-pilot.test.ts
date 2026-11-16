import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVm,Guard,profile,validateMemoryOptions} from '../scripts/duckdb-pilot/metrics.ts';
test('vm counters use the reported page size, not a fixed page size',()=>{
 assert.deepEqual(parseVm('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapouts: 100.\nPages occupied by compressor: 20.'),{pageSize:16384,swapOutBytes:1638400,compressedBytes:327680});
 assert.throws(()=>parseVm('Swapouts: 2'));
});
test('critical pressure and slow probes require sustained observations',()=>{
 const g=new Guard();assert.equal(g.observe({at:1000,pressure:'critical'}),null);
 assert.equal(g.observe({at:15999,pressure:'critical'}),null);assert.equal(g.observe({at:16000,pressure:'critical'}),'critical-memory-pressure');
 const h=new Guard();h.observe({at:0,pressure:'critical'});h.observe({at:10000,pressure:'normal'});assert.equal(h.observe({at:20000,pressure:'critical'}),null);
 const n=new Guard();n.observe({at:100,nodeMs:1001});assert.equal(n.observe({at:30100,nodeMs:1001}),'response-time');
});
test('disk and swap guard reject resource exhaustion, not old swap totals',()=>{
 const g=new Guard();assert.equal(g.observe({at:0,diskFree:2*1024**3}),'disk-space');
 const h=new Guard();h.observe({at:0,swapOutBytes:20*1024**3});assert.equal(h.observe({at:60000,swapOutBytes:21*1024**3}),null);assert.equal(h.observe({at:120000,swapOutBytes:22*1024**3}),'swap-out-rate');
});
test('only the four frozen build profiles and bounded query scales are accepted',()=>{
 assert.deepEqual(profile('C4'),{disableUnity:true,forceAssert:true});assert.throws(()=>profile('../oops'));
 assert.equal(validateMemoryOptions(30,9,4).sf,30);assert.throws(()=>validateMemoryOptions(100,9,4));assert.throws(()=>validateMemoryOptions(10,32,4));
});
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('wait4 supervisor includes a normally reaped busy grandchild and bounds timeout',()=>{
 const root=mkdtempSync(join(tmpdir(),'duckdb-supervisor-'));
 try{
  const code='import time; end=time.monotonic()+0.15\nwhile time.monotonic()<end: pass';
 const spec={argv:['python3','-c',`import subprocess; subprocess.run(['python3','-c',${JSON.stringify(code)}],check=True)`],cwd:root,timeoutMs:5000,stopFile:join(root,'stop'),stdout:join(root,'out'),stderr:join(root,'err')};
  const source=resolve(import.meta.dirname,'../scripts/duckdb-pilot/supervise.py'),input=join(root,'spec.json'),output=join(root,'result.json');writeFileSync(input,JSON.stringify(spec));
  let p=spawnSync('python3',[source,input,output],{timeout:7000});assert.equal(p.status,0,p.stderr.toString());let r=JSON.parse(readFileSync(output,'utf8'));assert.equal(r.passed,true);assert.ok(r.cpuUserSeconds+r.cpuSystemSeconds>.08);
  writeFileSync(input,JSON.stringify({...spec,argv:['python3','-c','import time; time.sleep(30)'],timeoutMs:100}));p=spawnSync('python3',[source,input,output],{timeout:5000});assert.equal(p.status,1);r=JSON.parse(readFileSync(output,'utf8'));assert.equal(r.terminationReason,'timeout');assert.equal(r.passed,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
import {chmodSync,existsSync} from 'node:fs';
test('pinned Catch inventory accepts its count exit and rejects mismatches',()=>{
 const root=mkdtempSync(join(tmpdir(),'duckdb-inventory-'));
 try{
  const binary=join(root,'fake'),helper=resolve(import.meta.dirname,'../scripts/duckdb-pilot/inventory.py');
  writeFileSync(binary,'#!/usr/bin/env python3\nprint("a\\nb\\nc")\nraise SystemExit(3)\n');chmodSync(binary,0o700);
  assert.equal(spawnSync('python3',[helper,binary,'[projection]',root,join(root,'test-temp')]).status,0);
  writeFileSync(binary,'#!/usr/bin/env python3\nprint("a\\nb\\nc")\n');assert.equal(spawnSync('python3',[helper,binary,'[projection]',root,join(root,'test-temp')]).status,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('normalizer refuses a different source before publishing any artifact',()=>{
 const root=mkdtempSync(join(tmpdir(),'duckdb-source-'));
 try{
  const input=join(root,'bad.tar.gz'),output=join(root,'out.tar.gz'),manifest=join(root,'out.json');writeFileSync(input,'not the pinned archive');
  const r=spawnSync('python3',[resolve(import.meta.dirname,'../scripts/duckdb-pilot/normalize-source.py'),input,output,manifest]);assert.equal(r.status,1);assert.equal(existsSync(output),false);assert.equal(existsSync(manifest),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
