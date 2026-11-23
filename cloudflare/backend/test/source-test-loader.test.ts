import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const loader=fileURLToPath(new URL('../scripts/source-test-loader.mjs',import.meta.url));
async function probe(root:string){
 await writeFile(join(root,'value.ts'),'export const value="typescript";');
 await writeFile(join(root,'entry.mjs'),'import {value} from "./value.js"; console.log(value);');
 return ()=>spawnSync(process.execPath,['--import',loader,join(root,'entry.mjs')],{cwd:tmpdir(),encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});
}
test('source loader resolves repository TypeScript from an unrelated cwd',async()=>{
 const dir=await mkdtemp(fileURLToPath(new URL('./.source-loader-',import.meta.url)));
 try{const run=await probe(dir),result=run();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'typescript');}finally{await rm(dir,{recursive:true,force:true});}
});
test('source loader preserves existing JavaScript resolution',async()=>{
 const dir=await mkdtemp(fileURLToPath(new URL('./.source-loader-',import.meta.url)));
 try{const run=await probe(dir);await writeFile(join(dir,'value.js'),'export const value="javascript";');const result=run();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'javascript');}finally{await rm(dir,{recursive:true,force:true});}
});
test('source loader does not resolve outside the repository',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hivemind-source-loader-'));
 try{const run=await probe(dir),result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/value\.js/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('source loader does not replace dependencies in node_modules',async()=>{
 const dir=await mkdtemp(fileURLToPath(new URL('./.source-loader-',import.meta.url)));
 try{const modules=join(dir,'node_modules');await mkdir(modules);const run=await probe(modules),result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/value\.js/);}finally{await rm(dir,{recursive:true,force:true});}
});
