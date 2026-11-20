import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {largeOwnerKey,largeStorageRef,validateExternalLargeManifest,externalLargeManifestDigest,largePartPlan,LARGE_PART_BYTES} from '../packages/core/src/autonomous-external-large.ts';
import type {ExternalLargeManifest} from '../packages/contracts/src/autonomous-external-large.js';
const limits={maxFileBytes:5*1024**3,maxTotalBytes:10*1024**3,maxFiles:4};
const sha='a'.repeat(64),owner=largeOwnerKey('t1',1,'hf');
const manifest=():ExternalLargeManifest=>({version:1,taskId:'t1',revision:1,profileId:'hf',files:[{path:'model/a.bin',size:10,sha256:sha,storageRef:largeStorageRef(owner,sha)}]});
test('owner key is 64 hex, distinct per task revision profile, storage ref is owner scoped',()=>{
 assert.match(owner,/^[a-f0-9]{64}$/);
 assert.notEqual(owner,largeOwnerKey('t2',1,'hf'));assert.notEqual(owner,largeOwnerKey('t1',2,'hf'));assert.notEqual(owner,largeOwnerKey('t1',1,'hf2'));
 assert.equal(largeStorageRef(owner,sha),`external-large/${owner}/${sha}`);
});
test('part plan',()=>{
 assert.equal(LARGE_PART_BYTES,8388608);
 assert.deepEqual(largePartPlan(8388609),{partBytes:8388608,count:2,lastBytes:1});
 assert.deepEqual(largePartPlan(8388608),{partBytes:8388608,count:1,lastBytes:8388608});
 assert.deepEqual(largePartPlan(1),{partBytes:8388608,count:1,lastBytes:1});
 assert.deepEqual(largePartPlan(10,4),{partBytes:4,count:3,lastBytes:2});
 for(const bad of [0,-1,1.5,NaN])assert.throws(()=>largePartPlan(bad));
});
test('valid manifest round trips and digest is stable, prefixed and order independent',()=>{
 const m=manifest();assert.deepEqual(validateExternalLargeManifest(structuredClone(m),limits),m);
 const d=externalLargeManifestDigest(m);assert.match(d,/^[a-f0-9]{64}$/);
 const sha2='b'.repeat(64),two:ExternalLargeManifest={...m,files:[...m.files,{path:'a.bin',size:3,sha256:sha2,storageRef:largeStorageRef(owner,sha2)}]};
 const swapped={...two,files:[...two.files].reverse()};
 assert.equal(externalLargeManifestDigest(two),externalLargeManifestDigest(swapped));
 assert.notEqual(externalLargeManifestDigest(two),d);
 assert.match(externalLargeManifestDigest(m),/^[a-f0-9]{64}$/);
 const canonical=JSON.stringify({version:1,taskId:'t1',revision:1,profileId:'hf',files:m.files.map(f=>({path:f.path,size:f.size,sha256:f.sha256,storageRef:f.storageRef}))});
 assert.equal(d,createHash('sha256').update('hivemind-large-v1\n'+canonical).digest('hex'));
});
test('manifest rejects storage ref of another owner, bad paths, limits and unknown fields',()=>{
 const other=largeOwnerKey('t2',1,'hf'),m=manifest();
 assert.throws(()=>validateExternalLargeManifest({...m,files:[{...m.files[0]!,storageRef:largeStorageRef(other,sha)}]},limits));
 for(const path of ['../x','/abs','a//b','a/','.env','a/../b','ok/.git/config','model.pem','a\\b',''])assert.throws(()=>validateExternalLargeManifest({...m,files:[{...m.files[0]!,path}]},limits),path);
 assert.throws(()=>validateExternalLargeManifest({...m,files:[m.files[0]!,m.files[0]!]},limits));
 assert.throws(()=>validateExternalLargeManifest({...m,files:[]},limits));
 assert.throws(()=>validateExternalLargeManifest({...m,files:[{...m.files[0]!,size:limits.maxFileBytes+1}]},limits));
 assert.throws(()=>validateExternalLargeManifest({...m,files:[{...m.files[0]!,size:0}]},limits));
 assert.throws(()=>validateExternalLargeManifest({...m,files:[{...m.files[0]!,sha256:'A'.repeat(64)}]},limits));
 assert.throws(()=>validateExternalLargeManifest(m,{...limits,maxTotalBytes:9}));
 assert.throws(()=>validateExternalLargeManifest(m,{...limits,maxFiles:0}));
 assert.throws(()=>validateExternalLargeManifest({...m,extra:1},limits));
 assert.throws(()=>validateExternalLargeManifest({...m,version:2},limits));
 assert.throws(()=>validateExternalLargeManifest({...m,revision:0},limits));
 assert.throws(()=>validateExternalLargeManifest(null,limits));
});
