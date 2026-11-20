import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousEngine} from '../packages/core/src/autonomous.ts';
import type {AutonomousSpec,AutonomousRunResult} from '../packages/contracts/src/autonomous.ts';
const ms=Date.parse;
const start=ms('2026-11-20T00:00:00Z');
function fixture(time=start,schedule={kind:'daily' as const,timeZone:'UTC',localTime:'00:00'},endsAt=time+4*86400000){
 const e=new AutonomousEngine();
 const spec={requestId:'daily',goal:'test',provider:'mock',model:'mock',endsAt,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:30000,maxIterations:10,schedule} as AutonomousSpec;
 e.create(spec,time,'t');e.approve('t',1,'approved',time);return e;
}
const result:AutonomousRunResult={outcome:'continue',usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},costMicros:0};
test('approval future waits; equality claims once and restart retains approval/key',()=>{
 let e=fixture(start+1);assert.equal(e.get('t').status,'waiting');assert.equal(e.get('t').nextRunAt,start+86400000);
 assert.equal(e.claim('t','w','s','r',start+1000),null);
 e=new AutonomousEngine(e.snapshot());const l=e.claim('t','w','s','r',start+86400000)!;assert.ok(l);
 assert.equal((e.get('t') as any).lastScheduleKey,'2026-11-21');
 e.finish(l,result,start+86400001);e=new AutonomousEngine(e.snapshot());assert.equal(e.get('t').approvedAt,start+1);
 assert.equal(e.claim('t','w','s','r2',start+86400002),null);
});
test('continue after midnight schedules next local date',()=>{
 const e=fixture(start,{kind:'daily',timeZone:'UTC',localTime:'23:59'});
 const l=e.claim('t','w','s','r',start+86340000)!;e.finish(l,result,start+86340001);
 assert.equal(e.get('t').nextRunAt,start+172740000);
});
test('missed wake skips day without catchup',()=>{
 // A wake is missed only after the approved five-minute dispatch grace.
 const e=fixture(start+1);assert.equal(e.claim('t','w','s','r',start+86400000+300001),null);
 assert.equal(e.get('t').nextRunAt,start+2*86400000);
});
test('fold second instance never claims same local date',()=>{
 const first=ms('2026-11-01T05:30:00Z');let e=fixture(first,{kind:'daily',timeZone:'America/New_York',localTime:'01:30'});
 const l=e.claim('t','w','s','r',first)!;e.finish(l,result,first+1);e=new AutonomousEngine(e.snapshot());
 assert.equal(e.claim('t','w','s','r2',first+3600000),null);assert.equal(e.get('t').nextRunAt,ms('2026-11-02T06:30:00Z'));
});
test('cancel during wait and deadline before first wake prevent claims',()=>{
 const e=fixture(start+1);e.cancel('t','cancel',start+2);assert.equal(e.get('t').status,'cancelled');assert.equal(e.claim('t','w','s','r',start+86400000),null);
 const short=fixture(start+1,undefined,start+1000);assert.equal(short.get('t').status,'expired');assert.equal(short.get('t').nextRunAt,undefined);
});
test('explicit wait beyond daily target rounds forward to approved schedule',()=>{
 const e=fixture();const l=e.claim('t','w','s','r',start)!;
 e.finish(l,{...result,outcome:'wait',wakeAt:start+86400000+3600000},start+1);
 assert.equal(e.get('t').nextRunAt,start+2*86400000);
});
test('wait whose rounded schedule exceeds deadline expires',()=>{
 const e=fixture(start,undefined,start+86400000+7200000);const l=e.claim('t','w','s','r',start)!;
 e.finish(l,{...result,outcome:'wait',wakeAt:start+86400000+3600000},start+1);assert.equal(e.get('t').status,'expired');
});
test('restore rejects forged key and unknown fields; strict schedule rejects extra fields',()=>{
 const e=fixture();e.claim('t','w','s','r',start);
 for(const change of [(t:any)=>t.lastScheduleKey='2026-02-30',(t:any)=>t.lastScheduleKey='2026-11-21',(t:any)=>delete t.lastScheduleKey,(t:any)=>t.extra=1]){const s=e.snapshot();change(s.tasks.t);assert.throws(()=>new AutonomousEngine(s));}
 assert.throws(()=>fixture(start,{kind:'daily',timeZone:'UTC',localTime:'00:00',extra:1} as any));
});
test('unscheduled behavior stays immediate',()=>{
 const e=new AutonomousEngine();const spec={...fixture().get('t').spec};delete (spec as any).schedule;e.create(spec,start,'t');e.approve('t',1,'yes',start);const l=e.claim('t','w','s','r',start)!;e.finish(l,result,start+1);assert.equal(e.get('t').status,'ready');
});
test('finish crossing midnight does not consume the following date',()=>{
 const e=fixture(start,{kind:'daily',timeZone:'UTC',localTime:'23:59'});
 const state=e.snapshot();state.tasks.t!.spec.maxRunMs=120000;
 const restored=new AutonomousEngine(state),at=start+86340000;
 let l=restored.claim('t','w','s','r',at)!;
 l=restored.heartbeat(l,at+25000);l=restored.heartbeat(l,at+50000);
 restored.finish(l,result,start+86400001);
 assert.equal(restored.get('t').nextRunAt,start+172740000);
 assert.equal(new AutonomousEngine(restored.snapshot()).get('t').lastScheduleKey,'2026-11-20');
});
test('restored waiting time must be an approved schedule occurrence',()=>{
 const e=fixture(start+1),s=e.snapshot();s.tasks.t!.nextRunAt=start+86400000+1000;
 assert.throws(()=>new AutonomousEngine(s));
});
test('spring gap approval and finite deadline use existing schedule policy',()=>{
 const at=ms('2026-03-08T00:00:00Z'),e=fixture(at,{kind:'daily',timeZone:'America/New_York',localTime:'02:30'});
 assert.equal(e.get('t').nextRunAt,ms('2026-03-09T06:30:00Z'));
});
