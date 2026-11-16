import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {archiveNpmCache,restoreNpmCache} from '../src/runtime/npm-cache-archive.ts';

test('npm cache archive round-trips only safe integrity-checked files',async()=>{
 const base=await mkdtemp(join(tmpdir(),'hvm-cache-test-'));
 try{
  const src=join(base,'src'),dst=join(base,'dst'),data=Buffer.from('fixture');
  const hash=createHash('sha512').update(data).digest('hex');
  const content=`content-v2/sha512/${hash.slice(0,2)}/${hash.slice(2,4)}/${hash.slice(4)}`;
  const index='index-v5/aa/bb/'+'c'.repeat(60);
  for(const [path,bytes] of [[content,data],[index,Buffer.from('index')]] as const){
   const file=join(src,'_cacache',path);
   await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);
  }
  const archive=await archiveNpmCache(src);
  await restoreNpmCache(dst,archive);
  assert.deepEqual(await readFile(join(dst,'_cacache',content)),data);
  const corrupt=Buffer.from(archive);
  const at=corrupt.indexOf(data);
  corrupt[at]=corrupt[at]!^1;
  await assert.rejects(restoreNpmCache(join(base,'corrupt'),corrupt),/integrity mismatch/);
  const outside=Buffer.from('../escape');
  const head=Buffer.alloc(6);head.writeUInt16BE(outside.length);
  await assert.rejects(restoreNpmCache(join(base,'escape'),Buffer.concat([Buffer.from('HVNC1'),head,outside])),/Unexpected npm cache path/);
 }finally{await rm(base,{recursive:true,force:true});}
});
