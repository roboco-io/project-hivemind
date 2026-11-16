import test from 'node:test';
import assert from 'node:assert/strict';
import {MEMORY_SHARDS,FLOAT_COMPARISON,validateMemoryBatch,shardScript} from '../scripts/duckdb-pilot/memory-batch.ts';
test('all concurrency choices use exactly the same 22 queries in four disjoint shards',()=>{
 const flat=MEMORY_SHARDS.flat();assert.equal(flat.length,22);assert.deepEqual([...flat].sort((a,b)=>a-b),Array.from({length:22},(_,i)=>i+1));
 for(const c of [1,2,4])assert.deepEqual(validateMemoryBatch(30,9,4,c).shards,MEMORY_SHARDS);
 assert.throws(()=>validateMemoryBatch(30,9,4,3));assert.throws(()=>validateMemoryBatch(100,9,4,4));
});
test('a shard keeps one connection with per-query schema/result/profile outputs and fail-fast SQL',()=>{
 const script=shardScript([{id:9,sql:'SELECT 1 AS a;',schemaPath:'/run with space/q09.schema.json',resultPath:'/run with space/q09.json',profilePath:'/run with space/q09.profile.json'},{id:18,sql:'WITH x AS (SELECT 1 a) SELECT * FROM x;',schemaPath:'/run/q18.schema.json',resultPath:'/run/q18.json',profilePath:'/run/q18.profile.json'}],9,4,"/run/spill'folder");
 assert.ok(script.startsWith('.bail on\n.mode json\n'));assert.equal((script.match(/LOAD tpch;/g)??[]).length,1);assert.equal((script.match(/PRAGMA tpch\(/g)??[]).length,2);
 assert.ok(script.includes('.once "/run with space/q09.json"'));assert.ok(script.includes("SET temp_directory='/run/spill''folder';"));assert.ok(script.includes('DESCRIBE WITH x AS'));
 assert.equal((script.match(/PRAGMA disable_profiling;/g)??[]).length,3);
 assert.ok(script.indexOf('SET profiling_output')<script.indexOf("PRAGMA enable_profiling='json'"));
 assert.equal(FLOAT_COMPARISON.relative,'1e-12');assert.equal(FLOAT_COMPARISON.absolute,'1e-8');
});
test('shard output paths cannot inject shell commands and query IDs are bounded',()=>{
 const q={id:9,sql:'SELECT 1',schemaPath:'/a',resultPath:'/b',profilePath:'/c'};
 assert.throws(()=>shardScript([{...q,resultPath:'/tmp/a\n.shell x'}],6,2,'/spill'));assert.throws(()=>shardScript([{...q,id:23}],6,2,'/spill'));assert.throws(()=>shardScript([q,q],6,2,'/spill'));
});
test('P0 accepts a lower 3 GiB tuning budget without changing query coverage or spill cap',()=>{
 const settings=validateMemoryBatch(30,3,4,4);assert.equal(settings.memoryGiB,3);assert.deepEqual(settings.shards,MEMORY_SHARDS);
 const q={id:9,sql:'SELECT 1',schemaPath:'/a',resultPath:'/b',profilePath:'/c'};const script=shardScript([q],3,4,'/spill');assert.ok(script.includes("SET memory_limit='3GiB';"));assert.ok(script.includes("SET max_temp_directory_size='4GiB';"));
 for(const budget of [6,9])assert.equal(validateMemoryBatch(30,budget,4,4).memoryGiB,budget);
 assert.throws(()=>validateMemoryBatch(30,4,4,4));assert.throws(()=>validateMemoryBatch(30,12,4,4));
});
