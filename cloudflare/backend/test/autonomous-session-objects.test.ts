import test from 'node:test';
import assert from 'node:assert/strict';
import {R2PrivateBlobStore, type PrivateR2Bucket} from '../src/autonomous-session-objects.ts';
import {EncryptedSessionStore, MAX_PRIVATE_BLOB_BYTES} from '../../../packages/adapters/src/autonomous-session-store.ts';
function bucket() {const entries=new Map<string,Uint8Array>();let conditional=false;const port:PrivateR2Bucket={async get(key){const b=entries.get(key);return b?{size:b.length,async arrayBuffer(){return new Uint8Array(b).buffer;}}:null;},async put(key,b,options){conditional=options.onlyIf.etagDoesNotMatch==='*';if(entries.has(key))return null;entries.set(key,new Uint8Array(b));return {etag:'synthetic'};}};return {entries,port,get conditional(){return conditional;}};}
test('private R2 immutable writes and restart restore through portable encryption',async()=>{
 const privateBucket=bucket();const store=new EncryptedSessionStore({key:new Uint8Array(32).fill(1),blobs:new R2PrivateBlobStore({bucket:privateBucket.port})});
 const session={sessionId:'synthetic',model:'fixed',sequence:1,data:{text:'한글 🐝'}};const cp=await store.save('task',session);
 assert.deepEqual(await new EncryptedSessionStore({key:new Uint8Array(32).fill(1),blobs:new R2PrivateBlobStore({bucket:privateBucket.port})}).load('task',cp),session);
 assert.equal(privateBucket.conditional,true);assert.ok([...privateBucket.entries.keys()].every(k=>k.startsWith('autonomous-sessions/private/')));
 await assert.rejects(new R2PrivateBlobStore({bucket:privateBucket.port}).put(cp.objectKey,new Uint8Array([2])));
});
test('R2 bounds reads and writes and rejects unsafe keys or bucket errors without echo',async()=>{
 const b=bucket();const store=new R2PrivateBlobStore({bucket:b.port});const key='private/'+crypto.randomUUID();
 assert.equal(await store.get(key),undefined);await assert.rejects(store.put('../secret',new Uint8Array()));await assert.rejects(store.put(key,new Uint8Array(MAX_PRIVATE_BLOB_BYTES+1)));
 const oversized=new R2PrivateBlobStore({bucket:{...b.port,async get(){return {size:MAX_PRIVATE_BLOB_BYTES+1,arrayBuffer(){throw Error('must not read');}};}}});await assert.rejects(oversized.get(key),/Private session rejected/);
 const throws=new R2PrivateBlobStore({bucket:{...b.port,async put(){throw Error('synthetic-secret');}}});await assert.rejects(throws.put(key,new Uint8Array()),/^Error: Private session rejected$/);
});
