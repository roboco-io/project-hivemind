import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter } from '../packages/adapters/src/claude.js';
import { processEnvironment } from '../packages/adapters/src/process.js';
import type { Task } from '../packages/contracts/src/index.js';

const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(body:string) {
  const dir=mkdtempSync(join(tmpdir(),'hivemind-claude-')),repo=join(dir,'repo');mkdirSync(repo);
  git(repo,'init');writeFileSync(join(repo,'value.txt'),'before\n');git(repo,'add','.');git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  writeFileSync(join(repo,'value.txt'),'original dirty content\n');
  const cli=join(dir,'fake-claude.cjs');writeFileSync(cli,`#!${process.execPath}\n${body}`);chmodSync(cli,0o755);
  const testCommand=[process.execPath,'-e',"console.log('test passed')"];
  const task:Task={title:'change',instructions:'change value',budgetMicros:5000,provider:'claude',runtime:'local',repositoryId:'local',baseCommit:git(repo,'rev-parse','HEAD'),testProfile:'default',testCommand:[...testCommand],id:'task',runId:'run',status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workerId:'worker',leaseExpiresAt:Date.now()+30000,estimatedCostMicros:null,actualCostMicros:null,diff:null,summary:null};
  return {dir,repo,task,options:{repositoryPath:repo,worktreeRoot:join(dir,'worktrees'),claudeCommand:cli,testCommand}};
}
const result={type:'result',subtype:'success',is_error:false,result:'Changed value.',session_id:'session-claude',permission_denials:[],modelUsage:{'fixture-model':{}},usage:{input_tokens:12,cache_read_input_tokens:3,cache_creation_input_tokens:5,output_tokens:4},total_cost_usd:99};
const success=`const fs=require('node:fs'); const args=process.argv.slice(2); if (!args.includes('--restricted') || !args.includes('--safe-mode') || !args.includes('acceptEdits') || args.some(a=>a.includes('dangerously')||a==='--bare') || args.includes('--model') || process.env.HIVEMIND_WORKER_TOKEN || process.env.CODEX_API_KEY) process.exit(7); if(args[args.indexOf('--tools')+1]!=='Read,Edit,Write,Glob,Grep')process.exit(8);fs.writeFileSync('value.txt','after\\n');fs.writeFileSync('fresh.txt','new file\\n');console.log(${JSON.stringify(JSON.stringify(result))});`;

test('Claude subprocess returns actual diff and tests with provider-specific evidence',async()=>{
 const f=fixture(success);
 try {const r=await createClaudeAdapter(f.options).execute(f.task,new AbortController().signal);
  assert.equal(r.execution!.status,'succeeded');assert.equal(r.execution!.claude!.status,'passed');assert.equal(r.execution!.codex,undefined);
  assert.equal(r.summary,'Changed value.');assert.equal(r.actualCostMicros,null);assert.equal(r.execution!.claude!.threadId,'session-claude');assert.equal(r.execution!.claude!.model,'fixture-model');
  assert.deepEqual(r.execution!.claude!.usage,{inputTokens:20,cachedInputTokens:3,outputTokens:4});
  assert.match(r.diff,/\+after/);assert.match(r.diff,/fresh.txt/);assert.equal(r.execution!.tests.exitCode,0);assert.match(r.execution!.tests.stdout,/test passed/);
  assert.equal(readFileSync(join(f.repo,'value.txt'),'utf8'),'original dirty content\n');assert.equal(git(f.repo,'diff','--cached'),'');
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('Claude rejects malformed, incomplete, denied, refusal and error JSON even on exit zero',async()=>{
 const outputs=[{...result,subtype:'error_during_execution',is_error:true,result:undefined,errors:['unavailable']},{...result,permission_denials:[{tool_name:'Write'}]},{...result,stop_reason:'refusal'},{...result,is_error:undefined},{...result,result:undefined},{...result,type:'assistant'},{...result,subtype:'error_max_turns'},'not-json'];
 for(const output of outputs){const text=typeof output==='string'?output:JSON.stringify(output);const f=fixture(`console.log(${JSON.stringify(text)})`);
  try{const r=await createClaudeAdapter(f.options).execute(f.task,new AbortController().signal);assert.equal(r.execution!.status,'failed');assert.equal(r.execution!.claude!.status,'error');assert.equal(r.execution!.tests.status,'not_run');assert.equal(r.actualCostMicros,null);}
  finally{rmSync(f.dir,{recursive:true,force:true});}
 }
});
test('Claude failed tests and setup remain inspectable',async()=>{
 for(const phase of ['test','setup']){const f=fixture(success);const failing=[process.execPath,'-e',"console.error('assertion failed');process.exit(2)"];
  const options=phase==='test'?{...f.options,testCommand:failing}:{...f.options,setupCommand:failing};
  const task=phase==='test'?{...f.task,testCommand:failing}:f.task;
  try{const r=await createClaudeAdapter(options).execute(task,new AbortController().signal);assert.equal(r.execution!.status,'failed');assert.match(r.diff,/\+after/);
   assert.equal(phase==='test'?r.execution!.tests.exitCode:r.execution!.setup!.exitCode,2);assert.equal(r.execution!.tests.status,phase==='test'?'failed':'not_run');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
 }
});
test('Claude timeout keeps diff and abort stops before result',async()=>{
 for(const aborted of [false,true]){const f=fixture("require('node:fs').writeFileSync('value.txt','partial\\n');setInterval(()=>{},1000)");const controller=new AbortController();
  try{const pending=createClaudeAdapter({...f.options,timeoutMs:aborted?5000:1500}).execute(f.task,controller.signal);
   if(aborted){setTimeout(()=>controller.abort(new Error('operator cancelled Claude')),180);await assert.rejects(pending,/operator cancelled Claude/);}
   else {const r=await pending;assert.equal(r.execution!.claude!.status,'timed_out');assert.equal(r.execution!.tests.status,'not_run');assert.equal(r.execution!.status,'failed');assert.match(r.diff,/partial/);}
  }finally{controller.abort();rmSync(f.dir,{recursive:true,force:true});}
 }
});
test('Claude validates approved command before creating a worktree',async()=>{
 const f=fixture(success);
 try{await assert.rejects(createClaudeAdapter({...f.options,testCommand:['other']}).execute(f.task,new AbortController().signal),/test command|test profile/);assert.equal(existsSync(f.options.worktreeRoot),false);}
 finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('Claude output truncation does not produce successful evidence',async()=>{
 const f=fixture(`console.log(' '.repeat(1100000)+${JSON.stringify(JSON.stringify(result))})`);
 try{const r=await createClaudeAdapter(f.options).execute(f.task,new AbortController().signal);assert.equal(r.execution!.status,'failed');assert.equal(r.execution!.tests.status,'not_run');}
 finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('Claude and Codex authentication environments remain separate from each other and tests',()=>{
 const keys=['CODEX_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','HIVEMIND_WORKER_TOKEN','USER'] as const;const old=keys.map(k=>process.env[k]);
 try{for(const key of keys)process.env[key]='fixture-secret';
  const claude=processEnvironment('/auth-home','claude');assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN,'fixture-secret');assert.equal(claude.ANTHROPIC_API_KEY,'fixture-secret');assert.equal(claude.CODEX_API_KEY,undefined);assert.equal(claude.HIVEMIND_WORKER_TOKEN,undefined);assert.equal(claude.USER,'fixture-secret');
  const codex=processEnvironment('/auth-home',true);assert.equal(codex.CODEX_API_KEY,'fixture-secret');assert.equal(codex.ANTHROPIC_API_KEY,undefined);assert.equal(codex.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(codex.USER,undefined);
  const tests=processEnvironment('/isolated-home');for(const key of keys)assert.equal(tests[key],undefined);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});

test('Claude accepts a native JSON message array with one final successful result',async()=>{
 const messages=[{type:'system',subtype:'init',model:'fixture-model'},{type:'assistant',message:{content:[]} },result];
 const f=fixture(`require('node:fs').writeFileSync('value.txt','array update\\n');console.log(${JSON.stringify(JSON.stringify(messages))});`);
 try{const r=await createClaudeAdapter(f.options).execute(f.task,new AbortController().signal);assert.equal(r.execution!.status,'succeeded');assert.equal(r.execution!.claude!.threadId,'session-claude');assert.match(r.diff,/array update/);}
 finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('Claude keeps native array authentication errors as failures with their diagnostic',async()=>{
 const messages=[{type:'system',subtype:'init'},{type:'assistant'},{...result,is_error:true,result:'Failed to authenticate fixture account'}];
 const f=fixture(`console.log(${JSON.stringify(JSON.stringify(messages))});process.exit(1);`);
 try{const r=await createClaudeAdapter(f.options).execute(f.task,new AbortController().signal);assert.equal(r.execution!.status,'failed');assert.equal(r.execution!.claude!.status,'failed');assert.equal(r.execution!.tests.status,'not_run');assert.match(r.summary,/Failed to authenticate fixture account/);}
 finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('Claude rejects ambiguous, nonterminal and malformed result arrays',async()=>{
 const invalid=[[result,result],[result,{type:'assistant'}],[{type:'system',subtype:'init'}],[],[null,result]];
 for(const messages of invalid){const f=fixture(`console.log(${JSON.stringify(JSON.stringify(messages))});`);
  try{const r=await createClaudeAdapter(f.options).execute(f.task,new AbortController().signal);assert.equal(r.execution!.status,'failed');assert.equal(r.execution!.claude!.status,'error');assert.equal(r.execution!.tests.status,'not_run');}
  finally{rmSync(f.dir,{recursive:true,force:true});}
 }
});
