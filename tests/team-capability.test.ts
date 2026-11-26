import assert from 'node:assert/strict';
import test from 'node:test';
import {createTeamCapabilityAuthority} from '../packages/core/src/team-capability.js';
const actor={teamId:'team',memberId:'member',jobId:'job',attempt:'attempt-uuid'};
test('opaque capability binds current execution, workflow, nonce and expiry',async()=>{
 let now=100;let active=true;
 const authority=createTeamCapabilityAuthority({signingKey:'k'.repeat(32),now:()=>now,authorizeCurrent:async()=>active});
 const token=await authority.issue({workflowId:'workflow',actor,expiresAt:200});
 assert.ok(!token.includes('member'));assert.deepEqual(await authority.verify(token,'workflow'),actor);
 await assert.rejects(authority.verify(token,'other'));
 await assert.rejects(authority.verify(token+'x','workflow'));
 active=false;await assert.rejects(authority.verify(token,'workflow'));active=true;
 authority.revoke(token);await assert.rejects(authority.verify(token,'workflow'));
 const next=await authority.issue({workflowId:'workflow',actor,expiresAt:200});assert.notEqual(next,token);
 now=200;await assert.rejects(authority.verify(next,'workflow'));
});
test('issuer refuses inactive execution and missing key',async()=>{
 assert.throws(()=>createTeamCapabilityAuthority({signingKey:'',authorizeCurrent:async()=>true}));
 const a=createTeamCapabilityAuthority({signingKey:'k'.repeat(32),authorizeCurrent:async()=>false});
 await assert.rejects(a.issue({workflowId:'workflow',actor,expiresAt:Date.now()+1000}));
});
test('verification rechecks current attempt and revocation after asynchronous check',async()=>{
 let unblock:()=>void=()=>{};let paused=false;let current='attempt-uuid';
 const a=createTeamCapabilityAuthority({signingKey:'s'.repeat(32),now:()=>10,authorizeCurrent:async b=>{if(paused)await new Promise<void>(resolve=>{unblock=resolve;});return b.actor.attempt===current;}});
 const token=await a.issue({workflowId:'workflow',actor,expiresAt:100});current='next-attempt';await assert.rejects(a.verify(token,'workflow'));current=actor.attempt;
 paused=true;const pending=a.verify(token,'workflow');a.revoke(token);unblock();await assert.rejects(pending);
});
test('held parallel issuance reserves at most 4096 slots',async()=>{
 let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});let checks=0;
 const authority=createTeamCapabilityAuthority({signingKey:'b'.repeat(32),now:()=>10,authorizeCurrent:async()=>{checks++;await held;return true;}});
 const pending=Array.from({length:4097},()=>authority.issue({workflowId:'workflow',actor,expiresAt:100}));
 const settled=Promise.allSettled(pending);release();const results=await settled;
 assert.equal(results.filter(r=>r.status==='fulfilled').length,4096);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(checks,4096);
 const token=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
 authority.revoke(token);assert.ok(await authority.issue({workflowId:'workflow',actor,expiresAt:100}));
});
test('failed and expired pending issuance releases reserved capacity',async()=>{
 let now=10;let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});let active=false;
 const authority=createTeamCapabilityAuthority({signingKey:'r'.repeat(32),now:()=>now,authorizeCurrent:async()=>{await held;return active;}});
 const first=authority.issue({workflowId:'workflow',actor,expiresAt:20});const failure=assert.rejects(first);now=20;release();await failure;
 active=true;assert.ok(await authority.issue({workflowId:'workflow',actor,expiresAt:100}));
});
