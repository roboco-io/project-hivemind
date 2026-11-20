import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, stat, readFile, writeFile, symlink, link, chmod, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedSessionStore, MAX_PRIVATE_BLOB_BYTES, type PrivateBlobStore} from '../packages/adapters/src/autonomous-session-store.js';
import {FilePrivateBlobStore} from '../packages/adapters/src/autonomous-session-file.js';
const key = new Uint8Array(32).fill(19);
const session = {sessionId:'6a9d2ff4-0af4-4bab-9cd5-c7ac254a8990', model:'claude-sonnet-4-6', sequence:1, data:{transcript:'비공개 🐝', files:['작업']}};
function memory(): PrivateBlobStore & {entries: Map<string, Uint8Array>} {const entries=new Map<string,Uint8Array>();return {durable:true,entries,async get(k){return entries.get(k)?.slice();},async put(k,b){if(entries.has(k))throw Error('immutable');entries.set(k,b.slice());}};}
test('AES-GCM restores Unicode with a fresh store and binds all checkpoint fields',async()=>{
 const blobs=memory(), first=new EncryptedSessionStore({key,blobs});const cp=await first.save('task',session);
 assert.equal(first.durable,true);assert.deepEqual(await new EncryptedSessionStore({key,blobs}).load('task',cp),session);
 assert.ok(!new TextDecoder().decode(blobs.entries.get(cp.objectKey)).includes('비공개'));
 for(const [task,point] of [['other',cp],['task',{...cp,model:'other'}],['task',{...cp,sequence:2}],['task',{...cp,sessionId:'other'}]] as const)await assert.rejects(first.load(task,point),/Private session rejected/);
 const moved='private/'+crypto.randomUUID();blobs.entries.set(moved,blobs.entries.get(cp.objectKey)!);await assert.rejects(first.load('task',{...cp,objectKey:moved}));
 await assert.rejects(new EncryptedSessionStore({key:new Uint8Array(32),blobs}).load('task',cp));
 const bytes=blobs.entries.get(cp.objectKey)!;bytes[bytes.length-1]=bytes[bytes.length-1]!^1;await assert.rejects(first.load('task',cp));
 assert.equal(await first.load('task',{...cp,objectKey:'private/'+crypto.randomUUID()}),undefined);
});
test('requires explicit durable storage and 32 byte key; bounds serialization without toJSON',async()=>{
 assert.throws(()=>new EncryptedSessionStore({key:new Uint8Array(31),blobs:memory()}));
 assert.throws(()=>new EncryptedSessionStore({key,blobs:{...memory(),durable:false} as unknown as PrivateBlobStore}));
 const store=new EncryptedSessionStore({key,blobs:memory()});
 await assert.rejects(store.save('task',{...session,data:'x'.repeat(MAX_PRIVATE_BLOB_BYTES)}));
 await assert.rejects(store.save('task',{...session,data:{toJSON(){throw Error('secret');}}}),/Private session rejected/);
 const cyclic:unknown[]=[];cyclic.push(cyclic);await assert.rejects(store.save('task',{...session,data:cyclic}));
});
test('file port is durable, atomic immutable and private across instances',async()=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'private-session-')));const root=join(parent,'store');
 try {const blobs=new FilePrivateBlobStore({root});const store=new EncryptedSessionStore({key,blobs});const cp=await store.save('task',session);
 assert.deepEqual(await new EncryptedSessionStore({key,blobs:new FilePrivateBlobStore({root})}).load('task',cp),session);
 assert.equal((await stat(root)).mode&0o777,0o700);
 const path=join(root,cp.objectKey.slice(8));assert.equal((await stat(path)).mode&0o777,0o600);
 const before=await readFile(path);await assert.rejects(blobs.put(cp.objectKey,new Uint8Array([1])));assert.deepEqual(await readFile(path),before);
 const k='private/'+crypto.randomUUID();const outcomes=await Promise.allSettled([blobs.put(k,new Uint8Array([1])),blobs.put(k,new Uint8Array([2]))]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(blobs.put('../escape',new Uint8Array()));await assert.rejects(blobs.put(k,new Uint8Array(MAX_PRIVATE_BLOB_BYTES+1)));
 await chmod(path,0o644);await assert.rejects(blobs.get(cp.objectKey));
 }finally{await rm(parent,{recursive:true,force:true});}
});
test('file port rejects symlinks, hardlinks and unsafe ancestor modes',async()=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'private-links-')));
 try {const root=join(parent,'store');await mkdir(root,{mode:0o700});const k='private/'+crypto.randomUUID();const target=join(parent,'target');await writeFile(target,'secret',{mode:0o600});
 await symlink(target,join(root,k.slice(8)));const blobs=new FilePrivateBlobStore({root});await assert.rejects(blobs.get(k));await assert.rejects(blobs.put(k,new Uint8Array([1])));
 await rm(join(root,k.slice(8)));await link(target,join(root,k.slice(8)));await assert.rejects(blobs.get(k));
 const alias=join(parent,'alias');await symlink(root,alias);await assert.rejects(new FilePrivateBlobStore({root:alias}).get(k));
 await chmod(root,0o777);await assert.rejects(blobs.get(k));
 }finally{await rm(parent,{recursive:true,force:true});}
});
test('bounded serializer accepts a multi-megabyte ASCII payload and rejects sparse arrays',async()=>{
 const store=new EncryptedSessionStore({key,blobs:memory()});const large={...session,data:'x'.repeat(3*1024*1024)};const cp=await store.save('task',large);assert.deepEqual(await store.load('task',cp),large);
 await assert.rejects(store.save('task',{...session,data:new Array(200000)}));
});
test('file port rejects symlink ancestors and leaves interrupted private files unreachable',async()=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'private-interrupted-')));
 try {await mkdir(join(parent,'real'),{mode:0o700});await symlink(join(parent,'real'),join(parent,'alias'));
 const k='private/'+crypto.randomUUID();await assert.rejects(new FilePrivateBlobStore({root:join(parent,'alias','store')}).put(k,new Uint8Array([1])));
 const root=join(parent,'real');await writeFile(join(root,'.pending-synthetic'),new Uint8Array([1,2]),{mode:0o600});
 assert.equal(await new FilePrivateBlobStore({root}).get(k),undefined);
 await assert.rejects(new FilePrivateBlobStore({root}).put(k+'\n',new Uint8Array([1])));
 }finally{await rm(parent,{recursive:true,force:true});}
});
