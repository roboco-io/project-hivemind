import test from 'node:test';
import assert from 'node:assert/strict';
import {executeBatch,validateBuildBatch} from '../scripts/duckdb-pilot/batch.ts';
test('batch accepts only unique frozen profiles and bounded worker/compiler concurrency',()=>{
 assert.equal(validateBuildBatch(['C1','C2','C3','C4'],4,2).profiles.length,4);
 assert.throws(()=>validateBuildBatch(['C1','C1'],2,2));assert.throws(()=>validateBuildBatch(['C1'],4,2));
 assert.throws(()=>validateBuildBatch(['C1','C2'],3,2));assert.throws(()=>validateBuildBatch(['C1','C2'],2,11));
 assert.throws(()=>validateBuildBatch(['../../oops'],1,2));
});
test('batch bounds active callbacks and completes every task once',async()=>{
 let active=0,peak=0;const started:number[]=[];
 const rows=await executeBatch([1,2,3,4],2,async x=>{started.push(x);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return x*2;},async()=>assert.fail('unexpected stop'),async()=>{});
 assert.equal(peak,2);assert.deepEqual(started,[1,2,3,4]);assert.deepEqual(rows.map(r=>r.value),[2,4,6,8]);assert.ok(rows.every(r=>r.status==='SUCCEEDED'));
});
test('first failure stops admission and awaits the already-running peer',async()=>{
 const started:number[]=[];const stops:string[]=[];let peerFinished=false;
 const rows=await executeBatch([1,2,3,4],2,async x=>{started.push(x);if(x===1){await new Promise(r=>setTimeout(r,5));throw Error('fixture failure');}await new Promise(r=>setTimeout(r,20));peerFinished=true;throw Error('peer cancelled');},async reason=>{stops.push(reason);},async()=>{});
 assert.deepEqual(started,[1,2]);assert.equal(peerFinished,true);assert.deepEqual(stops,['batch-task-failed']);assert.deepEqual(rows.map(r=>r.status),['FAILED','CANCELLED','NOT_STARTED','NOT_STARTED']);
});
test('an already-triggered resource guard prevents every new admission',async()=>{
 const rows=await executeBatch([1,2],2,async()=>assert.fail('guard must prevent launch'),async()=>{},async()=>{},()=>true);
 assert.deepEqual(rows.map(r=>r.status),['NOT_STARTED','NOT_STARTED']);assert.ok(rows.every(r=>r.startedAt===undefined));
});
