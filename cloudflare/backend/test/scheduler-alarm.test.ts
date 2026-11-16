import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureSchedulerAlarm} from '../src/cloudflare/scheduler-alarm.ts';

function storage(initial:number|null=null){
 return {pending:initial,writes:[] as number[],async getAlarm(){return this.pending;},
  async setAlarm(time:number){this.pending=time;this.writes.push(time);}};
}
test('frequent API polling cannot postpone dispatch, including an already due alarm',async()=>{
 const alarms=storage();
 await ensureSchedulerAlarm(alarms,0);
 for(let now=100;now<=30000;now+=100)await ensureSchedulerAlarm(alarms,now);
 assert.equal(alarms.pending,2000);
 assert.deepEqual(alarms.writes,[2000]);
});
test('completed alarm handler schedules its next tick and an earlier deadline wins',async()=>{
 const alarms=storage(2000);
 alarms.pending=null; // Storage exposes no pending alarm while its handler runs.
 await ensureSchedulerAlarm(alarms,2050);
 assert.equal(alarms.pending,4050);
 alarms.pending=10000;
 await ensureSchedulerAlarm(alarms,2100);
 assert.equal(alarms.pending,4100);
 await ensureSchedulerAlarm(alarms,2100);
 assert.deepEqual(alarms.writes,[4050,4100]);
});
