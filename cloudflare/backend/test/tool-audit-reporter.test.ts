import test from 'node:test';
import assert from 'node:assert/strict';
import {shipToolAudit,ToolAuditSequenceError} from '../src/runtime/tool-audit-reporter.ts';
const lease={taskId:'t1',runId:'r1',workerId:'w',token:'lease-token',expiresAt:9e12};
const rec=(n:number)=>({sequence:n,tool:'Bash',inputDigest:'a'.repeat(64),inputSummary:'ls',inputTruncated:false,outcome:'allowed' as const,startedAt:1,durationMs:1});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
function fake(reply:(n:number)=>Response=()=>json({recorded:true,nextSequence:2})){
 const calls:{url:string;init:any}[]=[];
 return {calls,fetchImpl:(async(url:any,init:any)=>{calls.push({url:String(url),init});return reply(calls.length);}) as typeof fetch};
}
const base=(f:ReturnType<typeof fake>,over:object={})=>({lease,url:'https://api.example.com',token:'rep-token',records:[rec(1)],droppedByWorker:0,fetchImpl:f.fetchImpl,signal:new AbortController().signal,...over});
test('posts to the task path with bearer token, lease and records',async()=>{
 const f=fake();assert.deepEqual(await shipToolAudit(base(f)),{shipped:1});
 assert.equal(f.calls[0]!.url,'https://api.example.com/v1/autonomous-tasks/t1/tool-calls');
 assert.equal(f.calls[0]!.init.headers.authorization,'Bearer rep-token');assert.equal(f.calls[0]!.init.redirect,'error');
 const body=JSON.parse(f.calls[0]!.init.body);assert.equal(body.lease.runId,'r1');assert.equal(body.records.length,1);
});
test('splits into batches of 32 and sends dropped count once',async()=>{
 const f=fake();const records=Array.from({length:70},(_,i)=>rec(i+1));
 assert.deepEqual(await shipToolAudit(base(f,{records,droppedByWorker:4})),{shipped:70});
 assert.deepEqual(f.calls.map(c=>[JSON.parse(c.init.body).records.length,JSON.parse(c.init.body).droppedByWorker]),[[32,4],[32,0],[6,0]]);
});
test('drops-only report sends one empty batch; nothing to send makes no call',async()=>{
 const f=fake();await shipToolAudit(base(f,{records:[],droppedByWorker:2}));assert.equal(f.calls.length,1);
 const g=fake();assert.deepEqual(await shipToolAudit(base(g,{records:[]})),{shipped:0});assert.equal(g.calls.length,0);
});
test('409 surfaces expectedSequence; other failures are generic and do not leak the token',async()=>{
 await assert.rejects(shipToolAudit(base(fake(()=>json({expectedSequence:5},409)))),(e:any)=>e instanceof ToolAuditSequenceError&&e.expectedSequence===5);
 for(const reply of [()=>json({},401),()=>json({recorded:false}),()=>new Response('x'.repeat(5000))])
  await assert.rejects(shipToolAudit(base(fake(reply))),(e:any)=>e.message==='Tool audit report refused or failed'&&!e.message.includes('rep-token'));
 await assert.rejects(shipToolAudit(base(fake(),{fetchImpl:(async()=>{throw Error('net rep-token');}) as typeof fetch})),/refused or failed/);
});
test('rejects unsafe configuration and aborted signal without fetching',async()=>{
 for(const over of [{url:'http://evil.example.com'},{url:'https://u:p@a.example.com'},{token:'a b'},{token:''},{lease:{...lease,taskId:'../x'}},{signal:AbortSignal.abort()}]){
  const f=fake();await assert.rejects(shipToolAudit(base(f,over)));assert.equal(f.calls.length,0);
 }
});
