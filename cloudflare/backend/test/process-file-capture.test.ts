import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat,readdir,mkdir} from 'node:fs/promises';
import {fstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runProcess} from '../src/runtime/process.ts';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';
const environment={PATH:process.env.PATH};
const options=(dir:string,more:Record<string,unknown>={})=>({cwd:dir,env:environment,timeoutMs:3000,captureDirectory:join(dir,'capture'),...more}) as any;
async function assertCaptureClosed(dir:string){
 const files=await Promise.all(['stdout.log','stderr.log'].map(name=>stat(join(dir,'capture',name))));
 const descriptors=await readdir(process.platform==='linux'?'/proc/self/fd':'/dev/fd');
 for(const descriptor of descriptors){let info;try{info=fstatSync(Number(descriptor));}catch{continue;}assert.ok(!files.some(file=>file.dev===info.dev&&file.ino===info.ino),'capture descriptor must be closed before returning');}
}
test('file capture exposes regular stdout and stderr descriptors and captures console output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-output-'));try{
  const output=await runProcess([process.execPath,'-e',"const fs=require('fs');console.log(JSON.stringify([fs.fstatSync(1).isFile(),fs.fstatSync(2).isFile()]));console.error('actual stderr');"],options(dir));
  assert.equal(output.status,'passed');assert.deepEqual(JSON.parse(output.stdout),[true,true]);assert.match(output.stderr,/actual stderr/);for(const name of ['stdout.log','stderr.log'])assert.equal((await stat(join(dir,'capture',name))).mode&0o777,0o600);await assertCaptureClosed(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('real Node test runner reports its assertions through regular-file capture',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-tests-'));try{
  const file=join(dir,'fixture.test.cjs');await writeFile(file,"const test=require('node:test'),assert=require('node:assert/strict');test('actual assertion',()=>assert.equal(2+2,4));");
  const output=await runProcess([process.execPath,'--test','--test-reporter=tap',file],options(dir));assert.equal(output.status,'passed');assert.match(output.stdout,/ok 1 - actual assertion/);assert.match(output.stdout,/# pass 1/);assert.match(output.stdout,/# fail 0/);await assertCaptureClosed(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('combined file capture limit kills continued output and returns bounded text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-limit-'));try{
  const output=await runProcess([process.execPath,'-e',"console.log('x'.repeat(5000));console.error('y'.repeat(5000));setInterval(()=>console.log('more'),5);"],options(dir,{maxBytes:1000}));assert.equal(output.status,'error');assert.equal(output.truncated,true);assert.ok(Buffer.byteLength(output.stdout)+Buffer.byteLength(output.stderr)<=1000);assert.ok(output.durationMs<2000);await assertCaptureClosed(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('file capture timeout closes descriptors and stops descendants before later writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-timeout-'));try{
  const marker=join(dir,'late');const script=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),700);`)}],{stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  const output=await runProcess([process.execPath,'-e',script],options(dir,{timeoutMs:150}));assert.equal(output.status,'timed_out');assert.ok(output.finishedAt!>=output.startedAt!);await assertCaptureClosed(dir);await delay(750);await assert.rejects(readFile(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('file capture closes handles on failed launch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-failure-'));try{
  const output=await runProcess([join(dir,'missing')],options(dir));assert.equal(output.status,'error');assert.match(output.stderr,/Executable could not start/);await assertCaptureClosed(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('partial file setup failure closes the first handle and preserves existing output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-setup-'));try{
  await mkdir(join(dir,'capture'),{mode:0o700});await writeFile(join(dir,'capture','stderr.log'),'existing',{mode:0o600});
  await assert.rejects(runProcess([process.execPath,'-e','console.log("unexpected")'],options(dir)),error=>(error as NodeJS.ErrnoException).code==='EEXIST');assert.equal(await readFile(join(dir,'capture','stderr.log'),'utf8'),'existing');await assertCaptureClosed(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('file capture cancellation closes descriptors after stopping the child',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-cancel-')),controller=new AbortController();try{
  const task=runProcess([process.execPath,'-e',"console.log('before cancel');setInterval(()=>{},1000);"],options(dir,{signal:controller.signal}));setTimeout(()=>controller.abort(),100);
  const output=await task;assert.equal(output.status,'error');assert.match(output.stderr,/Execution cancelled/);await assertCaptureClosed(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('successful parent exit cannot leave a writer alive through captured file descriptors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-file-orphan-'));try{
  const marker=join(dir,'orphan-write'),background=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),600);`;
  const script=`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(background)}],{stdio:'ignore'});console.log(child.pid);child.unref();`;
  const output=await runProcess([process.execPath,'-e',script],options(dir));assert.equal(output.status,'passed');assert.match(output.stdout,/^[0-9]+\n$/);await assertCaptureClosed(dir);await delay(700);await assert.rejects(readFile(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('compute runtime uses regular-file capture while retaining real test output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-compute-output-'));try{
  const input={version:1 as const,jobId:'compute',attempt:'attempt',mode:'compute' as const,snapshot:createSnapshot([]),argv:[process.execPath,'-e',"console.log(require('fs').fstatSync(1).isFile()?'COMPUTE_FILE_OUTPUT':'WRONG_DESCRIPTOR');"],timeoutMs:3000};
  const output=await executeRuntime(input,{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),computePrefix:[]});assert.equal(output.process.status,'passed');assert.match(output.process.stdout,/COMPUTE_FILE_OUTPUT/);assert.equal(output.credentialsAbsent,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
