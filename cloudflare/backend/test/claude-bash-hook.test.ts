import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';
import * as hookModule from '../src/runtime/claude-bash-hook.ts';
import {bashHookReply,GUARD,MAX_COMMAND_BYTES,MAX_HOOK_BYTES,shellQuote} from '../src/runtime/claude-bash-hook.ts';
const hook=fileURLToPath(new URL('../src/runtime/claude-bash-hook.ts',import.meta.url));
const metadata={session_id:'session-root',agent_id:'agent-child',tool_use_id:'toolu_1',tool_name:'Bash',tool_input:{command:'printf private-command-fixture'}};
const run=(command:string,args:string[],input:string)=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.on('error',()=>{});child.stdin.end(input);});
test('managed Bash hook changes only the command and does not grant permission',()=>{
 const input={command:'printf "hello"',timeout:1000,description:'fixture',run_in_background:false,dangerouslyDisableSandbox:false};
 const reply=bashHookReply({tool_name:'Bash',tool_input:input}) as any;
 assert.deepEqual(reply,{hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input,command:`${shellQuote(GUARD)} -- /bin/bash -c ${shellQuote(input.command)}`}}});assert.equal('permissionDecision'in reply.hookSpecificOutput,false);assert.equal(input.command,'printf "hello"');
});
test('managed Bash hook refuses unsafe or oversized command input',()=>{
 for(const value of [null,{tool_name:'Read',tool_input:{command:'true'}},{tool_name:'Bash',tool_input:null},{tool_name:'Bash',tool_input:{command:'true',dangerouslyDisableSandbox:true}},{tool_name:'Bash',tool_input:{command:'true',dangerouslyDisableSandbox:'true'}},{tool_name:'Bash',tool_input:{command:'private\0command'}},{tool_name:'Bash',tool_input:{command:'x'.repeat(MAX_COMMAND_BYTES+1)}}])assert.throws(()=>bashHookReply(value),/Protected Bash input is required/);
});
test('original shell syntax reaches the guard unchanged before any substitution executes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-hook-'));try{
  const marker=join(dir,'should-not-exist'),guard=join(dir,'fake guard.cjs');await writeFile(guard,`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`,{mode:0o755});
  const original=`printf '%s' "$(touch ${shellQuote(marker)})"; \`touch ${shellQuote(marker)}\`; echo 'single quote' \\ path`;
  const reply=bashHookReply({tool_name:'Bash',tool_input:{command:original}}) as any;
  const updated=reply.hookSpecificOutput.updatedInput.command as string;assert.ok(updated.startsWith(shellQuote(GUARD)+' -- '));
  const result=await run('/bin/bash',['-c',shellQuote(guard)+updated.slice(shellQuote(GUARD).length)],'');assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),['--','/bin/bash','-c',original]);await assert.rejects(readFile(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('hook process bounds stdin and emits generic blocking errors without echoing input',async()=>{
 for(const input of ['{"private-fixture":',JSON.stringify({tool_name:'Bash',tool_input:{command:'private-fixture',dangerouslyDisableSandbox:true}}),'x'.repeat(MAX_HOOK_BYTES+1)]){const result=await run(process.execPath,[hook],input);assert.equal(result.code,2);assert.equal(result.stdout,'');assert.equal(result.stderr,'Hivemind requires a protected Bash command.\n');}
});
test('safe Bash audit binds root or child identity to only a command hash',()=>{
 const make=(hookModule as any).sandboxReceipt;assert.equal(typeof make,'function');
 const timestamp='2026-11-10T00:00:00.000Z';const expected={sessionId:'session-root',agentId:'agent-child',toolUseId:'toolu_1',commandHash:createHash('sha256').update(metadata.tool_input.command).digest('hex'),timestamp};
 assert.deepEqual(make(metadata,timestamp),expected);assert.deepEqual(make({...metadata,agent_id:undefined},timestamp),{...expected,agentId:null});
 for(const patch of [{session_id:''},{session_id:'x'.repeat(129)},{agent_id:'private\nvalue'},{tool_use_id:''},{tool_use_id:'private/token'}])assert.throws(()=>make({...metadata,...patch},timestamp),/Protected Bash input/);
 assert.ok(!JSON.stringify(expected).includes(metadata.tool_input.command));
});
test('audit persistence must finish before a hook reply is returned and failure blocks the reply',async()=>{
 const audited=(hookModule as any).auditedBashHookReply;assert.equal(typeof audited,'function');
 let persisted=false;const response=await audited(metadata,'2026-11-10T00:00:00.000Z',async(receipt:unknown)=>{assert.ok(receipt);persisted=true;});assert.equal(persisted,true);assert.equal(response.hookSpecificOutput.hookEventName,'PreToolUse');
 await assert.rejects(audited(metadata,'2026-11-10T00:00:00.000Z',async()=>{throw new Error('private-path-fixture');}),error=>error instanceof Error&&error.message==='Sandbox audit could not be persisted');
});
test('audit parser bounds metadata and never carries extra raw fields into artifacts',()=>{
 const parse=(hookModule as any).parseSandboxReceipts;assert.equal(typeof parse,'function');
 const receipt={sessionId:'session-root',agentId:null,toolUseId:'toolu_1',commandHash:'a'.repeat(64),timestamp:'2026-11-10T00:00:00.000Z'};
 assert.deepEqual(parse(JSON.stringify({...receipt,command:'private-fixture'})+'\n'),[receipt]);
 for(const raw of ['{private-fixture',JSON.stringify({...receipt,commandHash:'not-hash'}),JSON.stringify({...receipt,timestamp:'not-time'}),'x'.repeat(MAX_HOOK_BYTES+1)])assert.throws(()=>parse(raw),/Invalid sandbox audit metadata/);
});
test('runtime carries bounded root and child guard audit metadata without raw commands',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-guard-runtime-'));try{
  const timestamp='2026-11-10T00:00:00.000Z',receipts=[null,'agent-a','agent-b'].map((agentId,index)=>({sessionId:'session-root',agentId,toolUseId:`toolu_${index}`,commandHash:createHash('sha256').update(`command${index}`).digest('hex'),timestamp}));
  const cli=join(dir,'fake.cjs'),keys=generateKeyPairSync('rsa',{modulusLength:2048});
  await writeFile(cli,`#!${process.execPath}\nconst fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.env.HOME,'.hivemind-phase0','bash-guards.jsonl'),${JSON.stringify(receipts.map(receipt=>JSON.stringify({...receipt,command:'private-command-never-export'})).join('\n')+'\n')});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`,{mode:0o755});
  const value=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'claude',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:5000,auth:'sk-ant-oat01-private-fixture',authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{claude:cli}});
  assert.equal(value.process.status,'passed');assert.deepEqual(value.sandboxReceipts,receipts);assert.ok(!JSON.stringify(value).includes('private-command-never-export'));assert.ok(!JSON.stringify(value).includes('sk-ant-oat01-private-fixture'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('managed settings require native sandbox plus guarded Bash and native subagent audit hooks',async()=>{
 const settings=JSON.parse(await readFile(new URL('../config/claude-managed-settings.json',import.meta.url),'utf8'));
 assert.deepEqual(settings.sandbox,{enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,allowNestedUserNamespaces:true,network:{allowedDomains:[]}});assert.equal(settings.allowManagedHooksOnly,true);assert.equal(settings.disableAllHooks,false);
 assert.deepEqual(settings.env,{NODE_OPTIONS:'',LD_PRELOAD:'',LD_LIBRARY_PATH:'',BASH_ENV:'',ENV:''});
 assert.deepEqual(settings.hooks.PreToolUse,[{matcher:'^Bash$',hooks:[{type:'command',command:'/usr/local/bin/node /opt/hivemind/backend/src/runtime/claude-bash-hook.ts',timeout:5,onFailure:'block'}]}]);
 for(const event of ['SubagentStart','SubagentStop'])assert.deepEqual(settings.hooks[event],[{matcher:'^worker$',hooks:[{type:'command',command:'/usr/local/bin/node /opt/hivemind/scripts/phase0/claude-agent-hook.ts',timeout:5}]}]);
 assert.equal('bwrapPath'in settings.sandbox,false);assert.equal('enableWeakerNestedSandbox'in settings.sandbox,false);
});
