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
