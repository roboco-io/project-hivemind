import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCloudWorkflowControl} from '../packages/core/src/cloud-workflow-store.js';
import {createCloudWorkflowPort} from '../packages/adapters/src/cloud-workflow.js';
import {buildApp} from '../apps/control-plane/src/app.js';
const id='43c19f35-0f90-469e-8f20-0b5631d69131', contractHash='a'.repeat(64),inputSnapshotId='b'.repeat(64);
const draft={requestId:id,title:'Team',baseCommit:'c'.repeat(40),contractPath:'CONTRACT.md',codex:{instructions:'a',writes:['a']},claude:{instructions:'b',writes:['b']}};
export const summary={id:'team-1',workflowId:id,status:'active',endsAt:10000,reviewed:false,recoveryRequired:false,taskCounts:{pending:2,claimed:0,submitted:0,verified:0,failed:0,recovery_required:0},blocked:false};
test('operator team route requires operator auth before parsing and stays in registered scope',async t=>{
 const calls:string[]=[];
 const control=createCloudWorkflowControl(':memory:','scope',{async draft(){return {id,contractHash,inputSnapshotId};},async approve(){return {status:'RUNNING'};},async read(){return {};},async teamRead(_binding:any,section:any){calls.push(section);return summary;}} as any);
 await control.draft(draft);const app=buildApp({workflows:control});t.after(()=>app.close());
 const url='/api/cloudflare/workflows/'+id+'/team';
 assert.equal((await app.inject({url,headers:{authorization:'Bearer local-worker-only'}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:url+'/block',headers:{authorization:'Bearer local-worker-only','content-type':'application/json'},payload:'{'})).statusCode,401);
 assert.equal(calls.length,0);
 const response=await app.inject({url,headers:{authorization:'Bearer local-development-only'}});assert.equal(response.statusCode,200);assert.deepEqual(calls,['summary']);
 const other=await app.inject({url:url.replace(id,'11111111-1111-4111-8111-111111111111'),headers:{authorization:'Bearer local-development-only'}});assert.equal(other.statusCode,404);assert.equal(calls.length,1);
});
test('team adapter uses fixed authenticated HTTP seam and refuses a changed workflow binding',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];let changed=false;
 const fetchImpl:typeof fetch=async(url,init={})=>{calls.push({url:String(url),init});return Response.json(String(url).endsWith('/team')?summary:{workflow:{id,status:'RUNNING',spec:{snapshotId:inputSnapshotId,contractHash:changed?'f'.repeat(64):contractHash}}});};
 const port=createCloudWorkflowPort({baseUrl:'https://control.example',controlToken:'private-token',policy:{baseCommit:draft.baseCommit},credentialIds:{codex:'c',claude:'d'}} as any,{} as any,fetchImpl);
 assert.equal(typeof port.teamRead,'function');await port.teamRead!({id,contractHash,inputSnapshotId},'summary');assert.equal(calls.length,2);
 assert.equal(calls[1]!.url,'https://control.example/v1/workflows/'+id+'/team');assert.equal(new Headers(calls[1]!.init.headers).get('authorization'),'Bearer private-token');
 changed=true;await assert.rejects(port.teamRead!({id,contractHash,inputSnapshotId},'summary'));assert.equal(calls.length,3);
});

test('team adapter block/review and pages sanitize hostile remote responses and fail closed',async()=>{
 const calls:{path:string;body:unknown}[]=[];let responseMode='normal';
 const token='private-token',encoded=Buffer.from(token).toString('base64');
 const fetchImpl:typeof fetch=async(url,init={})=>{
  const path=new URL(String(url)).pathname+new URL(String(url)).search;calls.push({path,body:init.body?JSON.parse(String(init.body)):undefined});
  if(path==='/v1/workflows/'+id)return Response.json({workflow:{id,status:'RUNNING',spec:{snapshotId:inputSnapshotId,contractHash}}});
  if(responseMode==='large')return new Response('x'.repeat(1048577));
  if(responseMode==='error')return new Response(token,{status:403});
  if(path.includes('/notes'))return Response.json({notes:[{source:'worker_report',sequence:1,at:1,memberId:'worker',text:encoded+' secret=unsafe-value',lease:{token:'private-lease'}}],nextAfter:1,capability:'private-capability'});
  return Response.json({...summary,status:'blocked',blocked:true,leases:[{token:'private-lease'}]});
 };
 const port=createCloudWorkflowPort({baseUrl:'https://control.example',controlToken:token,policy:{baseCommit:draft.baseCommit},credentialIds:{codex:'c',claude:'d'}} as any,{} as any,fetchImpl),binding={id,contractHash,inputSnapshotId};
 const blocked=await port.teamBlock!(binding,{category:'identity_mismatch',reason:'operator decision',evidenceRef:'fixture'});assert.equal(blocked.blocked,true);
 await port.teamReview!(binding,{reason:'human review'});
 const notes=await port.teamRead!(binding,'notes',{after:0,limit:1});assert.doesNotMatch(JSON.stringify(notes),/private-lease|private-capability|cHJpdmF0ZS10b2tlbg==|unsafe-value/);
 assert.equal(calls.at(-1)!.path,'/v1/workflows/'+id+'/team/notes?after=0&limit=1');
 const before=calls.length;await assert.rejects(port.teamRead!(binding,'summary',{limit:1}));assert.equal(calls.length,before);
 responseMode='large';await assert.rejects(port.teamRead!(binding,'notes'));
 responseMode='error';await assert.rejects(port.teamRead!(binding,'notes'),error=>!String(error).includes(token));
});

test('local operator HTTP crosses remote Team API for all reads, block and review',async t=>{
 const {TeamEngine}=await import('../packages/core/src/team.js');
 const {createTeamService,handleTeamApi}=await import('../apps/control-plane/src/team-api.js');
 const engine=new TeamEngine();engine.create({id:'team-1',workflowId:id,contractHash,endsAt:10000,maxConcurrentClaims:1,members:[{id:'worker',role:'worker',writes:['a']}],tasks:[{id:'task',title:'Task',dependencies:[],writes:['a'],assignee:'worker'}]},1);
 const service=createTeamService({now:()=>2,repository:{async read(){return engine.snapshot();},async mutate(_id,fn){return fn(engine);}}});
 const paths:string[]=[];
 const fetchImpl:typeof fetch=async(url,init={})=>{
  const request=new Request(url,init);paths.push(new URL(request.url).pathname);
  if(new URL(request.url).pathname==='/v1/workflows/'+id)return Response.json({workflow:{id,status:'RUNNING',spec:{snapshotId:inputSnapshotId,contractHash}}});
  return (await handleTeamApi(request,{operatorToken:'cloud-operator',service}))??new Response('',{status:404});
 };
 const remote=createCloudWorkflowPort({baseUrl:'https://cloud.example',controlToken:'cloud-operator',policy:{baseCommit:draft.baseCommit},credentialIds:{codex:'c',claude:'d'}} as any,{} as any,fetchImpl);
 const control=createCloudWorkflowControl(':memory:','scope',{...remote,async draft(){return {id,contractHash,inputSnapshotId};}});await control.draft(draft);
 const app=buildApp({workflows:control});t.after(()=>app.close());const url='/api/cloudflare/workflows/'+id+'/team',headers={authorization:'Bearer local-development-only'};
 for(const suffix of ['','/tasks','/events?after=0&limit=1','/notes?limit=1']){const r=await app.inject({url:url+suffix,headers});assert.equal(r.statusCode,200,r.body);}
 const blocked=await app.inject({method:'POST',url:url+'/block',headers,payload:{category:'identity_mismatch',reason:'explicit block',evidenceRef:'finding-1'}});assert.equal(blocked.statusCode,200,blocked.body);assert.equal(blocked.json().blocked,true);
 const reviewed=await app.inject({method:'POST',url:url+'/review',headers,payload:{reason:'human review'}});assert.equal(reviewed.statusCode,200,reviewed.body);assert.equal(reviewed.json().reviewed,true);assert.equal(reviewed.json().blocked,true);
 const before=paths.length;
 for(const suffix of ['?limit=1','/tasks?after=0','/events?limit=1&limit=2','/notes?after=NaN'])assert.equal((await app.inject({url:url+suffix,headers})).statusCode,400);
 assert.equal(paths.length,before);
 assert.equal((await app.inject({method:'POST',url:url+'/block',headers,payload:{category:'identity_mismatch',reason:'x',evidenceRef:'finding',memberId:'forged'}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:url+'/claim',headers,payload:{taskId:'task'}})).statusCode,404);
});

test('team source projection redacts JSON-escaped known secrets without changing ordinary notes',async()=>{
 const {projectTeamResponse}=await import('../packages/contracts/src/workflow.js');
 const token='local"operator\\credential';
 const page={notes:[{source:'worker_report',sequence:1,at:1,memberId:'worker',text:'before '+JSON.stringify(token).slice(1,-1)+' after'},{source:'worker_report',sequence:2,at:2,memberId:'worker',text:'ordinary "quoted" path\\file'}],nextAfter:2};
 const projected=projectTeamResponse(page,'notes',[token]);
 assert.deepEqual(projected,{...page,notes:[{...page.notes[0],text:'before [REDACTED] after'},page.notes[1]]});
});

test('public team HTTP redacts escaped local operator and remote CONTROL tokens',async t=>{
 const operatorToken='local"operator\\credential',controlToken='remote"CONTROL\\credential';
 const text='before '+JSON.stringify(operatorToken).slice(1,-1)+' between '+JSON.stringify(controlToken).slice(1,-1)+' after';
 const fetchImpl:typeof fetch=async url=>Response.json(new URL(String(url)).pathname.endsWith('/notes')?{notes:[{source:'worker_report',sequence:1,at:1,memberId:'worker',text},{source:'worker_report',sequence:2,at:2,memberId:'worker',text:'ordinary "quoted" path\\file'}],nextAfter:2}:{workflow:{id,status:'RUNNING',spec:{snapshotId:inputSnapshotId,contractHash}}});
 const remote=createCloudWorkflowPort({baseUrl:'https://cloud.example',controlToken,policy:{baseCommit:draft.baseCommit},credentialIds:{codex:'c',claude:'d'}} as any,{} as any,fetchImpl);
 const control=createCloudWorkflowControl(':memory:','scope',{...remote,async draft(){return {id,contractHash,inputSnapshotId};}});await control.draft(draft);
 const app=buildApp({workflows:control,operatorToken});t.after(()=>app.close());
 const response=await app.inject({url:'/api/cloudflare/workflows/'+id+'/team/notes',headers:{authorization:'Bearer '+operatorToken}});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().notes[0].text,'before [REDACTED] between [REDACTED] after');
 assert.equal(response.json().notes[1].text,'ordinary "quoted" path\\file');assert.equal(response.json().nextAfter,2);
});
