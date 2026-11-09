import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as probe from '../scripts/phase0/claude-command-concurrency-probe.ts';
import {runBounded} from '../scripts/phase0/run-bounded.ts';
import {bashHookReply} from '../backend/src/runtime/claude-bash-hook.ts';

const run=(label:string,start:number)=>({label,exitCode:0,timedOut:false,captureLimit:false,outputMatches:true,receipt:{stage:'complete',label,startedAt:start,finishedAt:start+1000,uid:1000,environmentClean:true,namespaceGuardApplied:true}});
const good=()=>({authProvided:false,modelCalled:false,guardCacheCredentialsAbsent:true,uid:1000,noNewPrivileges:'1',capabilities:{CapInh:'0',CapPrm:'0',CapEff:'0',CapBnd:'0',CapAmb:'0'},parallel:[run('alpha',1000),run('beta',1100)],serial:run('serial',4000)});
test('concurrency proof requires both guarded commands and a serial control to finish with overlapping real work',()=>{
 const assess=(probe as any).assessClaudeCommandConcurrency;assert.equal(typeof assess,'function');assert.equal(assess(good()).passed,true);
 for(const patch of [{parallel:[run('alpha',1000),run('beta',2100)]},{parallel:[run('alpha',1000)]},{serial:{...run('serial',4000),timedOut:true}},{parallel:[{...run('alpha',1000),outputMatches:false},run('beta',1100)]},{parallel:[run('alpha',1000),{...run('beta',1100),receipt:{...run('beta',1100).receipt,namespaceGuardApplied:false}}]},{authProvided:true},{guardCacheCredentialsAbsent:false},{capabilities:{CapEff:'0'}}])assert.equal(assess({...good(),...patch}).passed,false);
});
test('SRT command matches the actual managed Bash hook rewrite',()=>{
 const command=(probe as any).claudeCommandConcurrencyArgs;const bash=(probe as any).concurrencyBashCommand;assert.equal(typeof command,'function');assert.equal(typeof bash,'function');
 const args=command('alpha');assert.deepEqual(args.slice(0,5),['--settings','/home/node/.hivemind-phase0/claude-command-concurrency-settings.json','--','/bin/bash','-c']);
 const reply=bashHookReply({tool_name:'Bash',tool_input:{command:bash('alpha')}}) as any;assert.equal(args[5],reply.hookSpecificOutput.updatedInput.command);assert.ok(args[5].includes('claude-command-guard.ts'));assert.throws(()=>command('arbitrary'));
});
test('fixed Node wait plus cat Bash command survives actual shell quoting locally',async()=>{
 const dir=await mkdtemp(join(tmpdir(),"hive-'concurrency-"));try{
  const build=(probe as any).concurrencyBashCommand;assert.equal(typeof build,'function');const result=await runBounded('/bin/bash',['-c',build('alpha',process.execPath,dir)],{cwd:dir,env:{PATH:process.env.PATH},timeoutMs:5000,maxBytes:32768});
  assert.equal(result.exitCode,0);assert.equal(await readFile(join(dir,'claude-command-alpha.txt'),'utf8'),'ALPHA_DONE\n');
  const receipt=JSON.parse(await readFile(join(dir,'claude-command-alpha.receipt.json'),'utf8'));assert.equal(receipt.stage,'complete');assert.ok(receipt.finishedAt-receipt.startedAt>=900);assert.match(result.stdout,/ALPHA_DONE/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('concurrency diagnostics enable guard trace without retaining input credentials',()=>{
 const environment=(probe as any).claudeCommandConcurrencyEnvironment;assert.equal(typeof environment,'function');
 const env=environment({PATH:'/bin',OPENAI_API_KEY:'private',AWS_SECRET_ACCESS_KEY:'private',HIVEMIND_GUARD_TRACE:'0'});assert.equal(env.HIVEMIND_GUARD_TRACE,'1');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined);
});
test('concurrency diagnostics return bounded trace metadata and cache names/sizes without file contents',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-cache-diagnostic-'));try{
  const collect=(probe as any).collectConcurrencyDiagnostics;assert.equal(typeof collect,'function');
  const cache=join(dir,'cache');await mkdir(cache);await mkdir(join(cache,'tmp'));await writeFile(join(cache,'auth.json'),'PRIVATE_FIXTURE_VALUE');await writeFile(join(cache,'tmp','lock'),'NON_SECRET_CACHE_CONTENT');await symlink(join(cache,'auth.json'),join(cache,'helper-link'));
  const trace=join(dir,'trace.jsonl');await writeFile(trace,JSON.stringify({stage:'node-enter',timestamp:'2026-11-10T00:00:00.000Z',pid:4,ppid:3,cwd:'/workspace',stdinKind:'pipe',envNames:['PATH','HTTPS_PROXY'],commandHash:'a'.repeat(64),argv0basename:'bash',command:'PRIVATE_FIXTURE_VALUE',env:{TOKEN:'PRIVATE_FIXTURE_VALUE'}})+'\n'+JSON.stringify({stage:'namespace-filter-loaded',timestamp:'2026-11-10T00:00:01.000Z',pid:2,ppid:1})+'\n');
  const result=await collect(cache,trace);assert.equal(result.trace.records.length,2);assert.equal(result.trace.records[0].stage,'node-enter');assert.equal(result.cache.authEntriesOmitted,1);assert.ok(result.cache.entries.some((entry:any)=>entry.name==='tmp/lock'&&entry.size===24));assert.ok(result.cache.entries.some((entry:any)=>entry.name==='helper-link'&&entry.type==='symlink'));assert.ok(!JSON.stringify(result).includes('PRIVATE_FIXTURE_VALUE'));assert.ok(!JSON.stringify(result).includes('NON_SECRET_CACHE_CONTENT'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('in-flight wait diagnostics expose syscall numbers and registry metadata without arguments or contents',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-wait-diagnostic-'));try{
  const collect=(probe as any).collectConcurrencyWaitState;assert.equal(typeof collect,'function');
  const proc=join(dir,'proc'),temporary=join(dir,'tmp');await mkdir(join(proc,'42'),{recursive:true});await mkdir(join(temporary,'codex-bwrap-synthetic-mount-targets-1000','abcdef'),{recursive:true});
  await writeFile(join(proc,'42','comm'),'codex\n');await writeFile(join(proc,'42','status'),'State:\tS (sleeping)\nPPid:\t1\nNSpid:\t42\t2\nIgnored:\tDONT_EXPORT\n');await writeFile(join(proc,'42','wchan'),'locks_lock_inode_wait\n');await writeFile(join(proc,'42','syscall'),'73 0xDONT_EXPORT 0x123 0x456\n');await writeFile(join(temporary,'codex-bwrap-synthetic-mount-targets-1000','abcdef','2'),'DONT_EXPORT');
  const result=await collect(proc,temporary);const row=result.processes.find((item:any)=>item.pid===42);assert.equal(row.ppid,1);assert.equal(row.state,'S');assert.equal(row.wchan,'locks_lock_inode_wait');assert.equal(row.syscallNumber,73);assert.deepEqual(row.namespacePids,[42,2]);assert.ok(result.registries.entries.some((item:any)=>item.name==='codex-bwrap-synthetic-mount-targets-1000/abcdef/2'&&item.size===11));assert.ok(!JSON.stringify(result).includes('DONT_EXPORT'));assert.ok(!JSON.stringify(result).includes('0x123'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('nested bubblewrap cause probe requires fatal proc namespace lookup and a surviving orphan group',()=>{
 const assess=(probe as any).assessNestedBwrapCause;assert.equal(typeof assess,'function');
 const observed={parentExitCode:1,parentExitedBeforeGuard:true,orphanGroupAliveBeforeKill:true,warmup:{selectedMissingTarget:true,predictedChildPid:22},stderr:'bwrap: open /proc/22/ns failed: No such file or directory\n'};
 assert.equal(assess(observed).hypothesisMatched,true);for(const patch of [{parentExitCode:0},{parentExitedBeforeGuard:false},{orphanGroupAliveBeforeKill:false},{stderr:'other failure'}])assert.equal(assess({...observed,...patch}).hypothesisMatched,false);
 assert.equal(assess({...observed,stderr:'bwrap: open /proc/74/ns/ns failed: No such file or directory\n'}).hypothesisMatched,true);
 const args=(probe as any).nestedBwrapCauseArgs();assert.deepEqual(args,['--unshare-user','--unshare-pid','--ro-bind','/','/','--proc','/proc','--dev','/dev','--','/bin/true']);
 const script=(probe as any).nestedBwrapCauseScript();assert.doesNotThrow(()=>new Function(script));assert.ok(script.includes('3000'));assert.ok(script.includes("stdio:['ignore','ignore',stderrFd]"));assert.ok(script.includes("process.kill(-child.pid,'SIGKILL')"));
});
test('nested bubblewrap warmup selects an absent predicted child PID after a fixed bounded warmup',()=>{
 const warmup=(probe as any).warmupNestedBwrapPid;assert.equal(typeof warmup,'function');let count=0;const probed:number[]=[];
 const result=warmup(()=>({pid:10+count++,status:0}), (pid:number)=>{probed.push(pid);return pid===76?{exists:false,error:'ENOENT'}:{exists:true,error:null};});
 assert.equal(result.attempts,65);assert.equal(result.selectedMissingTarget,true);assert.equal(result.predictedBwrapPid,75);assert.equal(result.predictedChildPid,76);assert.deepEqual(probed,[75,76]);
 let attempts=0;const none=warmup(()=>({pid:10+attempts++,status:0}),()=>({exists:true,error:null}));assert.equal(attempts,128);assert.equal(none.selectedMissingTarget,false);
 assert.equal(warmup(()=>({pid:1,status:1}),()=>({exists:false,error:'ENOENT'})).selectedMissingTarget,false);
});
