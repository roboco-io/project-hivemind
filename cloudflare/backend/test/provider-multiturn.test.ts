import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProviderResult} from '../src/runtime/providers.ts';
import type {ProcessResult} from '../src/contracts.ts';
const root='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const init=(session_id=root)=>({type:'system',subtype:'init',session_id});
const result=(index:number,patch:Record<string,unknown>={})=>({type:'result',subtype:'success',is_error:false,result:`turn ${index}`,session_id:root,uuid:`aaaaaaaa-aaaa-4aaa-8aaa-${String(index+1).padStart(12,'0')}`,...patch});
const processResult=(events:unknown[],patch:Partial<ProcessResult>={}):ProcessResult=>({status:'passed',exitCode:0,stdout:events.map(event=>JSON.stringify(event)).join('\n'),stderr:'',durationMs:1,truncated:false,...patch});
const parse=(events:unknown[],patch:Partial<ProcessResult>={})=>parseProviderResult('claude',processResult(events,patch));
test('three distinct successful root-session turns form one valid terminal receipt sequence',()=>{
 const parsed=parse([init(),result(0),result(1,{parent_tool_use_id:null}),result(2)]);
 assert.equal(parsed.success,true);assert.equal(parsed.summary,'turn 2');assert.equal(parsed.sessionId,root);assert.deepEqual(parsed.failureReasons,[]);
});
test('repeated consistent init metadata still identifies one unambiguous root session',()=>{
 assert.equal(parse([init(),result(0),init(),result(1)]).success,true);
});
test('single-result legacy streams remain supported and available root init binds the terminal result',()=>{
 assert.equal(parse([{type:'result',subtype:'success',is_error:false,result:'legacy'}]).success,true);
 assert.equal(parse([init(),result(0)]).success,true);
 for(const patch of [{session_id:other},{session_id:undefined},{parent_tool_use_id:'toolu_child'},{parent_tool_use_id:''}])assert.equal(parse([init(),result(0,patch)]).success,false,JSON.stringify(patch));
 for(const parent_tool_use_id of ['toolu_child','',false,{},0])assert.equal(parse([result(0,{parent_tool_use_id})]).success,false,'anonymous legacy result must not be child-bound');
});
test('multi-turn receipts reject missing, invalid, ambiguous and child-bound root scopes',()=>{
 for(const events of [[result(0),result(1)],[init('not-uuid'),result(0),result(1)],[init(),init(other),result(0),result(1)],[{...init(),parent_tool_use_id:'toolu_child'},result(0),result(1)],[init(),result(0,{session_id:other}),result(1)],[init(),result(0,{session_id:undefined}),result(1)],[init(),result(0,{parent_tool_use_id:'toolu_child'}),result(1)],[init(),result(0,{parent_tool_use_id:''}),result(1)]]){
  const parsed=parse(events);assert.equal(parsed.success,false);assert.ok(parsed.failureReasons.includes('CLAUDE_RESULT_COUNT'));assert.ok((parsed.failureReasons as string[]).includes('CLAUDE_RESULT_SCOPE'));
 }
});
test('multi-turn receipts require valid unique UUIDs without deduplicating frames',()=>{
 for(const first of [result(0,{uuid:undefined}),result(0,{uuid:'not-uuid'}),result(0,{uuid:result(1).uuid}),result(0,{uuid:result(1).uuid.toUpperCase()})]){
  const parsed=parse([init(),first,result(1)]);assert.equal(parsed.success,false);assert.ok((parsed.failureReasons as string[]).includes('CLAUDE_RESULT_RECEIPTS'));
 }
});
test('any earlier receipt error, missing text, refusal or denial rejects the whole sequence',()=>{
 for(const patch of [{subtype:'error_during_execution'},{is_error:true},{is_error:undefined},{result:undefined},{stop_reason:'refusal'},{permission_denials:[{tool_name:'fixture'}]},{permission_denials:{malformed:true}}]){
  const parsed=parse([init(),result(0,patch),result(1)]);assert.equal(parsed.success,false);assert.ok((parsed.failureReasons as string[]).includes('CLAUDE_RESULT_RECEIPTS'),JSON.stringify(patch));
 }
});
test('multi-turn receipts retain terminal ordering, execution, authentication and bounded-count gates',()=>{
 const valid=[init(),result(0),result(1),result(2)];
 assert.equal(parse([...valid,{type:'rate_limit_event'}]).success,false);
 assert.equal(parse(valid,{status:'failed',exitCode:1}).success,false);const invalidExit=parse(valid,{exitCode:1});assert.equal(invalidExit.success,false);assert.ok(invalidExit.failureReasons.includes('PROCESS_NOT_PASSED'));assert.equal(parse(valid,{truncated:true}).success,false);
 assert.equal(parse([init(),{type:'error',error:{type:'authentication_error'}},result(0),result(1)]).success,false);
 const excess=parse([init(),...Array.from({length:17},(_,index)=>result(index))]);assert.equal(excess.success,false);assert.ok(excess.failureReasons.includes('CLAUDE_RESULT_COUNT'));assert.equal(excess.resultCount,16);assert.equal(excess.resultShapesTruncated,true);
});
test('native error events invalidate otherwise successful root receipts',()=>{
 for(const error of [{type:'error',error:{type:'api_error',message:'PRIVATE_ERROR'}},{type:'assistant',error:'api_error',message:{content:[]}},{type:'assistant',error:{type:'api_error'},message:{content:[]}},{type:'assistant',error:false,message:{content:[]}}]){
  const parsed=parse([init(),result(0),error,result(1)]);assert.equal(parsed.success,false);assert.ok((parsed.failureReasons as string[]).includes('CLAUDE_NATIVE_ERROR'));assert.ok(!JSON.stringify(parsed.failureReasons).includes('PRIVATE_ERROR'));
 }
 const auth=parse([init(),{type:'error',error:{type:'authentication_error'}},result(0)]);assert.equal(auth.errorCode,'NEEDS_REAUTH');assert.ok(auth.failureReasons.includes('AUTHENTICATION_REQUIRED'));assert.ok((auth.failureReasons as string[]).includes('CLAUDE_NATIVE_ERROR'));
});
test('ordinary tool errors and quoted error text remain valid non-native-error messages',()=>{
 const events=[init(),result(0),{type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_fixture',is_error:true,error:{type:'authentication_error'},content:'ordinary tool failure'},{type:'text',text:'{"type":"error","error":{"type":"api_error"}}'}]}},{type:'assistant',error:null,message:{content:[{type:'text',text:'Quoted authentication_error is documentation.'}]}},result(1)];
 const parsed=parse(events);assert.equal(parsed.success,true);assert.equal(parsed.errorCode,undefined);assert.deepEqual(parsed.failureReasons,[]);
});
