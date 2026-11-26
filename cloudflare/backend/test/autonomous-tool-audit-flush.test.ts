import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeAutonomousClaude} from '../src/runtime/autonomous-claude.ts';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import {createSnapshot} from '../src/snapshot.ts';
const lease={taskId:'task',runId:'run',workerId:'worker',token:'lease-secret',expiresAt:Date.now()+30000};
const runtimeId='12345678-1234-4234-8234-123456789abc';
const request=()=>({version:1 as const,taskId:'task',executionLease:lease,model:'Fable-1',subagentModel:'Fable-1',tools:['Bash'],goal:'test',session:{sessionId:runtimeId,model:'Fable-1',sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-synthetic-token',maxRunMs:10000});
const authorizer=(subscription:boolean,heartbeat?:()=>Promise<typeof lease>)=>({async start(){const r=request();return {taskId:r.taskId,spec:{requestId:'r',provider:'claude' as const,goal:r.goal,model:r.model,tools:r.tools,systems:[],credentialIds:['c'],maxRunMs:r.maxRunMs,maxIterations:2,budgetMicros:10,endsAt:Date.now()+60000,...(subscription?{billingPolicy:{model:'subscription' as const,budget:'external_actions' as const}}:{})},deadline:Date.now()+10000};},heartbeat:heartbeat??(async()=>lease)});
const boundary=async()=>({platform:'linux',checkedAt:new Date().toISOString(),capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000'])),noNewPrivs:1,verified:true});
const start=(id:string,at:number,extra:object={})=>JSON.stringify({v:1,t:'s',id,tool:'Bash',digest:'a'.repeat(64),summary:'ls',truncated:false,outcome:'allowed',at,...extra})+'\n';
const end=(id:string,at:number,ok=true)=>JSON.stringify({v:1,t:'e',id,ok,at})+'\n';
interface Post {url:string;auth:string;body:any}
async function synthetic(o:{subscription:boolean;audit:boolean|'fail';during:(ctx:{spool:string;tick:()=>Promise<void>;posts:Post[]})=>Promise<void>;timers?:any}){
 const root=await mkdtemp(join(await realpath(tmpdir()),'audit-flush-')),home=join(root,'home'),workspace=join(root,'workspace'),events:string[]=[],posts:Post[]=[];
 const spool=join(home,'.hivemind-phase0','tool-audit.jsonl');let beats=0;
 const fetchImpl=async(url:string|URL|Request,init?:RequestInit)=>{
  posts.push({url:String(url),auth:(init!.headers as Record<string,string>).authorization!,body:JSON.parse(String(init!.body))});events.push('audit');
  if(o.audit==='fail')throw Error('network down');
  const records=JSON.parse(String(init!.body)).records as {sequence:number}[];return Response.json({recorded:true,nextSequence:(records.at(-1)?.sequence??0)+1});
 };
 try{
  const result=await executeAutonomousClaude({...request(),initialSnapshot:createSnapshot([])},{home,workspace,runtimeId,authorizer:authorizer(o.subscription,async()=>{beats++;return lease;}),boundaryCheck:boundary,verifyPrerequisites:async()=>{},
   ...(o.audit?{toolAudit:{url:'https://control.example',token:'reporter-secret',fetchImpl:fetchImpl as typeof fetch}}:{}),
   ...(o.subscription?{reporter:{async ready(){events.push('ready');},async record(){events.push('record');}}}:{}),
   runProcess:async()=>{
    const project=autonomousProjectDirectory(home);await mkdir(project,{recursive:true});await writeFile(join(project,runtimeId+'.jsonl'),JSON.stringify({text:'safe'})+'\n');
    await o.during({spool,posts,tick:async()=>{o.timers.tick(5000);await new Promise<void>(r=>setTimeout(r,60));}});
    return {status:'passed',exitCode:0,stderr:'',stdout:[{type:'system',subtype:'init',session_id:runtimeId,model:'Fable-1'},{type:'result',session_id:runtimeId,subtype:'success',is_error:false,result:JSON.stringify({outcome:'continue'}),usage:{input_tokens:1,cache_read_input_tokens:2,cache_creation_input_tokens:3,output_tokens:4}}].map(x=>JSON.stringify(x)).join('\n'),durationMs:1,truncated:false};
   }});
  return {result,events,posts,beats,spool:await readFile(spool,'utf8').catch(()=>null)};
 }finally{await rm(root,{recursive:true,force:true});}
}
test('final flush ships the spool before the receipt for subscription tasks and also for non-subscription tasks',async()=>{
 for(const subscription of [true,false]){
  const r=await synthetic({subscription,audit:true,during:async({spool})=>{await appendFile(spool,start('t1',1000)+end('t1',1500)+start('t2',2000)).catch(async()=>{await mkdir(join(spool,'..'),{recursive:true});await appendFile(spool,start('t1',1000)+end('t1',1500)+start('t2',2000));});}});
  assert.equal(r.posts.length,1);const body=r.posts[0]!.body;
  assert.equal(r.posts[0]!.url,'https://control.example/v1/autonomous-tasks/task/tool-calls');assert.equal(r.posts[0]!.auth,'Bearer reporter-secret');assert.deepEqual(body.lease,lease);
  // At the final flush even a still-open call (durationMs null) is shipped: nothing runs afterwards.
  assert.deepEqual(body.records.map((x:any)=>[x.sequence,x.durationMs]),[[1,500],[2,null]]);assert.equal(body.droppedByWorker,0);
  if(subscription)assert.deepEqual(r.events,['ready','audit','record']);else assert.deepEqual(r.events,['audit']);
  assert.ok(r.spool!.includes('"id":"t2"'),'spool is never truncated');
 }
});
test('heartbeat flush holds back records that are still allowed with unknown duration, then ships them once complete',async(t)=>{
 t.mock.timers.enable({apis:['setInterval']});
 try{
  const r=await synthetic({subscription:false,audit:true,timers:t.mock.timers,during:async({spool,tick,posts})=>{
   await mkdir(join(spool,'..'),{recursive:true});
   await appendFile(spool,start('t1',1000)+end('t1',1400)+start('t2',2000)+start('t3',3000));
   await tick();
   assert.deepEqual(posts.map(p=>p.body.records.map((x:any)=>x.sequence)),[[1]],'only the completed prefix is sent; later sequences wait behind the open call');
   await appendFile(spool,end('t2',2600)+end('t3',3100,false));
   await tick();
   assert.deepEqual(posts.map(p=>p.body.records.map((x:any)=>x.sequence)),[[1],[2,3]]);
   assert.equal(posts[1]!.body.records[1].outcome,'error');
  }});
  assert.equal(r.posts.length,2,'final flush has nothing new to send');assert.equal(r.beats,2);
 }finally{t.mock.timers.reset();}
});
test('denied records are complete immediately and not held back',async(t)=>{
 t.mock.timers.enable({apis:['setInterval']});
 try{
  const r=await synthetic({subscription:false,audit:true,timers:t.mock.timers,during:async({spool,tick,posts})=>{
   await mkdir(join(spool,'..'),{recursive:true});await appendFile(spool,start('d1',1000,{outcome:'denied'}));await tick();
   assert.equal(posts.length,1);assert.equal(posts[0]!.body.records[0].outcome,'denied');
  }});
  assert.equal(r.posts.length,1);
 }finally{t.mock.timers.reset();}
});
test('audit transport failure never fails the iteration; no configuration means no request',async()=>{
 const failing=await synthetic({subscription:false,audit:'fail',during:async({spool})=>{await mkdir(join(spool,'..'),{recursive:true});await appendFile(spool,start('t1',1000)+end('t1',1200));}});
 assert.equal(failing.result.outcome,'continue');assert.equal(failing.posts.length,1);
 const off=await synthetic({subscription:false,audit:false,during:async({spool})=>{await mkdir(join(spool,'..'),{recursive:true});await appendFile(spool,start('t1',1000));}});
 assert.equal(off.posts.length,0);assert.equal(off.result.outcome,'continue');
});
test('a missing spool is not an error and sends nothing',async()=>{
 const r=await synthetic({subscription:false,audit:true,during:async()=>{}});assert.equal(r.posts.length,0);assert.equal(r.result.outcome,'continue');
});
