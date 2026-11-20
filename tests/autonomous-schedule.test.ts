import test from 'node:test';
import assert from 'node:assert/strict';
import * as helper from '../packages/core/src/autonomous-schedule.js';
const daily=(timeZone:string,localTime:string)=>({kind:'daily' as const,timeZone,localTime});
const next=(s:ReturnType<typeof daily>,after:string,key?:string)=>helper.nextDailyOccurrence(s,Date.parse(after),key);
test('UTC equality and no catchup',()=>{
 assert.deepEqual(next(daily('UTC','09:00'),'2026-11-20T09:00:00Z'),{wakeAt:Date.parse('2026-11-20T09:00:00Z'),key:'2026-11-20'});
 assert.equal(next(daily('UTC','09:00'),'2026-11-20T09:00:00.001Z').wakeAt,Date.parse('2026-11-21T09:00:00Z'));
});
test('KST local date crosses UTC year boundary',()=>assert.deepEqual(next(daily('Asia/Seoul','00:15'),'2026-12-31T15:00:00Z'),{wakeAt:Date.parse('2026-12-31T15:15:00Z'),key:'2027-01-01'}));
test('New York spring gap skips day',()=>assert.deepEqual(next(daily('America/New_York','02:30'),'2026-03-08T00:00:00Z'),{wakeAt:Date.parse('2026-03-09T06:30:00Z'),key:'2026-03-09'}));
test('New York fold uses earliest instance only',()=>{
 const s=daily('America/New_York','01:30');
 assert.equal(next(s,'2026-11-01T00:00:00Z').wakeAt,Date.parse('2026-11-01T05:30:00Z'));
 assert.equal(next(s,'2026-11-01T05:30:00Z').wakeAt,Date.parse('2026-11-01T05:30:00Z'));
 assert.equal(next(s,'2026-11-01T05:30:00.001Z').wakeAt,Date.parse('2026-11-02T06:30:00Z'));
});
test('restart key prevents same local date including fold',()=>{
 assert.equal(next(daily('America/New_York','01:30'),'2026-11-01T05:00:00Z','2026-11-01').key,'2026-11-02');
 assert.equal(next(daily('UTC','00:00'),'2026-01-01T00:00:00Z','2026-02-28').key,'2026-03-01');
});
test('leap day and year rollover',()=>{
 assert.equal(next(daily('UTC','00:00'),'2028-02-28T12:00:00Z').key,'2028-02-29');
 assert.equal(next(daily('UTC','00:00'),'2026-12-31T12:00:00Z').key,'2027-01-01');
});
test('half hour fold and full skipped date',()=>{
 assert.equal(next(daily('Australia/Lord_Howe','01:45'),'2026-04-04T12:00:00Z').wakeAt,Date.parse('2026-04-04T14:45:00Z'));
 assert.equal(next(daily('Pacific/Apia','12:00'),'2011-12-30T00:00:00Z').key,'2011-12-31');
});
test('strict malformed schedules reject',()=>{
 for(const value of [null,[],{}, {...daily('UTC','00:00'),extra:1},daily('UTC','9:00'),daily('UTC','24:00'),daily('UTC','00:60'),daily('UTC','00:00:00'),daily(' UTC','00:00'),daily('+09:00','00:00'),daily('Not/AZone','00:00'),{...daily('UTC','00:00'),kind:'weekly'},daily('A'.repeat(129),'00:00')])assert.throws(()=>helper.nextDailyOccurrence(value as never,0));
});
test('bounded timestamps and real date keys reject',()=>{
 for(const value of [NaN,Infinity,-1,0.1,Number.MAX_SAFE_INTEGER,Date.parse('9999-01-01T00:00:00Z')])assert.throws(()=>helper.nextDailyOccurrence(daily('UTC','00:00'),value));
 for(const key of ['','2026-02-29','2026-04-31','2026-1-01','0000-01-01','2026-01-01x'])assert.throws(()=>helper.nextDailyOccurrence(daily('UTC','00:00'),0,key));
});
