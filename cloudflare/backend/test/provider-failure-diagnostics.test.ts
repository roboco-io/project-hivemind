import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {parseProviderResult} from '../src/runtime/providers.ts';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {ProcessResult,Provider} from '../src/contracts.ts';
const final={type:'result',subtype:'success',is_error:false,result:'done'};
const processResult=(events:unknown[],patch:Partial<ProcessResult>={}):ProcessResult=>({status:'passed',exitCode:0,stdout:events.map(event=>JSON.stringify(event)).join('\n'),stderr:'',durationMs:1,truncated:false,...patch});
test('every existing failure predicate reports a fixed reason without relaxing success',()=>{
 const cases:[Provider,unknown[],Partial<ProcessResult>,string][]=[
  ['claude',[{type:'error',error:{type:'authentication_error'}},final],{},'AUTHENTICATION_REQUIRED'],
  ['claude',[final],{status:'failed',exitCode:1},'PROCESS_NOT_PASSED'],
  ['claude',[final],{truncated:true},'CAPTURE_TRUNCATED'],
  ['codex',[{type:'thread.started',thread_id:'fixture'}],{},'CODEX_MISSING_COMPLETION'],
  ['codex',[{type:'error',message:'generic fixture'},{type:'turn.completed'}],{},'CODEX_ERROR_EVENT'],
  ['claude',[{type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111'},...Array.from({length:17},(_,index)=>({...final,session_id:'11111111-1111-4111-8111-111111111111',uuid:`aaaaaaaa-aaaa-4aaa-8aaa-${String(index+1).padStart(12,'0')}`}))],{},'CLAUDE_RESULT_COUNT'],
  ['claude',[final,{type:'rate_limit_event',private:'not exported'}],{},'CLAUDE_RESULT_NOT_LAST'],
  ['claude',[{...final,subtype:'error_max_turns'}],{},'CLAUDE_RESULT_SUBTYPE'],
  ['claude',[{...final,is_error:true}],{},'CLAUDE_RESULT_ERROR_FLAG'],
  ['claude',[{...final,result:undefined}],{},'CLAUDE_RESULT_TEXT_MISSING'],
  ['claude',[{...final,stop_reason:'refusal'}],{},'CLAUDE_REFUSAL'],
  ['claude',[{...final,permission_denials:[{private:'not exported'}]}],{},'CLAUDE_PERMISSION_DENIALS'],
 ];
 for(const [provider,events,patch,expected]of cases){const parsed=parseProviderResult(provider,processResult(events,patch)) as any;assert.equal(parsed.success,false);assert.deepEqual(parsed.failureReasons,expected==='AUTHENTICATION_REQUIRED'?[expected,'CLAUDE_NATIVE_ERROR']:[expected]);assert.ok(!JSON.stringify(parsed.failureReasons).includes('not exported'));}
 for(const [provider,events]of [['claude',[final]],['codex',[{type:'turn.completed'}]]] as [Provider,unknown[]][]){const parsed=parseProviderResult(provider,processResult(events)) as any;assert.equal(parsed.success,true);assert.deepEqual(parsed.failureReasons,[]);}
});
test('trailing metadata is classified into fixed kinds and denial contents reduce to a count',()=>{
 const parsed=parseProviderResult('claude',processResult([{...final,permission_denials:[{private:'never exported'},{private:'never exported'}]},{type:'rate_limit_event',private:'never exported'},{type:'system',subtype:'hook_response',private:'never exported'},{type:'private-type-never-exported'}])) as any;
 assert.equal(parsed.success,false);assert.deepEqual(parsed.failureReasons,['CLAUDE_RESULT_NOT_LAST','CLAUDE_PERMISSION_DENIALS']);assert.deepEqual(parsed.trailingEventKinds,['RATE_LIMIT_EVENT','SYSTEM_HOOK','OTHER']);assert.equal(parsed.permissionDenialCount,2);
 assert.equal((parseProviderResult('claude',processResult([{...final,permission_denials:{private:'never exported'}}])) as any).permissionDenialCount,undefined);
});
test('multiple result diagnostics compare sessions and duplicate frames without exposing identities or contents',()=>{
 const root={...final,session_id:'PRIVATE_ROOT_ID',uuid:'PRIVATE_DUP_UUID',parent_tool_use_id:null,result:'PRIVATE_RESULT_TEXT'};
 const reordered={result:'PRIVATE_RESULT_TEXT',parent_tool_use_id:null,uuid:'PRIVATE_DUP_UUID',session_id:'PRIVATE_ROOT_ID',is_error:false,subtype:'success',type:'result'};
 const child={...final,session_id:'PRIVATE_CHILD_ID',uuid:'PRIVATE_CHILD_UUID',parent_tool_use_id:'PRIVATE_TOOL_ID',subtype:'error_during_execution',is_error:true,result:'PRIVATE_CHILD_TEXT'};
 const missing={type:'result',subtype:'unknown'};
 const parsed=parseProviderResult('claude',processResult([{type:'system',subtype:'init',session_id:'PRIVATE_ROOT_ID'},child,missing,root,reordered])) as any;
 assert.equal(parsed.success,false);assert.equal(parsed.resultCount,4);assert.equal(parsed.resultShapesTruncated,false);
 assert.deepEqual(parsed.resultShapes,[
  {initialSession:'OTHER',finalSession:'OTHER',parentToolUse:'NONEMPTY',uuidPresent:true,uuidDuplicate:false,identicalToFinal:false,subtype:'OTHER',isError:'TRUE'},
  {initialSession:'MISSING',finalSession:'MISSING',parentToolUse:'MISSING',uuidPresent:false,uuidDuplicate:false,identicalToFinal:false,subtype:'OTHER',isError:'MISSING'},
  {initialSession:'ROOT',finalSession:'ROOT',parentToolUse:'NULL',uuidPresent:true,uuidDuplicate:true,identicalToFinal:true,subtype:'SUCCESS',isError:'FALSE'},
  {initialSession:'ROOT',finalSession:'ROOT',parentToolUse:'NULL',uuidPresent:true,uuidDuplicate:true,identicalToFinal:true,subtype:'SUCCESS',isError:'FALSE'},
 ]);assert.ok(!JSON.stringify(parsed.resultShapes).includes('PRIVATE_'));
});
test('shape diagnostics cap result count and shapes at sixteen without accepting excess results',()=>{
 const events=Array.from({length:18},(_,i)=>({...final,session_id:'private-session',uuid:`private-${i}`}));
 const parsed=parseProviderResult('claude',processResult(events)) as any;assert.equal(parsed.success,false);assert.equal(parsed.resultCount,16);assert.equal(parsed.resultShapes.length,16);assert.equal(parsed.resultShapesTruncated,true);assert.ok(parsed.resultShapes.every((item:any)=>item.initialSession==='MISSING'&&item.finalSession==='ROOT'));
});
test('the published successful Claude native stream still passes unchanged',async()=>{
 const proof=JSON.parse(await readFile(new URL('../../docs/phase0/cloudflare-claude-subscription-20261110.json',import.meta.url),'utf8'));
 const events=proof.diagnostics.events.map((item:{event:unknown})=>item.event),parsed=parseProviderResult('claude',processResult(events)) as any;
 assert.equal(parsed.success,true);assert.deepEqual(parsed.failureReasons,[]);
});
test('zero-exit runtime rejects a nonterminal result with fixed diagnostics only',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-parse-reason-'));try{
  const cli=join(dir,'fake.cjs'),keys=generateKeyPairSync('rsa',{modulusLength:2048});const events=[final,{type:'rate_limit_event',private:'PRIVATE_TRAILING_FIXTURE'}];
  await writeFile(cli,`#!${process.execPath}\nfor(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`,{mode:0o755});
  const result=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'claude',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:3000,auth:'sk-ant-oat01-fake-fixture',authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{claude:cli}});
  assert.equal(result.process.exitCode,0);assert.equal(result.process.status,'error');assert.equal(result.process.stderr,'HIVEMIND_PROVIDER_RESULT_REJECTED:CLAUDE_RESULT_NOT_LAST TRAILING_EVENT_KINDS:RATE_LIMIT_EVENT');assert.ok(!JSON.stringify(result).includes('PRIVATE_TRAILING_FIXTURE'));assert.ok(!JSON.stringify(result).includes('sk-ant-oat01-fake-fixture'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('zero-exit runtime emits bounded duplicate-result shapes with no raw session or result values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-result-shapes-'));try{
  const cli=join(dir,'fake.cjs'),keys=generateKeyPairSync('rsa',{modulusLength:2048}),resultEvent={...final,session_id:'PRIVATE_SESSION_VALUE',uuid:'PRIVATE_UUID_VALUE',parent_tool_use_id:null,result:'safe summary'};
  await writeFile(cli,`#!${process.execPath}\nfor(const event of ${JSON.stringify([{type:'system',subtype:'init',session_id:'PRIVATE_SESSION_VALUE'},resultEvent,resultEvent])})console.log(JSON.stringify(event));`,{mode:0o755});
  const result=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'claude',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:3000,auth:'sk-ant-oat01-fake-fixture',authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{claude:cli}});
  assert.equal(result.process.status,'error');assert.match(result.process.stderr,/RESULT_COUNT:2/);assert.match(result.process.stderr,/RESULT_SHAPES:/);assert.match(result.process.stderr,/"uuidDuplicate":true/);assert.match(result.process.stderr,/"identicalToFinal":true/);assert.ok(!result.process.stderr.includes('PRIVATE_'));assert.ok(result.process.stderr.length<=16000);
 }finally{await rm(dir,{recursive:true,force:true});}
});
