import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseClaudeQuota} from '../src/runtime/autonomous-quota.ts';
const session='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const now=1794275999000, reset=1794276000, end=now+10000;
// Synthetic rejection: no real blocked-event capture is available.
const synthetic=(status='rejected',resetsAt:unknown=reset,uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')=>({type:'rate_limit_event',uuid,session_id:session,rate_limit_info:{status,resetsAt}});
const wire=(...records:unknown[])=>records.map(x=>JSON.stringify(x)).join('\n');
const parse=(stdout:string)=>parseClaudeQuota(stdout,session,now,end);
test('synthetic rejected evidence converts epoch seconds to milliseconds without leaking fields',()=>{
 assert.deepEqual(parse(wire({...synthetic(),private:'PRIVATE_SYNTHETIC'})),{kind:'rejected',resetsAt:reset*1000,evidence:'claude_rate_limit_event'});
});
test('checked-in 2.1.319 allowed event cannot create a wait despite rejected overage',()=>{
 const receipt=JSON.parse(readFileSync(new URL('../../docs/phase0/cloudflare-claude-single-context-20261110.json',import.meta.url),'utf8'));
 const find=(value:unknown):any=>{if(!value||typeof value!=='object')return; if((value as any).type==='rate_limit_event')return value;for(const child of Object.values(value)){const event=find(child);if(event)return event;}};
 // Extract only the rate event; do not print or pass any other receipt records.
 const event=find(receipt);assert.equal(event.rate_limit_info.status,'allowed');assert.equal(event.rate_limit_info.overageStatus,'rejected');
 assert.equal(parseClaudeQuota(wire(event),event.session_id,now,end),undefined);
});
test('last valid top-level status clears or replaces earlier rejection',()=>{
 for(const status of ['allowed','allowed_warning'])assert.equal(parse(wire(synthetic(),synthetic(status,reset,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))),undefined);
 assert.ok(parse(wire(synthetic('allowed'),synthetic('rejected',reset,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))));
});
test('malformed JSONL, native errors, malformed quota and mixed sessions fail closed',()=>{
 const good=synthetic();
 for(const records of [[good,{type:'error'}],[good,{type:'assistant',error:'api_error'}],[good,{type:'result',is_error:true}],[good,{type:'system',session_id:other}],[good,{...synthetic(),session_id:other}],[good,{...synthetic(),uuid:'bad'}],[good,synthetic()],[{...good,parent_tool_use_id:'toolu_child'}],[{...good,session_id:undefined}],[{...good,rate_limit_info:{status:'blocked',resetsAt:reset}}],[{...good,rate_limit_info:{status:'allowed',resetsAt:'bad'}}],[good,[]],[good,null],[good,{}]])assert.equal(parse(wire(...records)),undefined);
 for(const text of ['', 'limit reached, try later',wire(good)+'\ninvalid',wire(good)+'\n\n{}',wire(good)+'\nnull'])assert.equal(parse(text),undefined);
 assert.ok(parse(wire(good)+'\r\n'));
});
test('timing is safe integer seconds strictly between now and deadline after conversion',()=>{
 for(const value of [undefined,null,'1794276000',reset+.5,0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER,reset*1000,reset-1])assert.equal(parse(wire({...synthetic(),rate_limit_info:{status:'rejected',resetsAt:value}})),undefined);
 for(const [clock,deadline] of [[NaN,end],[now,Infinity],[-1,end],[now+.1,end],[now,now],[now,reset*1000],[now,reset*1000-1],[Number.MAX_SAFE_INTEGER+1,end]])assert.equal(parseClaudeQuota(wire(synthetic()),session,clock!,deadline!),undefined);
 assert.equal(parseClaudeQuota(wire(synthetic()),'not-uuid',now,end),undefined);
 assert.equal(parseClaudeQuota(wire(synthetic()),session.toUpperCase().replace('1111','AAAA'),now,end),undefined);
});
test('only actual top-level quota records qualify, never nested strings or overage alone',()=>{
 for(const record of [{type:'assistant',message:wire(synthetic())},{type:'system',rate_limit_info:synthetic().rate_limit_info},synthetic('allowed'),{...synthetic(),rate_limit_info:{overageStatus:'rejected',resetsAt:reset}},{...synthetic(),rate_limit_info:{status:'allowed',overageStatus:'rejected',resetsAt:reset}}])assert.equal(parse(wire(record)),undefined);
});
test('raw byte and physical line limits apply to the entire stream',()=>{
 assert.equal(parse(wire(synthetic())+' '.repeat(4*1024*1024)),undefined);
 assert.equal(parse(wire(synthetic())+'한'.repeat(1500000)),undefined);
 assert.equal(parse(wire(synthetic(),...Array.from({length:5000},()=>({type:'system'})))),undefined);
 assert.ok(parse(wire(synthetic(),...Array.from({length:4999},()=>({type:'system'})))));
});
test('synthetic structured rate-limit assistant plus strict error result preserves quota evidence',()=>{
 const assistant={type:'assistant',error:'rate_limit',uuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',parent_tool_use_id:null,session_id:session,message:{role:'assistant',content:[]}};
 const result={type:'result',subtype:'error_during_execution',is_error:true,uuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',session_id:session,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,stop_reason:null,usage:{input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0},modelUsage:{},permission_denials:[],errors:['synthetic'],terminal_reason:'api_error'};
 assert.ok(parse(wire(synthetic(),assistant,result)));
 assert.equal(parse(wire(synthetic(),result)),undefined);
 assert.equal(parse(wire(synthetic(),{...assistant,error:'authentication_failed'},result)),undefined);
 for(const patch of [{usage:{}},{is_error:false},{terminal_reason:'completed'},{permission_denials:[{}]},{session_id:other}])assert.equal(parse(wire(synthetic(),assistant,{...result,...patch})),undefined);
});
