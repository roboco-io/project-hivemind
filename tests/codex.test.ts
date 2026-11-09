import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexAdapter } from '../packages/adapters/src/codex.js';
import { runProcess, processEnvironment } from '../packages/adapters/src/process.js';
import type { Task } from '../packages/contracts/src/index.js';
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(body:string) {
  const dir=mkdtempSync(join(tmpdir(),'hivemind-codex-')),repo=join(dir,'repo');mkdirSync(repo);
  git(repo,'init');writeFileSync(join(repo,'value.txt'),'before\n');git(repo,'add','.');git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  const cli=join(dir,'fake-codex.cjs');writeFileSync(cli,`#!${process.execPath}\n${body}`);chmodSync(cli,0o755);
  const testCommand=[process.execPath,'-e',"console.log('test passed')"];
  const task:Task={title:'change',instructions:'change value',budgetMicros:5000,provider:'codex',runtime:'local',repositoryId:'local',baseCommit:git(repo,'rev-parse','HEAD'),testProfile:'default',testCommand:[...testCommand],id:'task',runId:'run',status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workerId:'worker',leaseExpiresAt:Date.now()+30000,estimatedCostMicros:null,actualCostMicros:null,diff:null,summary:null};
  return {dir,repo,cli,task,options:{repositoryPath:repo,worktreeRoot:join(dir,'worktrees'),codexCommand:cli,testCommand}};
}
const success=`const fs=require('node:fs'); const args=process.argv.slice(2); if (!args.includes('workspace-write') || args.some(a=>a.includes('dangerously')) || process.env.HIVEMIND_WORKER_TOKEN) process.exit(7); fs.writeFileSync('value.txt','after\\n'); console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Changed value.'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:3,output_tokens:4}}));`;
test('real subprocess adapter captures actual diff, test evidence and usage without inventing cost',async()=>{
  const f=fixture(success);const old=process.env.HIVEMIND_WORKER_TOKEN;process.env.HIVEMIND_WORKER_TOKEN='never-forward-this';
  try {
    const result=await createCodexAdapter(f.options).execute(f.task,new AbortController().signal);
    assert.equal(result.actualCostMicros,null);assert.match(result.diff,/\+after/);assert.equal(result.summary,'Changed value.');
    assert.equal(result.execution!.status,'succeeded');assert.equal(result.execution!.tests.status,'passed');assert.equal(result.execution!.tests.exitCode,0);assert.match(result.execution!.tests.stdout,/test passed/);
    assert.deepEqual(result.execution!.codex.usage,{inputTokens:12,cachedInputTokens:3,outputTokens:4});assert.equal(result.execution!.codex.threadId,'thread-1');
    assert.equal(readFileSync(join(f.repo,'value.txt'),'utf8'),'before\n');
  } finally {if(old===undefined)delete process.env.HIVEMIND_WORKER_TOKEN;else process.env.HIVEMIND_WORKER_TOKEN=old;rmSync(f.dir,{recursive:true,force:true});}
});
test('failed tests preserve diff and nonzero code, while execution is failed',async()=>{
  const f=fixture(success);
  try {
    const testCommand=[process.execPath,'-e',"console.error('assertion failed');process.exit(2)"];
    const result=await createCodexAdapter({...f.options,testCommand}).execute({...f.task,testCommand},new AbortController().signal);
    assert.equal(result.execution!.status,'failed');assert.equal(result.execution!.tests.status,'failed');assert.equal(result.execution!.tests.exitCode,2);assert.match(result.execution!.tests.stderr,/assertion failed/);assert.match(result.diff,/\+after/);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('worker rejects test-command drift before creating a worktree or starting Codex',async()=>{
  const f=fixture(success);
  try {
    const adapter=createCodexAdapter({...f.options,testCommand:[process.execPath,'-e',"console.log('different approved test')"]});
    await assert.rejects(adapter.execute(f.task,new AbortController().signal),/test command|test profile/i);
    assert.equal(existsSync(f.options.worktreeRoot),false);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('Codex failure and missing completion never become successful executions',async()=>{
  for(const body of ["console.error('Codex unavailable');process.exit(3)","console.log(JSON.stringify({type:'thread.started',thread_id:'incomplete'}))"]){
    const f=fixture(body);
    try {const result=await createCodexAdapter(f.options).execute(f.task,new AbortController().signal);assert.equal(result.execution!.status,'failed');assert.equal(result.execution!.tests.status,'not_run');assert.equal(result.actualCostMicros,null);}
    finally {rmSync(f.dir,{recursive:true,force:true});}
  }
});
test('setup failure skips tests and preserves the command output',async()=>{
  const f=fixture(success);
  try {const result=await createCodexAdapter({...f.options,setupCommand:[process.execPath,'-e',"console.error('setup failed');process.exit(8)"]}).execute(f.task,new AbortController().signal);assert.equal(result.execution!.setup!.exitCode,8);assert.equal(result.execution!.tests.status,'not_run');assert.equal(result.execution!.status,'failed');}
  finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('test environments omit service and inference credentials; output is bounded',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hivemind-process-'));
  try {
    const environment=processEnvironment(dir);
    assert.equal(environment.HIVEMIND_WORKER_TOKEN,undefined);assert.equal(environment.OPENAI_API_KEY,undefined);assert.equal(environment.CODEX_HOME,undefined);assert.equal(environment.HOME,dir);
    const result=await runProcess([process.execPath,'-e',"process.stdout.write('x'.repeat(40000));process.stderr.write('y'.repeat(40000))"],{cwd:dir,signal:new AbortController().signal,timeoutMs:5000,env:environment});
    assert.equal(result.status,'passed');assert.equal(result.truncated,true);assert.ok(result.stdout.length<=16000);assert.ok(result.stderr.length<=16000);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('process timeout kills its process group before returning',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hivemind-timeout-')),marker=join(dir,'late');
  try {
    const result=await runProcess([process.execPath,'-e',`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),800);setInterval(()=>{},1000)`],{cwd:dir,signal:new AbortController().signal,timeoutMs:100});
    assert.equal(result.status,'timed_out');await delay(900);assert.equal(existsSync(marker),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('process cancellation rejects after the child closes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hivemind-abort-'));const controller=new AbortController();
  try {const run=runProcess([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd:dir,signal:controller.signal,timeoutMs:5000});setTimeout(()=>controller.abort(new Error('cancelled by operator')),80);await assert.rejects(run,/cancelled by operator/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});
test('a process terminated by a signal reports an error with its unavailable exit code', {skip:process.platform === 'win32'},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hivemind-signal-'));
  try {
    const result=await runProcess([process.execPath,'-e',"process.kill(process.pid,'SIGTERM')"],{cwd:dir,signal:new AbortController().signal,timeoutMs:5000});
    assert.equal(result.status,'error');assert.equal(result.exitCode,null);assert.match(result.stderr,/SIGTERM/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('cancellation escalates to kill a descendant that ignores SIGTERM', {skip:process.platform === 'win32',timeout:8000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hivemind-group-')),ready=join(dir,'ready'),late=join(dir,'late');
  const controller=new AbortController();
  const descendant=`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late'),4000);setInterval(()=>{},1000)`;
  const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const run=runProcess([process.execPath,'-e',parent],{cwd:dir,signal:controller.signal,timeoutMs:7000});
  try {
    for(let i=0;i<100&&!existsSync(ready);i++)await delay(20);
    assert.equal(existsSync(ready),true);
    controller.abort(new Error('stop descendant'));
    await assert.rejects(run,/stop descendant/);
    await delay(2100);
    assert.equal(existsSync(late),false);
  } finally {controller.abort();await run.catch(()=>undefined);rmSync(dir,{recursive:true,force:true});}
});
