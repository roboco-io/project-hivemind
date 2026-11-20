import test from 'node:test';
import assert from 'node:assert/strict';
import {duckdbCacheIdentity,validateDuckdbCacheEvidence} from '../src/duckdb-build-cache.ts';
import type {JobRecord} from '../src/contracts.ts';

test('cache key binds runtime, snapshot, tools, source and profile across modes',()=>{
 const job={kind:'compute',argv:['node','runner.mjs','C3','seed'],snapshotId:'a',
  executionGroup:{instance:'standard-4',dependencyNetwork:true},
  largeArtifacts:[{name:'source',sha256:'source'},{name:'data',sha256:'tools'}]} as JobRecord;
 const seed=duckdbCacheIdentity(job,'runtime')!;
 assert.equal(duckdbCacheIdentity({...job,argv:['node','runner.mjs','C3','warm']},'runtime')!.key,seed.key);
 assert.notEqual(duckdbCacheIdentity({...job,argv:['node','runner.mjs','C4','warm']},'runtime')!.key,seed.key);
 assert.notEqual(duckdbCacheIdentity(job,'new-runtime')!.key,seed.key);
 assert.notEqual(duckdbCacheIdentity({...job,snapshotId:'b'},'runtime')!.key,seed.key);
 assert.notEqual(duckdbCacheIdentity({...job,largeArtifacts:job.largeArtifacts!.map(r=>({...r,sha256:'different'}))},'runtime')!.key,seed.key);
 assert.equal(duckdbCacheIdentity({...job,kind:'agent'},'runtime'),undefined);
});
test('warm receipts require a verified archive reference and cannot publish',()=>{
 const evidence={mode:'warm',restoredSha256:'a'.repeat(64),restoredBytes:12,restoreMs:21};
 assert.equal(validateDuckdbCacheEvidence(evidence,'warm').restoreMs,21);
 assert.throws(()=>validateDuckdbCacheEvidence({...evidence,restoredSha256:null},'warm'));
 assert.throws(()=>validateDuckdbCacheEvidence({...evidence,published:{sha256:'a'.repeat(64),sizeBytes:10,durationMs:1}},'warm'));
 assert.throws(()=>validateDuckdbCacheEvidence({...evidence,mode:'cold'},'cold'));
});
