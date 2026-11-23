import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createSnapshot,sha256} from '../src/snapshot.ts';
import {validateWorkflowSpec} from '../src/workflow.ts';
registerHooks({resolve(s,c,next){if(s==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};if(s.startsWith('.')&&s.endsWith('.js')){try{return next(s.slice(0,-3)+'.ts',c);}catch{}}return next(s,c);}});
const source=createSnapshot([{path:'contract.md',content:Buffer.from('contract').toString('base64'),sha256:sha256('contract'),executable:false}]);
const operatorToken='team-operator-control-fixture';
const check={id:'test',argv:['node','verify.mjs'],timeoutMs:10000};
const spec=()=>validateWorkflowSpec({snapshotId:source.digest,contractPath:'contract.md',contractHash:sha256('contract'),idempotencyKey:'team-fixture',integration:check,workers:[{provider:'codex',credentialId:'codex',instructions:'Implement a',writes:['a.ts'],checks:[check],timeoutMs:60000},{provider:'claude',credentialId:'claude',instructions:'Implement b',writes:['b.ts'],checks:[check],timeoutMs:60000}]});
async function fixture(enabled?:string){
 const rows=new Map<string,unknown>();let fail=false;let alarm:number|null=null;let depth=0;const snapshots=new Map([[source.digest,source]]);
 const storage={async get<T>(k:string){return structuredClone(rows.get(k)) as T|undefined;},async put(k:string,v:unknown){if(fail)throw Error('disk unavailable');rows.set(k,structuredClone(v));},async delete(k:string){return rows.delete(k);},async getAlarm(){return alarm;},async setAlarm(v:number){alarm=v;},async transaction<T>(fn:(tx:any)=>Promise<T>){const before=structuredClone(rows);try{return await fn(storage);}catch(e){rows.clear();for(const [k,v]of before)rows.set(k,v);throw e;}}};
 const {SchedulerDO,default:worker}=await import('../src/cloudflare/worker.ts');let actor:any;
 const env={TEAM_COORDINATION_ENABLED:enabled,CONTROL_TOKEN:operatorToken,CODEX_SANDBOX_APPROVED:'true',CLAUDE_NESTED_APPROVED:'true',ARTIFACTS:{get:async(key:string)=>{const snapshot=snapshots.get(key.replace('snapshots/','').replace('.json',''));return snapshot?{json:async()=>snapshot}:null;},put:async(key:string,value:string)=>{if(key.startsWith('snapshots/')){const snapshot=JSON.parse(value);snapshots.set(snapshot.digest,snapshot);}return {etag:'fixture'};}},SCHEDULER:{getByName:()=>({fetch:(r:Request)=>actor.fetch(r)})},RUNNER:{getByName:()=>assert.fail('No actual model invocation')}};
 async function restart(){const pending:Promise<unknown>[]=[];actor=new SchedulerDO({storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){depth++;const p=fn().finally(()=>depth--);pending.push(p);return p;}} as never,env as never);await Promise.all(pending);return actor;}
 await restart();
 for(const provider of ['codex','claude'])actor.scheduler.registerCredential({id:provider,provider,generation:0,objectKey:'fixture',quarantined:false});
 const draft=await actor.createWorkflow(spec());await actor.save();
 return {rows,storage,env,restart,snapshots,get lockDepth(){return depth;},id:draft.id,get actor(){return actor;},failWrites(v:boolean){fail=v;},call:(path:string,method='GET',body?:unknown,token=operatorToken)=>worker.fetch(new Request('https://control.example/v1/workflows/'+draft.id+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env as never)};
}
test('team flag defaults off and exact team routes fail closed',async()=>{
 const f=await fixture();await f.actor.approveWorkflow(f.id);
 assert.equal(f.actor.scheduler.state.workflows[f.id].team,undefined);
 assert.equal((await f.call('/team')).status,404);
});
test('public workflow projections never expose private team records',async()=>{
 const f=await fixture();
 f.actor.scheduler.state.workflows[f.id].team={privateSentinel:'secret-lease'};
 for(const output of [await f.actor.createWorkflow(spec()),await f.actor.workflow(f.id,false)])assert.doesNotMatch(JSON.stringify(output),/secret-lease|privateSentinel/);
});
test('workflow approval publishes only after the durable snapshot commits',async()=>{
 const f=await fixture();const before=structuredClone(f.actor.scheduler.state);f.failWrites(true);
 await assert.rejects(()=>f.actor.approveWorkflow(f.id));
 assert.deepEqual(f.actor.scheduler.state,before);
});
test('enabled approval creates a private two-root verifier DAG in the same snapshot',async()=>{
 const f=await fixture('true');const response=await f.call('/approve','POST');assert.equal(response.status,202);
 const publicValue=await response.json() as any;assert.equal(publicValue.team,undefined);assert.equal(publicValue.teamSummary.status,'active');
 const team=f.actor.scheduler.state.workflows[f.id].team;
 assert.equal(team.spec.members.length,3);assert.equal(team.tasks.length,3);
 assert.equal(team.tasks[2].dependencies.length,2);
 await f.restart();assert.deepEqual(f.actor.scheduler.state.workflows[f.id].team,team);
});
async function activate(f:Awaited<ReturnType<typeof fixture>>){
 await f.actor.approveWorkflow(f.id);f.actor.scheduler.dispatch(Date.now());await f.actor.save();
 const workflow=f.actor.scheduler.state.workflows[f.id],job=f.actor.scheduler.get(workflow.workerIds[0]);
 const binding={workflowId:f.id,actor:{teamId:f.id,memberId:'worker-0',jobId:job.id,attempt:job.attempt},expiresAt:Math.min(job.deadline,Date.now()+20000)};
 const capability=await f.actor.issueTeamCapability(binding);return {workflow,job,binding,capability};
}
const block={category:'sandbox_escape',reason:'Trusted isolation finding',evidenceRef:'finding-1'};
test('scoped worker capability reaches exact routed HTTP handler and forged identity is rejected',async()=>{
 const f=await fixture('true'),a=await activate(f);
 const claim=await f.call('/team/claim','POST',{taskId:'root-0'},a.capability);assert.equal(claim.status,200);
 const lease=await claim.json() as any;assert.equal(typeof lease.token,'string');
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-1'},a.capability)).status,409);
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0',memberId:'worker-1'},a.capability)).status,400);
 assert.equal((await f.call('/team/block','POST',block,a.capability)).status,401);
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},operatorToken)).status,401);
 const tasks=await (await f.call('/team/tasks')).text();assert.doesNotMatch(tasks,new RegExp(lease.token));assert.doesNotMatch(tasks,/"leases"|"token"|"generation"/);
 const forged={...a.binding,actor:{...a.binding.actor,attempt:crypto.randomUUID()}};await assert.rejects(()=>f.actor.issueTeamCapability(forged));
 assert.equal((await f.call('/team/issue','POST',{},a.capability)).status,401);
});
test('worker candidate cannot verify roots or satisfy verifier dependencies',async()=>{
 const f=await fixture('true'),a=await activate(f);
 const lease=await (await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).json();
 assert.equal((await f.call('/team/submit','POST',{lease,evidenceRef:'candidate-1',outcome:'candidate'},a.capability)).status,200);
 const state=f.actor.scheduler.state.workflows[f.id].team;
 assert.equal(state.tasks[0].status,'submitted');assert.equal(state.tasks[2].status,'pending');
 assert.equal(state.events.some((e:any)=>e.type==='observed_verified'),false);
});
test('team block atomically stops dispatch, retains credentials, and review cannot restart',async()=>{
 const f=await fixture('true'),a=await activate(f);const credential=a.job.credentialId;
 const response=await f.call('/team/block','POST',block);assert.equal(response.status,200);
 const workflow=f.actor.scheduler.state.workflows[f.id];assert.equal(workflow.status,'FAILED');assert.equal(workflow.errorCode,'TEAM_SAFETY_BLOCKED');
 assert.equal(f.actor.scheduler.get(a.job.id).status,'CANCELLING');assert.equal(f.actor.scheduler.state.credentials[credential].activeJobId,a.job.id);
 assert.deepEqual(f.actor.scheduler.dispatch(Date.now()),[]);
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,401);
 assert.equal((await f.call('/team/review','POST',{reason:'Human reviewed the finding'})).status,200);
 assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
 assert.equal((await f.call('/approve','POST')).status,202);assert.equal(f.actor.scheduler.state.workflows[f.id].status,'FAILED');
 await f.restart();assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
 assert.equal(f.actor.scheduler.state.credentials[credential].activeJobId,a.job.id);
});
test('failed team block persistence does not publish cancellation or a partial ledger',async()=>{
 const f=await fixture('true');await activate(f);const before=structuredClone(f.actor.scheduler.state);f.failWrites(true);
 const response=await f.call('/team/block','POST',block);assert.equal(response.status,500);assert.deepEqual(f.actor.scheduler.state,before);
});
test('capabilities are invalid after restart and stopped or cancelled job attempts cannot reissue',async()=>{
 const f=await fixture('true'),a=await activate(f);await f.restart();
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,401);
 const reissued=await f.actor.issueTeamCapability(a.binding);assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},reissued)).status,200);
 f.actor.scheduler.requestCancel(a.job.id,Date.now());await f.actor.save();await assert.rejects(()=>f.actor.issueTeamCapability(a.binding));
});
test('unchanged trusted observations do not consume the bounded event ledger',async()=>{
 const f=await fixture('true');await activate(f);const before=f.actor.scheduler.state.workflows[f.id].team.sequence;
 await f.actor.save();await f.actor.save();assert.equal(f.actor.scheduler.state.workflows[f.id].team.sequence,before);
});
test('late successful callback only cleans up auth after team block and cannot enqueue checks',async()=>{
 const f=await fixture('true'),a=await activate(f);await f.call('/team/block','POST',block);
 f.actor.scheduler.agentFinished(a.job.id,a.job.attempt,{success:true,outputSnapshotId:source.digest,authGeneration:1,authObjectKey:'returned-auth',containerStopped:true,resultKey:'actual-result'},Date.now());await f.actor.save();
 assert.equal(f.actor.scheduler.get(a.job.id).status,'CANCELLED');assert.equal(f.actor.scheduler.get(a.job.id).authSynced,true);
 assert.equal(f.actor.scheduler.state.credentials[a.job.credentialId].activeJobId,undefined);
 assert.equal(f.actor.scheduler.list().filter((j:any)=>j.kind==='compute').length,0);
 assert.equal(f.actor.scheduler.state.workflows[f.id].status,'FAILED');assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
});
test('provider I/O releases the scheduler lock so block persists before a late launch',async()=>{
 const f=await fixture('true');await f.actor.approveWorkflow(f.id);
 let release!:()=>void,entered!:()=>void,cancels=0,launches=0;
 const waiting=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
 (f.env as any).RUNNER={getByName:()=>({ensure:async()=>{assert.equal(f.lockDepth,0);entered();await resume;return {ready:true,prepared:true};},cancel:async()=>{assert.equal(f.lockDepth,0);cancels++;},launch:async()=>{launches++;},poll:async()=>JSON.stringify({lost:false})})};
 const pending=f.actor.alarm();await waiting;
 assert.equal((await f.call('/team/block','POST',block)).status,200);assert.equal(f.actor.scheduler.state.workflows[f.id].status,'FAILED');
 release();await pending;assert.ok(cancels>=2);assert.equal(launches,0);
});
async function finishWorkers(f:Awaited<ReturnType<typeof fixture>>,outsideScope=false){
 const workflow=f.actor.scheduler.state.workflows[f.id];
 for(const [i,id]of workflow.workerIds.entries()){
  const output=createSnapshot([...source.files,{path:i===0?(outsideScope?'outside.ts':'a.ts'):'b.ts',content:Buffer.from('result').toString('base64'),sha256:sha256('result'),executable:false}]);f.snapshots.set(output.digest,output);
  const job=f.actor.scheduler.get(id);
  f.actor.scheduler.agentFinished(id,job.attempt,{success:true,outputSnapshotId:output.digest,authGeneration:1,authObjectKey:'auth-'+i,containerStopped:true,resultKey:`results/${job.id}/${job.attempt}.json`},Date.now());
 }
 f.actor.scheduler.dispatch(Date.now());
 for(const job of f.actor.scheduler.list().filter((j:any)=>j.kind==='compute'))f.actor.scheduler.computeFinished(job.id,job.attempt,{success:true,containerStopped:true,sourceUnchanged:true,resultKey:`results/${job.id}/${job.attempt}.json`},Date.now());
 await f.actor.save();
}
test('only actual independent scheduler success verifies both roots and then the integration DAG',async()=>{
 const f=await fixture('true');await activate(f);await finishWorkers(f);await f.restart();
 const {advanceWorkflow}=await import('../src/workflow.ts');let workflow=f.actor.scheduler.state.workflows[f.id];
 assert.deepEqual(workflow.team.tasks.map((t:any)=>t.status),['submitted','submitted','pending']);
 await advanceWorkflow(workflow,f.actor.scheduler,{read:async id=>f.snapshots.get(id)!,write:async s=>{f.snapshots.set(s.digest,s);}},Date.now());await f.actor.save();
 await f.restart();workflow=f.actor.scheduler.state.workflows[f.id];assert.equal(workflow.status,'INTEGRATING');
 const integration=f.actor.scheduler.dispatch(Date.now()).find((j:any)=>j.id===workflow.integrationId);assert.ok(integration);
 f.actor.scheduler.computeFinished(integration.id,integration.attempt,{success:true,containerStopped:true,sourceUnchanged:true,resultKey:`results/${integration.id}/${integration.attempt}.json`},Date.now());
 await f.actor.save();workflow=f.actor.scheduler.state.workflows[f.id];
 await advanceWorkflow(workflow,f.actor.scheduler,{read:async id=>f.snapshots.get(id)!,write:async()=>{}},Date.now());await f.actor.save();
 await f.restart();assert.equal(f.actor.scheduler.state.workflows[f.id].status,'SUCCEEDED');
 const team=f.actor.scheduler.state.workflows[f.id].team;assert.equal(team.status,'completed');
 assert.ok(team.tasks.every((t:any)=>/^result:[a-f0-9]{64}$/.test(t.evidenceRef)));assert.doesNotMatch(JSON.stringify(team),/results\//);
 const sequence=team.sequence;await f.actor.save();assert.equal(f.actor.scheduler.state.workflows[f.id].team.sequence,sequence);
});
test('ordinary scheduler failure fails the team without a security block',async()=>{
 const f=await fixture('true'),a=await activate(f);
 f.actor.scheduler.agentFinished(a.job.id,a.job.attempt,{success:false,authGeneration:1,authObjectKey:'auth-failed',containerStopped:true,resultKey:'failure'},Date.now());await f.actor.save();
 assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'failed');assert.equal(f.actor.scheduler.state.workflows[f.id].team.block,undefined);
});
test('blocking a queued team cancels both roots before any dispatch',async()=>{
 const f=await fixture('true');await f.actor.approveWorkflow(f.id);
 assert.equal((await f.call('/team/block','POST',block)).status,200);
 assert.deepEqual(f.actor.scheduler.dispatch(Date.now()),[]);
 assert.ok(f.actor.scheduler.state.workflows[f.id].workerIds.every((id:string)=>f.actor.scheduler.get(id).status==='CANCELLED'));
});
test('team block cancels detached checkpoint checks and integration jobs through the scheduler',async()=>{
 const f=await fixture('true'),a=await activate(f);
 const child=f.actor.scheduler.enqueueCompute(source.digest,check,Date.now()),integration=f.actor.scheduler.enqueueCompute(source.digest,check,Date.now());
 const root=f.actor.scheduler.state.jobs[a.job.id];root.checkpoint={round:1,sessionId:crypto.randomUUID(),snapshotId:source.digest,checkIds:[child.id]};
 f.actor.scheduler.state.workflows[f.id].integrationId=integration.id;
 assert.equal((await f.call('/team/block','POST',block)).status,200);
 assert.equal(f.actor.scheduler.get(child.id).status,'CANCELLED');assert.equal(f.actor.scheduler.get(integration.id).status,'CANCELLED');
});
test('a failed workflow records team failure through trusted fail even after successful roots',async()=>{
 const f=await fixture('true');await activate(f);await finishWorkers(f);
 const workflow=f.actor.scheduler.state.workflows[f.id];Object.assign(workflow,{status:'FAILED',errorCode:'MERGE_SCOPE_INVALID'});await f.actor.save();
 assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'failed');assert.equal(f.actor.scheduler.state.workflows[f.id].team.block,undefined);
});
function holdNextSave(f:Awaited<ReturnType<typeof fixture>>){
 let release!:()=>void,entered!:()=>void,first=true;
 const waiting=new Promise<void>(resolve=>{entered=resolve;}),pause=new Promise<void>(resolve=>{release=resolve;});
 const original=f.actor.schedulerStorage.save.bind(f.actor.schedulerStorage);
 f.actor.schedulerStorage.save=async(...args:unknown[])=>{if(first){first=false;entered();await pause;}return original(...args);};
 return {waiting,release:()=>release()};
}
test('parallel authenticated claims serialize clone-save-publish and have one winner',async()=>{
 const f=await fixture('true'),a=await activate(f),second=await f.actor.issueTeamCapability(a.binding),held=holdNextSave(f);
 const first=f.call('/team/claim','POST',{taskId:'root-0'},a.capability);await held.waiting;
 const other=f.call('/team/claim','POST',{taskId:'root-0'},second);held.release();
 const responses=await Promise.all([first,other]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal(f.actor.scheduler.state.workflows[f.id].team.leases.length,1);
});
test('parallel note and block preserve the committed note and monotonic safety block',async()=>{
 const f=await fixture('true'),a=await activate(f),held=holdNextSave(f);
 const note=f.call('/team/notes','POST',{text:'Bounded worker finding'},a.capability);await held.waiting;
 const blocking=f.call('/team/block','POST',block);held.release();
 assert.deepEqual((await Promise.all([note,blocking])).map(r=>r.status),[200,200]);
 const state=f.actor.scheduler.state.workflows[f.id];assert.equal(state.team.status,'blocked');assert.equal(state.status,'FAILED');assert.equal(state.team.notes[0].text,'Bounded worker finding');
 await f.restart();assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
});
test('failed persistence does not poison the mutation queue and rejected thenables are contained',async()=>{
 const f=await fixture('true');await activate(f);f.failWrites(true);assert.equal((await f.call('/team/block','POST',block)).status,500);
 f.failWrites(false);assert.equal((await f.call('/team/block','POST',block)).status,200);
 await assert.rejects(()=>f.actor.teamRepository().mutate(f.id,()=>Promise.reject(Error('rejected async callback'))));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await f.call('/team/review','POST',{reason:'Review after recovered storage'})).status,200);
 const copy=await f.actor.teamRepository().read(f.id);copy.status='active';assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
});
test('scope-violating successful outputs never verify roots or release integration dependencies',async()=>{
 const f=await fixture('true');await activate(f);await finishWorkers(f,true);
 const {advanceWorkflow}=await import('../src/workflow.ts'),workflow=f.actor.scheduler.state.workflows[f.id];
 await advanceWorkflow(workflow,f.actor.scheduler,{read:async id=>f.snapshots.get(id)!,write:async()=>assert.fail('Invalid merge must not publish')},Date.now());await f.actor.save();
 const current=f.actor.scheduler.state.workflows[f.id];assert.equal(current.status,'FAILED');assert.equal(current.errorCode,'MERGE_SCOPE_INVALID');assert.equal(current.team.status,'failed');assert.equal(current.integrationId,undefined);
 assert.ok(current.team.tasks.every((t:any)=>t.status!=='verified'));assert.ok(current.team.events.every((e:any)=>e.type!=='observed_verified'));
});
test('task-specific gateway facts verify roots without auto-verifying dynamic work assigned to the same member',async()=>{
 const f=await fixture('true'),a=await activate(f);
 const added=await f.call('/team/tasks','POST',{id:'dynamic-child',title:'Additional bounded work',dependencies:[],writes:['a.ts'],assignee:'worker-0'},a.capability);assert.equal(added.status,200);
 const lease=await (await f.call('/team/claim','POST',{taskId:'dynamic-child'},a.capability)).json();
 assert.equal((await f.call('/team/submit','POST',{lease,evidenceRef:'child-candidate',outcome:'candidate'},a.capability)).status,200);
 await finishWorkers(f);
 const {advanceWorkflow}=await import('../src/workflow.ts'),workflow=f.actor.scheduler.state.workflows[f.id];
 await advanceWorkflow(workflow,f.actor.scheduler,{read:async id=>f.snapshots.get(id)!,write:async s=>{f.snapshots.set(s.digest,s);}},Date.now());await f.actor.save();
 const state=f.actor.scheduler.state.workflows[f.id].team;
 assert.equal(state.tasks.find((t:any)=>t.id==='root-0').status,'verified');
 assert.equal(state.tasks.find((t:any)=>t.id==='root-0').verification.taskId,'root-0');
 assert.equal(state.tasks.find((t:any)=>t.id==='dynamic-child').status,'submitted');
 assert.equal(state.tasks.find((t:any)=>t.id==='dynamic-child').verification,undefined);
});
test('lost commit acknowledgement reloads the durable block before another claim can overwrite it',async()=>{
 const f=await fixture('true'),a=await activate(f),original=f.actor.schedulerStorage.save.bind(f.actor.schedulerStorage);let once=true;
 f.actor.schedulerStorage.save=async(...args:unknown[])=>{await original(...args);if(once){once=false;throw Error('commit acknowledgement lost');}};
 assert.equal((await f.call('/team/block','POST',block)).status,500);
 const summary=await (await f.call('/team')).json() as any;assert.equal(summary.status,'blocked');
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,401);
 assert.equal(f.actor.scheduler.state.workflows[f.id].status,'FAILED');
 await f.restart();assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
});
test('uncertain commit plus failed reload fences admissions and dispatch until durable recovery',async()=>{
 const f=await fixture('true'),a=await activate(f),originalSave=f.actor.schedulerStorage.save.bind(f.actor.schedulerStorage),originalLoad=f.actor.schedulerStorage.load.bind(f.actor.schedulerStorage);let once=true,unavailable=true,writes=0;
 f.actor.schedulerStorage.save=async(...args:unknown[])=>{writes++;await originalSave(...args);if(once){once=false;throw Error('commit acknowledgement lost');}};
 f.actor.schedulerStorage.load=async()=>{if(unavailable)throw Error('durable read unavailable');return originalLoad();};
 assert.equal((await f.call('/team/block','POST',block)).status,500);const savedWrites=writes;
 const read=await f.call('/team');assert.ok(read.status>=500);
 assert.notEqual((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,200);
 await assert.rejects(()=>f.actor.issueTeamCapability(a.binding));
 await assert.rejects(()=>f.actor.alarm());assert.equal(writes,savedWrites);
 unavailable=false;const recovered=await f.call('/team');assert.equal(recovered.status,200);assert.equal((await recovered.json() as any).status,'blocked');
 assert.deepEqual(f.actor.scheduler.dispatch(Date.now()),[]);
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,401);
 await f.restart();assert.equal(f.actor.scheduler.state.workflows[f.id].team.status,'blocked');
});
test('recovery after a precommit failure restores active state without inventing a block',async()=>{
 const f=await fixture('true'),a=await activate(f),originalLoad=f.actor.schedulerStorage.load.bind(f.actor.schedulerStorage);let unavailable=true;
 f.actor.schedulerStorage.load=async()=>{if(unavailable)throw Error('durable read unavailable');return originalLoad();};
 f.failWrites(true);assert.equal((await f.call('/team/block','POST',block)).status,500);
 f.failWrites(false);unavailable=false;
 assert.equal((await (await f.call('/team')).json() as any).status,'active');
 assert.equal(f.actor.scheduler.state.workflows[f.id].status,'RUNNING');
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,200);
});
test('active worker capabilities can read only their own safe team board',async()=>{
 const f=await fixture('true'),a=await activate(f);
 const claim=await f.call('/team/claim','POST',{taskId:'root-0'},a.capability),lease=await claim.json() as any;assert.equal(claim.status,200);
 assert.equal((await f.call('/team/notes','POST',{text:'Own team progress'},a.capability)).status,200);
 for(const path of ['/team','/team/tasks','/team/events','/team/notes']){
  const response=await f.call(path,'GET',undefined,a.capability);assert.equal(response.status,200,path);
  const body=await response.text();assert.doesNotMatch(body,/"leases"|"token"|"generation"/);assert.ok(!body.includes(lease.token));assert.ok(!body.includes(a.capability));
 }
 assert.equal((await f.call('/team/block','POST',block,a.capability)).status,401);
 assert.equal((await f.call('/team/review','POST',{reason:'Worker cannot review'},a.capability)).status,401);
 const other=await f.actor.createWorkflow({...spec(),idempotencyKey:'other-team'});await f.actor.approveWorkflow(other.id);
 const {default:worker}=await import('../src/cloudflare/worker.ts');
 for(const section of ['tasks','notes'])assert.equal((await worker.fetch(new Request(`https://control.example/v1/workflows/${other.id}/team/${section}`,{headers:{authorization:'Bearer '+a.capability}}),f.env as never)).status,401);
});
test('worker mutations use normal storage admission and only operator block and review use recovery reserve',async()=>{
 const f=await fixture('true'),a=await activate(f),original=f.actor.schedulerStorage.save.bind(f.actor.schedulerStorage),modes:boolean[]=[];
 let entered!:()=>void,release!:()=>void,first=true;const waiting=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 f.actor.schedulerStorage.save=async(state:unknown,options?:{recovery?:boolean})=>{modes.push(options?.recovery===true);if(first){first=false;entered();await held;}return original(state,options);};
 const note=f.call('/team/notes','POST',{text:'Normal worker metadata'},a.capability);await waiting;const firstMode=modes[0];release();assert.equal((await note).status,200);assert.equal(firstMode,false);
 assert.equal((await f.call('/team/claim','POST',{taskId:'root-0'},a.capability)).status,200);
 for(const [path,input] of [['/team/notes',{text:'Cannot request reserved capacity',recovery:true}],['/team/claim',{taskId:'root-1',recovery:true}]] as const)assert.equal((await f.call(path,'POST',input,a.capability)).status,400);
 assert.deepEqual(modes,[false,false]);
 assert.equal((await f.call('/team/block','POST',{...block,recovery:false})).status,400);assert.deepEqual(modes,[false,false]);
 assert.equal((await f.call('/team/block','POST',block)).status,200);
 assert.equal((await f.call('/team/review','POST',{reason:'Operator review uses reserved capacity'})).status,200);
 assert.deepEqual(modes,[false,false,true,true]);
});
