import assert from 'node:assert/strict';
import test from 'node:test';
import {handleTeamApi,createTeamService,type TeamService} from '../apps/control-plane/src/team-api.js';
import {TeamEngine} from '../packages/core/src/team.js';
import type {TeamState,TeamSpec,TeamLease} from '../packages/contracts/src/team.js';
import type {TeamRepository} from '../packages/core/src/team-store.js';
const base='http://local/v1/workflows/11111111-1111-4111-8111-111111111111/team';
const actor={teamId:'team',memberId:'member',jobId:'job',attempt:'attempt-uuid'};
let calls=0;
const service={summary:async()=>({id:'team'}),tasks:async()=>({tasks:[]}),events:async()=>({events:[],nextAfter:3}),notes:async()=>({notes:[]}),block:async()=>({status:'blocked'}),review:async()=>({status:'blocked'}),workerOperation:async(_id:string,a:unknown)=>{calls++;assert.deepEqual(a,actor);return {ok:true};}} as unknown as TeamService;
const options={operatorToken:'operator-secret',service,authorizeWorker:async()=>actor};
const req=(path='',body?:unknown,token='operator-secret')=>new Request(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('auth precedes malformed body and unconfigured worker is closed',async()=>{
 const r=new Request(base+'/claim',{method:'POST',body:'broken'});
 assert.equal((await handleTeamApi(r,{operatorToken:'operator-secret',service}))?.status,401);
 assert.equal((await handleTeamApi(new Request(base+'/block',{method:'POST',body:'broken'}),options))?.status,401);
});
test('worker identity cannot come from JSON',async()=>{
 calls=0;assert.equal((await handleTeamApi(req('/claim',{taskId:'task',memberId:'forged'},'cap'),options))?.status,400);assert.equal(calls,0);
 assert.equal((await handleTeamApi(req('/claim',{taskId:'task'},'cap'),options))?.status,200);assert.equal(calls,1);
});
test('strict queries and bounded pages',async()=>{
 for(const q of ['/tasks?limit=2','/events?limit=0','/events?limit=2&limit=3','/notes?unexpected=x','/events?after=-1'])assert.equal((await handleTeamApi(req(q),options))?.status,400);
 assert.deepEqual(await (await handleTeamApi(req('/events?after=1&limit=2'),options))!.json(),{events:[],nextAfter:3});
});
test('known raw and encoded secrets never reach mutations',async()=>{
 for(const text of ['operator-secret',Buffer.from('operator-secret').toString('base64'),'cap',encodeURIComponent('a/b secret')]){
  assert.equal((await handleTeamApi(req('/notes',{text},'cap'),{...options,forbiddenValues:['a/b secret']}))?.status,400);
 }
});
test('operator output strips private fields and suppresses known secret values',async()=>{
 const s={...service,summary:async()=>({id:'team',leases:[{token:'private'}],token:'private',nested:{generation:2},text:'operator-secret'})};
 const r=await handleTeamApi(req(),{...options,service:s as unknown as TeamService});assert.equal(r?.status,500);assert.ok(!(await r!.text()).includes('operator-secret'));
});
test('oversized input and public observe route rejected',async()=>{
 assert.equal((await handleTeamApi(req('/notes',{text:'x'.repeat(65537)},'cap'),options))?.status,413);
 assert.equal(await handleTeamApi(req('/observe',{},'cap'),options),undefined);
});
test('operator cannot mint worker identity and resolver failure hides details',async()=>{
 const opts={...options,authorizeWorker:async()=>{throw new Error('private resolver key');}};
 const r=await handleTeamApi(req('/claim',{taskId:'task'}),opts);assert.equal(r?.status,401);assert.ok(!(await r!.text()).includes('private resolver key'));
});
test('only authenticated worker lease responses expose lease tokens',async()=>{
 const lease={taskId:'task',memberId:'member',token:'private-lease',generation:1,expiresAt:900};
 const s={...service,workerOperation:async()=>lease};
 const r=await handleTeamApi(req('/claim',{taskId:'task'},'cap'),{...options,service:s});assert.deepEqual(await r!.json(),lease);
 const read=await handleTeamApi(req(),{...options,service:{...s,summary:async()=>({lease,token:lease.token,generation:1,generations:{task:1},id:'team'})} as unknown as TeamService});
 assert.deepEqual(await read!.json(),{id:'team'});
});
test('empty operator configuration cannot authenticate',async()=>{
 assert.equal((await handleTeamApi(req(),{...options,operatorToken:'',authorizeWorker:undefined}))?.status,401);
});
test('slow authenticated body times out before mutation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});
 const request=new Request(base+'/notes',{method:'POST',headers:{authorization:'Bearer cap'},body:stream,duplex:'half'} as RequestInit);
 const pending=handleTeamApi(request,options);await Promise.resolve();await Promise.resolve();t.mock.timers.tick(5001);
 assert.equal((await pending)?.status,408);assert.equal(cancelled,true);
});
test('oversized secret configuration fails before writes',async()=>{
 const previous=calls;const r=await handleTeamApi(req('/claim',{taskId:'task'},'cap'),{...options,forbiddenValues:Array.from({length:257},()=> 'known')});
 assert.equal(r?.status,503);assert.equal(calls,previous);
});

function fixture(){
 const workflowId='11111111-1111-4111-8111-111111111111';
 const spec:TeamSpec={id:'team',workflowId,contractHash:'a'.repeat(64),endsAt:100000,maxConcurrentClaims:2,members:[{id:'member',role:'worker',writes:['src/'],jobId:'job',attempt:'attempt-uuid'}],tasks:[{id:'task',title:'root',dependencies:[],writes:['src/a'],assignee:'member'}]};
 const engine=new TeamEngine();engine.create(spec,0);let state=engine.snapshot()!;
 const repository:TeamRepository={async read(key){assert.equal(key,workflowId);return structuredClone(state);},async mutate(key,fn){assert.equal(key,workflowId);const e=new TeamEngine(state);const result=fn(e);assert.ok(!(result instanceof Promise));state=e.snapshot()!;return result;}};
 return {workflowId,repository,service:createTeamService({repository,now:()=>10}),getState:()=>state,setState:(s:TeamState)=>{state=s;}};
}
test('service uses workflow repository key and distinct team engine identity',async()=>{
 const f=fixture();assert.equal((await f.service.summary(f.workflowId)).id,'team');
 const lease=await f.service.workerOperation(f.workflowId,actor,'claim',{taskId:'task'}) as TeamLease;assert.ok(lease.token);
 const summary=await f.service.summary(f.workflowId);assert.equal(summary.taskCounts.claimed,1);assert.ok(!JSON.stringify(summary).includes(lease.token));
 await assert.rejects(f.service.workerOperation(f.workflowId,{...actor,teamId:'forged'},'notes',{text:'note'}));
 await assert.rejects(f.service.workerOperation(f.workflowId,{...actor,attempt:'stale'},'notes',{text:'note'}));
});
test('service rejects repository workflow mismatch before reading or writing',async()=>{
 const f=fixture();const state=f.getState();state.spec.workflowId='22222222-2222-4222-8222-222222222222';f.setState(state);
 await assert.rejects(f.service.summary(f.workflowId));await assert.rejects(f.service.workerOperation(f.workflowId,actor,'claim',{taskId:'task'}));
});
test('service cursors retain all notes with default bounded pages',async()=>{
 const f=fixture();for(let i=0;i<101;i++)await f.service.workerOperation(f.workflowId,actor,'notes',{text:'note '+i});
 const first=await f.service.notes(f.workflowId);assert.equal(first.notes.length,100);assert.equal(first.nextAfter,first.notes.at(-1)!.sequence);
 const next=await f.service.notes(f.workflowId,{after:first.nextAfter});assert.equal(next.notes.length,1);assert.equal(next.nextAfter,undefined);
});
test('HTTP real engine claim and operator block keep leases private and block terminal',async()=>{
 const f=fixture();const opts={...options,service:f.service};
 const response=await handleTeamApi(req('/claim',{taskId:'task'},'cap'),opts);assert.equal(response?.status,200);const lease=await response!.json() as TeamLease;
 const read=await handleTeamApi(req('/tasks'),opts);assert.ok(!(await read!.text()).includes(lease.token));
 const blocked=await handleTeamApi(req('/block',{category:'credential_scope',reason:'scope mismatch',evidenceRef:'finding'}),opts);assert.equal(blocked?.status,200);assert.equal((await blocked!.json() as {blocked:boolean}).blocked,true);
 const reviewed=await handleTeamApi(req('/review',{reason:'investigated'}),opts);assert.equal(reviewed?.status,200);assert.equal((await reviewed!.json() as {blocked:boolean}).blocked,true);
 const late=await handleTeamApi(req('/submit',{lease,outcome:'candidate',evidenceRef:'proof'},'cap'),opts);assert.notEqual(late?.status,200);
});
test('real claim conflict is 409 while storage errors remain 500',async()=>{
 const f=fixture();const opts={...options,service:f.service};
 assert.equal((await handleTeamApi(req('/claim',{taskId:'task'},'cap'),opts))?.status,200);
 assert.equal((await handleTeamApi(req('/claim',{taskId:'task'},'cap'),opts))?.status,409);
 const storage:TeamRepository={read:f.repository.read,async mutate(){throw Object.assign(new Error('claim rejected'),{statusCode:409,name:'TeamError'});}};
 const r=await handleTeamApi(req('/claim',{taskId:'task'},'cap'),{...options,service:createTeamService({repository:storage,now:()=>10})});
 assert.equal(r?.status,500);assert.ok(!(await r!.text()).includes('claim rejected'));
});
test('private capability reads shared task pool and notes with safe pages',async()=>{
 const f=fixture();await f.service.workerOperation(f.workflowId,actor,'notes',{text:'shared update'});
 const lease=await f.service.workerOperation(f.workflowId,actor,'claim',{taskId:'task'}) as TeamLease;
 const opts={...options,service:f.service};
 for(const section of ['', '/tasks','/events?limit=1','/notes']){
  const r=await handleTeamApi(req(section,undefined,'cap'),opts);assert.equal(r?.status,200);
  const raw=await r!.text();assert.ok(!raw.includes(lease.token));assert.ok(!raw.includes('generation'));
  if(section==='/tasks')assert.equal((JSON.parse(raw) as {tasks:unknown[]}).tasks.length,1);
  if(section==='/notes')assert.equal((JSON.parse(raw) as {notes:{text:string}[]}).notes[0]?.text,'shared update');
 }
});
test('worker reads reject foreign stopped expired and stale binding',async()=>{
 for(const kind of ['foreign','stopped','expired','stale'] as const){
  const f=fixture();const state=f.getState();if(kind==='stopped')state.spec.members[0]!.stopped=true;if(kind==='expired')state.spec.endsAt=5;f.setState(state);
  const a=kind==='foreign'?{...actor,teamId:'other'}:kind==='stale'?{...actor,attempt:'other'}:actor;
  const r=await handleTeamApi(req('/tasks',undefined,'cap'),{...options,service:f.service,authorizeWorker:async()=>a});
  assert.equal(r!.status,409,kind);
  await assert.rejects(f.service.workerRead(f.workflowId,a,'tasks'));
 }
});
test('capability never falls back to operator block or review',async()=>{
 const f=fixture();let authorizations=0;
 const opts={...options,service:f.service,authorizeWorker:async()=>{authorizations++;return actor;}};
 for(const [path,input] of [['/block',{category:'credential_scope',reason:'scope mismatch',evidenceRef:'finding'}],['/review',{reason:'review'}]] as const)assert.equal((await handleTeamApi(req(path,input,'cap'),opts))?.status,401);
 assert.equal(authorizations,0);assert.equal((await f.service.summary(f.workflowId)).blocked,false);
});
test('only block and review request repository recovery budget',async()=>{
 const f=fixture();const modes:boolean[]=[];
 const repository:TeamRepository={read:f.repository.read,async mutate<T>(w:string,fn:(engine:TeamEngine)=>T,options?:{recovery?:boolean}){modes.push(options?.recovery??false);return f.repository.mutate(w,fn);}};
 const service=createTeamService({repository,now:()=>10});
 await service.summary(f.workflowId);await service.tasks(f.workflowId);await service.events(f.workflowId);await service.notes(f.workflowId);await service.workerRead(f.workflowId,actor,'tasks');assert.deepEqual(modes,[]);
 await service.workerOperation(f.workflowId,actor,'notes',{text:'normal note'});
 await service.workerOperation(f.workflowId,actor,'claim',{taskId:'task'});
 await service.block(f.workflowId,{category:'credential_scope',reason:'scope mismatch',evidenceRef:'finding'});
 await service.review(f.workflowId,{reason:'investigated'});
 assert.deepEqual(modes,[false,false,true,true]);
});
