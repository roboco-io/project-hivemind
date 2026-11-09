import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, readFile, symlink, chmod, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceFile } from '../src/contracts.ts';
import { createSnapshot, validateSnapshot, snapshotDigest } from '../src/snapshot.ts';
import { readSnapshot, restoreSnapshot, applySnapshot } from '../src/files.ts';
const file=(path:string,body:string|Buffer,executable=false):SourceFile=>{const bytes=Buffer.from(body);return {path,content:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),executable};};
const fixture=async()=>mkdtemp(join(tmpdir(),'hivemind-snapshot-'));

test('snapshot digest is deterministic, normalized and validates every byte',()=>{
 const a=file('한글.txt','안녕'),b=file('bin.dat',Buffer.from([0,255,128]));
 const one=createSnapshot([a,b]),two=createSnapshot([b,a]);
 assert.deepEqual(one,two);assert.equal(one.digest,snapshotDigest([b,a]));assert.deepEqual(validateSnapshot(one),one);
 assert.deepEqual(createSnapshot([]).files,[]);
 assert.throws(()=>validateSnapshot({...one,digest:'0'.repeat(64)}),/digest/i);
 assert.throws(()=>createSnapshot([{...a,sha256:'0'.repeat(64)}]),/hash/i);
 assert.throws(()=>createSnapshot([{...a,content:'!!'}]),/base64/i);
});

test('snapshot rejects traversal, credentials, collisions and ambiguous structure',()=>{
 for(const path of ['../x','/x','a//x','a/./x','a/../x','a\\x','C:/x','x\0z','.git/config','.env.example','a/.claude/settings.json','.hivemind/a','node_modules/a','dist/a','reports/a','auth.json','a/.credentials.json','key.pem','a/secrets.json','.npmrc','.netrc','.ssh/id_rsa'])assert.throws(()=>createSnapshot([file(path,'a')]),/path|excluded|reserved/i,path);
 assert.throws(()=>createSnapshot([file('A.txt','1'),file('a.txt','2')]),/duplicate|collision/i);
 assert.throws(()=>createSnapshot([file('é.txt','1'),file('e\u0301.txt','2')]),/duplicate|collision/i);
 assert.throws(()=>createSnapshot([file('a','1'),file('a/b','2')]),/collision|ancestor/i);
 assert.throws(()=>createSnapshot([file('x'.repeat(513),'1')]),/path/i);
});

test('snapshot limits reject oversized source and excessive file counts',()=>{
 assert.throws(()=>createSnapshot([file('large.bin',Buffer.alloc(4*1024*1024+1))]),/limit|size/i);
 assert.throws(()=>createSnapshot(Array.from({length:1001},(_,i)=>file(`${i}.txt`,''))),/limit|count/i);
});

test('filesystem snapshots exclude private/build files and reject symlinks',async()=>{
 const dir=await fixture();
 try {
  await writeFile(join(dir,'a.txt'),'source');await mkdir(join(dir,'.git'));await writeFile(join(dir,'.git','config'),'secret');
  await mkdir(join(dir,'node_modules'));await writeFile(join(dir,'node_modules','a'),'ignored');await writeFile(join(dir,'.env'),'secret');
  assert.deepEqual((await readSnapshot(dir)).files.map(f=>f.path),['a.txt']);
  await symlink(join(dir,'a.txt'),join(dir,'link.txt'));await assert.rejects(readSnapshot(dir),/symlink/i);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('restore preserves binary, Korean paths and executable flags and refuses overwrite',async()=>{
 const dir=await fixture();
 try {
  const snapshot=createSnapshot([file('문서/설명.txt','안녕하세요'),file('run.sh','exit 0\n',true),file('binary',Buffer.from([0,1,255]))]);
  await restoreSnapshot(dir,snapshot);assert.equal((await readSnapshot(dir)).digest,snapshot.digest);
  assert.ok((await stat(join(dir,'run.sh'))).mode&0o111);
  await assert.rejects(restoreSnapshot(dir,snapshot),/existing|empty|collision/i);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('restore refuses symlinked root and parent escapes',async()=>{
 const parent=await fixture(),outside=await fixture();
 try {
  await symlink(outside,join(parent,'root'));await assert.rejects(restoreSnapshot(join(parent,'root'),createSnapshot([file('x','bad')])),/symlink/i);
  const root=join(parent,'real');await mkdir(root);await symlink(outside,join(root,'nested'));
  await assert.rejects(restoreSnapshot(root,createSnapshot([file('nested/x','bad')])),/symlink|existing|empty/i);
  await assert.rejects(access(join(outside,'x')));
 } finally {await rm(parent,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('apply handles new, deleted, binary and mode changes',async()=>{
 const dir=await fixture();
 try {
  const base=createSnapshot([file('old.txt','remove'),file('same.txt','same'),file('change.bin',Buffer.from([0,1]))]);await restoreSnapshot(dir,base);
  const output=createSnapshot([file('same.txt','same',true),file('new/한글.txt','new'),file('change.bin',Buffer.from([255,0,2]))]);
  await applySnapshot(dir,base,output);assert.equal((await readSnapshot(dir)).digest,output.digest);
  await assert.rejects(access(join(dir,'old.txt')));
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('apply detects modified, missing and colliding user files before writing anything',async()=>{
 for(const variant of ['modified','missing','new'] as const){const dir=await fixture();try {
  const base=createSnapshot([file('a.txt','before')]);await restoreSnapshot(dir,base);
  if(variant==='modified')await writeFile(join(dir,'a.txt'),'user change');
  if(variant==='missing')await rm(join(dir,'a.txt'));
  if(variant==='new')await writeFile(join(dir,'new.txt'),'user draft');
  const before=await readSnapshot(dir);await assert.rejects(applySnapshot(dir,base,createSnapshot([file('a.txt','after'),file('new.txt','new')])) ,/conflict|base|changed/i);
  assert.equal((await readSnapshot(dir)).digest,before.digest);
 }finally{await rm(dir,{recursive:true,force:true});}}
});

test('apply rolls back earlier files when a later destination cannot be written', {skip:process.platform==='win32'||process.getuid?.()===0},async()=>{
 const dir=await fixture();
 try {
  const base=createSnapshot([file('a.txt','before'),file('locked/b.txt','before')]);await restoreSnapshot(dir,base);
  await chmod(join(dir,'locked'),0o500);
  const output=createSnapshot([file('a.txt','after'),file('locked/b.txt','after')]);
  await assert.rejects(applySnapshot(dir,base,output),/apply|permission|EACCES|EPERM/i);
  assert.equal(await readFile(join(dir,'a.txt'),'utf8'),'before');assert.equal(await readFile(join(dir,'locked/b.txt'),'utf8'),'before');
 } finally {await chmod(join(dir,'locked'),0o700).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('snapshot accepts the exact byte boundary without recursive base64 validation',()=>{
 const content=Buffer.alloc(4*1024*1024,42);const snapshot=createSnapshot([file('max.bin',content)]);
 assert.equal(Buffer.from(snapshot.files[0]!.content,'base64').length,content.length);
});
