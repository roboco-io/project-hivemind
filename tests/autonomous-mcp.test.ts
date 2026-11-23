import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createHivemindMcpServer} from '../apps/mcp-server/src/server.js';

const secret='TEST_ONLY_OPERATOR_CANARY';
const draft={requestId:'draft-1',goal:'Explicit scoped work',provider:'claude',model:'fixture-model-only',endsAt:1900000000000,budgetMicros:500,tools:['Bash'],systems:[],credentialIds:['claude-subscription-ref'],maxRunMs:10000,maxIterations:2,billingPolicy:{model:'subscription',budget:'external_actions'},execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'unit',argv:['node','--test'],timeoutMs:1000}]}};
const task=()=>({id:'autonomous-1',spec:structuredClone(draft),revision:3,status:'awaiting_approval',createdAt:1800000000000,iteration:0,spentMicros:0,reservedMicros:0,counts:{humanInterventions:40,helpRequests:2,toolCalls:70},runs:[],actions:[],resources:[],interventions:[],lease:{token:'NEVER_LEASE'},checkpoint:{objectKey:'NEVER_CHECKPOINT'},nativeRuntimeId:'NEVER_RUNTIME'});
async function session(t:{after(fn:()=>unknown):void}) {
  const calls:{path:string;body:any}[]=[];let current:any=task(),unavailable=false,profiles:any={profiles:[]},externalActions:any[]=[{requestId:'effect-1',phase:'broker',status:'ambiguous',verifiedCostMicros:null,ownershipToken:'NEVER_OWNERSHIP'}];
  const server=createHivemindMcpServer({apiUrl:'http://127.0.0.1:4310',operatorToken:secret,fetchImpl:async(url,options={})=>{
    const path=new URL(String(url)).pathname+new URL(String(url)).search;calls.push({path,body:options.body?JSON.parse(String(options.body)):undefined});assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+secret);assert.equal(options.redirect,'error');
    if(unavailable)return Response.json({error:secret},{status:503});
    if(path.includes('/history?')){const query=new URL(String(url)).searchParams;return Response.json({items:current[query.get('kind')!],nextCursor:'next-history'});}
    if(path.endsWith('?view=summary')){const {runs:_r,actions:_a,resources:_s,interventions:_i,...summary}=current;return Response.json(summary);}
    if(path.includes('/external-actions?'))return Response.json({items:externalActions,nextCursor:'next-effects'});
    if(path.endsWith('/billing')&&options.method==='POST'){const b=JSON.parse(String(options.body));return Response.json({requestId:decodeURIComponent(path.split('/').at(-2)!),revision:b.revision,phase:'cleaned',resourceId:'i-1234abcd',cleanupStatus:'cleaned',verifiedCostMicros:b.actualCostMicros,billingFinal:true,billingSource:'operator_attested',evidenceRef:b.evidenceRef,attestedAt:1800000000000,ownershipToken:'NEVER_OWNERSHIP'});}
    if(path.endsWith('/external-profiles'))return Response.json(profiles);
    if(path.includes('?limit='))return Response.json({items:[current],nextCursor:'opaque-cursor'});
    if(options.method==='POST'&&path==='/api/cloudflare/autonomous-tasks')return Response.json({...task(),spec:JSON.parse(String(options.body)),revision:1},{status:201});
    return Response.json(current);
  }});
  const client=new Client({name:'autonomous-operator-test',version:'1.0.0'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
  const call=(suffix:string,args:Record<string,unknown>={})=>client.callTool({name:'hivemind_autonomous_'+suffix,arguments:args});
  return {client,call,calls,setTask:(value:any)=>{current=value;},setProfiles:(value:any)=>{profiles=value;},setExternalActions:(value:any[])=>{externalActions=value;},unavailable:()=>{unavailable=true;}};
}
test('SDK exposes distinct operator tools and paginated list without private fields',async t=>{
  const h=await session(t),names=(await h.client.listTools()).tools.map(x=>x.name);for(const suffix of ['list','get','create','approve','cancel','message','audit'])assert.ok(names.includes('hivemind_autonomous_'+suffix));
  const result=await h.call('list',{limit:2,cursor:'opaque'});assert.equal(result.isError,undefined);assert.equal(h.calls[0]!.path,'/api/cloudflare/autonomous-tasks?limit=2&cursor=opaque');
  for(const marker of ['NEVER_LEASE','NEVER_CHECKPOINT','NEVER_RUNTIME'])assert.ok(!JSON.stringify(result).includes(marker));
});
test('draft registration requires explicit full scope and never follows with approval',async t=>{
  const h=await session(t);assert.equal((await h.call('create',draft)).isError,undefined);assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0]!.body,draft);assert.ok(!h.calls.some(c=>c.path.endsWith('/approve')));
});
test('strict registration rejects guessed/private fields and accepts up to three explicit profile refs',async t=>{
  const h=await session(t);
  for(const bad of [{...draft,apiUrl:'https://example.invalid'},{...draft,token:secret},{...draft,credentialIds:['hf_RAW_TOKEN']},{...draft,execution:{...draft.execution,command:'sh'}},{...draft,tools:['Agent']},{...draft,externalProfiles:['a','b','c','d']}])assert.equal((await h.call('create',bad)).isError,true);
  assert.equal(h.calls.length,0);
  const scoped={...draft,tools:['Bash','mcp__hivemind__action'],systems:['aws','hf','github'],externalProfiles:['aws-profile','hf-profile','github-profile']};
  assert.equal((await h.call('create',scoped)).isError,undefined);assert.deepEqual(h.calls[0]!.body.externalProfiles,scoped.externalProfiles);
});
test('approval requires exact current revision and reason; stale requests never POST',async t=>{
  const h=await session(t);assert.equal((await h.call('approve',{taskId:'autonomous-1',revision:2,reason:'Explicit user approval'})).isError,true);assert.ok(!h.calls.some(c=>c.body));
  assert.equal((await h.call('approve',{taskId:'autonomous-1',revision:3,reason:'Explicit user approval'})).isError,undefined);
  assert.deepEqual(h.calls.at(-1),{path:'/api/cloudflare/autonomous-tasks/autonomous-1/approve',body:{revision:3,reason:'Explicit user approval'}});
});
test('503 stays remote and generic without local fallback or reflected secrets',async t=>{
  const h=await session(t);h.unavailable();const result=await h.call('list');assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(secret));assert.equal(h.calls.length,1);assert.ok(h.calls.every(c=>c.path.startsWith('/api/cloudflare/autonomous-tasks')));
});
test('audit projects quota usage as unavailable and external unknown billing as null',async t=>{
  const h=await session(t),current=task();current.runs=[{runId:'run-1',outcome:'wait',usageUnavailable:true,usage:{inputTokens:0,outputTokens:0},costMicros:null,privateSession:'NEVER_SESSION'}] as never;h.setTask(current);
  const result=await h.call('audit',{taskId:current.id,limit:10});assert.equal(result.isError,undefined);
  const value=JSON.parse((result.content as {type:string;text:string}[])[0]!.text);assert.equal(value.task.runs[0].usage,null);assert.equal(value.task.runs[0].costMicros,null);assert.equal(value.externalActions[0].verifiedCostMicros,null);
  for(const marker of ['NEVER_SESSION','NEVER_LEASE','NEVER_OWNERSHIP'])assert.ok(!JSON.stringify(result).includes(marker));
});
test('cancel and message are separate explicit mutations',async t=>{
  const h=await session(t);await h.call('cancel',{taskId:'autonomous-1',reason:'User requested stop'});await h.call('message',{taskId:'autonomous-1',message:'User instruction'});
  assert.deepEqual(h.calls.map(c=>c.path),['/api/cloudflare/autonomous-tasks/autonomous-1?view=summary','/api/cloudflare/autonomous-tasks/autonomous-1/cancel','/api/cloudflare/autonomous-tasks/autonomous-1/message']);
});

test('all three server profile targets are shown and checked before current revision approval',async t=>{
  const h=await session(t),current=task();Object.assign(current.spec,{tools:['Bash','mcp__hivemind__action'],systems:['aws','hf','github'],externalProfiles:['aws-ref','hf-ref','gh-ref']});h.setTask(current);
  h.setProfiles({profiles:[{id:'aws-ref',profileHash:'a'.repeat(64),provider:'aws',enabled:true,target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'fixed'},operations:['aws.spot.start'],upperBoundMicros:100,maxLifetimeMs:1000,maxActiveActions:1,credentialRef:'NEVER_PRIVATE_REF',secret:'NEVER_SECRET'},{id:'hf-ref',profileHash:'b'.repeat(64),provider:'hf',enabled:true,target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit'],upperBoundMicros:100,maxLifetimeMs:1000,maxActiveActions:1},{id:'gh-ref',profileHash:'c'.repeat(64),provider:'github',enabled:true,target:{repository:'owner/repo',branch:'hivemind/task'},operations:['github.branch.push'],upperBoundMicros:100,maxLifetimeMs:1000,maxActiveActions:1}]});
  const result=await h.call('get',{taskId:current.id});assert.equal(result.isError,undefined);assert.match(JSON.stringify(result),/owner\/model/);assert.match(JSON.stringify(result),/owner\/repo/);assert.ok(!JSON.stringify(result).includes('NEVER_'));
  assert.equal((await h.call('approve',{taskId:current.id,revision:3,reason:'Explicit approval of three targets',externalProfileHashes:{'aws-ref':'a'.repeat(64),'hf-ref':'b'.repeat(64),'gh-ref':'c'.repeat(64)}})).isError,undefined);
});

test('audit pages forward only explicit external cursor and report known subset',async t=>{
  const h=await session(t),result=await h.call('audit',{taskId:'autonomous-1',limit:10,cursor:'effects-page'});assert.equal(result.isError,undefined);
  assert.ok(h.calls.some(c=>c.path.endsWith('/external-actions?limit=10&cursor=effects-page')));
  const data=JSON.parse((result.content as {text:string}[])[0]!.text);assert.equal(data.externalActionsNextCursor,'next-effects');assert.equal(data.externalActionsCount,1);assert.equal(data.externalActionsPartial,true);
});

test('maximum explicit checks argv scope fits SDK structural limits',async t=>{
  const h=await session(t);const full={...draft,execution:{...draft.execution,checks:Array.from({length:4},(_,i)=>({id:'check-'+i,argv:Array.from({length:32},(_,j)=>'arg-'+j),timeoutMs:1000}))}};
  assert.equal((await h.call('create',full)).isError,undefined);
});

test('actual SDK accepts full valid create scope with four 32-argv checks, 32 normalized hosts and three profiles',async t=>{
  const h=await session(t),full={...draft,subagentModel:'fixture-child-model-only',tools:['Bash','Agent','WebFetch','mcp__hivemind__action'],systems:['aws','hf','github'],externalProfiles:['aws-profile','hf-profile','github-profile'],web:{allowedHosts:Array.from({length:32},(_,i)=>'host'+i+'.example.com')},execution:{...draft.execution,mode:'long_running',checks:Array.from({length:4},(_,i)=>({id:'check-'+i,argv:Array.from({length:32},(_,j)=>'arg-'+j),timeoutMs:10000}))},maxRunMs:120000,maxIterations:65536,schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'}};
  assert.ok(Buffer.byteLength(JSON.stringify(full))<65536);const result=await h.call('create',full);assert.equal(result.isError,undefined);assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0]!.body,full);assert.equal(h.calls[0]!.path,'/api/cloudflare/autonomous-tasks');
});

test('schema-valid byte overflow and nested argv input are rejected before HTTP despite bounded element count',async t=>{
  const h=await session(t),large={...draft,execution:{...draft.execution,checks:Array.from({length:4},(_,i)=>({id:'check-'+i,argv:Array.from({length:32},()=> 'a'.repeat(1000)),timeoutMs:1000}))}};
  assert.ok(Buffer.byteLength(JSON.stringify(large))>65536);assert.equal((await h.call('create',large)).isError,true);
  assert.equal((await h.call('create',{...draft,execution:{...draft.execution,checks:[{id:'nested',argv:[{nested:{command:'not-a-string'}}],timeoutMs:1000}]}})).isError,true);assert.equal(h.calls.length,0);
});

test('accepted actions keep billing unknown even if a transport contains a zero placeholder',async t=>{
  const h=await session(t),current=task();current.actions=[{id:'a',status:'accepted',actualCostMicros:0}] as never;h.setTask(current);
  const result=await h.call('audit',{taskId:current.id});const data=JSON.parse((result.content as {text:string}[])[0]!.text);assert.equal(data.task.actions[0].actualCostMicros,null);assert.equal(data.task.actions[0].billingStatus,'unknown');
});

test('external approval denies missing hashes or target change without issuing POST',async t=>{
  const h=await session(t),current=task();Object.assign(current.spec,{externalProfiles:['aws-ref']});h.setTask(current);
  h.setProfiles({profiles:[{id:'aws-ref',profileHash:'b'.repeat(64),provider:'aws',enabled:true,target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'changed'},upperBoundMicros:100,operations:['aws.spot.start']}]});
  for(const hashes of [undefined,{'aws-ref':'a'.repeat(64)}]){const args={taskId:current.id,revision:3,reason:'User reviewed old target',...(hashes?{externalProfileHashes:hashes}:{})};assert.equal((await h.call('approve',args)).isError,true);}
  assert.ok(!h.calls.some(c=>c.path.endsWith('/approve')));
});

test('review and audit only use bounded summary/history routes with authoritative counts',async t=>{
  const h=await session(t);await h.call('get',{taskId:'autonomous-1'});const result=await h.call('audit',{taskId:'autonomous-1',limit:2,historyCursors:{runs:'runs-page'}});assert.equal(result.isError,undefined);
  assert.ok(!h.calls.some(c=>c.path==='/api/cloudflare/autonomous-tasks/autonomous-1'));
  for(const kind of ['runs','actions','resources','interventions'])assert.ok(h.calls.some(c=>c.path.includes('/history?kind='+kind+'&limit=2')));
  assert.ok(h.calls.some(c=>c.path.endsWith('&cursor=runs-page')));
  const data=JSON.parse((result.content as {text:string}[])[0]!.text);assert.equal(data.task.counts.humanInterventions,40);assert.equal(data.task.counts.toolCalls,70);assert.equal(data.historyPages.runs.nextCursor,'next-history');
});

test('audit exposes bounded owned resource ID from external ledger with empty main resource history and no authority fields',async t=>{
  const h=await session(t);h.setExternalActions([{requestId:'late-owned',phase:'broker',resourceId:'i-1234abcd',cleanupStatus:'pending',ownershipToken:'NEVER_OWNERSHIP',idempotencyKey:'NEVER_IDEMPOTENCY',credential:'NEVER_CREDENTIAL'}]);
  const result=await h.call('audit',{taskId:'autonomous-1'});assert.equal(result.isError,undefined);const value=JSON.parse((result.content as {text:string}[])[0]!.text);
  assert.equal(value.task.resources.length,0);assert.equal(value.externalActions[0].resourceId,'i-1234abcd');assert.equal(value.externalActionsPartial,true);assert.ok(!JSON.stringify(result).includes('NEVER_'));
  h.setExternalActions([{requestId:'long',phase:'broker',resourceId:'i-'+'a'.repeat(1000)}]);const long=await h.call('audit',{taskId:'autonomous-1'});assert.equal((long.structuredContent as any).externalActions[0].resourceId.length,256);
});

test('explicit operator invoice tool sends exact immutable revision and human-provided amount once without estimating',async t=>{
  const h=await session(t),args={taskId:'autonomous-1',requestId:'same-request',revision:2,actualCostMicros:375,evidenceRef:'invoice-fixture-375',reason:'User verified final invoice and absence'};
  const result=await h.call('record_external_cost',args);assert.equal(result.isError,undefined);assert.deepEqual(h.calls,[{path:'/api/cloudflare/autonomous-tasks/autonomous-1/external-actions/same-request/billing',body:{actualCostMicros:375,evidenceRef:args.evidenceRef,reason:args.reason,revision:2}}]);
  const data=result.structuredContent as any;assert.equal(data.action.revision,2);assert.equal(data.action.verifiedCostMicros,375);assert.equal(data.action.billingSource,'operator_attested');assert.match(data.action.billingSourceLabel,/운영자/);assert.ok(!JSON.stringify(result).includes('NEVER_'));
});

test('invoice tool rejects missing immutable key, guesses, raw authority and malformed explicit amount before HTTP',async t=>{
  const h=await session(t),base={taskId:'autonomous-1',requestId:'same-request',revision:2,actualCostMicros:5,evidenceRef:'invoice-fixture-explicit',reason:'User supplied final invoice'};
  const {revision:_r,...missing}=base;
  for(const bad of [missing,{...base,actualCostMicros:0},{...base,actualCostMicros:-1},{...base,actualCostMicros:1.2},{...base,actualCostMicros:'375'},{...base,evidenceRef:''},{...base,reason:''},{...base,billingSource:'PROVIDER_API'},{...base,lease:{token:secret}},{...base,estimateTokens:100},{...base,evidenceRef:'hf_secret'},{...base,reason:'Bearer TOP_SECRET'}])assert.equal((await h.call('record_external_cost',bad)).isError,true);
  assert.equal(h.calls.length,0);assert.equal((await h.call('record_external_cost',base)).isError,undefined);assert.equal(h.calls.length,1);
});

test('invoice refusal is generic and never retries or substitutes the current task revision',async t=>{
  const h=await session(t);h.unavailable();const result=await h.call('record_external_cost',{taskId:'autonomous-1',requestId:'same-request',revision:1,actualCostMicros:10,evidenceRef:'invoice-fixture',reason:'Explicit user instruction'});
  assert.equal(result.isError,true);assert.equal(h.calls.length,1);assert.equal(h.calls[0]!.body.revision,1);assert.ok(!JSON.stringify(result).includes(secret));
});

test('audit preserves each external action revision and labels attested cost without inferring current revision',async t=>{
  const h=await session(t);h.setExternalActions([{requestId:'reused',revision:1,phase:'cleaned',resourceId:'i-1234abcd',verifiedCostMicros:375,billingFinal:true,billingSource:'operator_attested',evidenceRef:'invoice-fixture',attestedAt:1800000000000},{requestId:'reused',revision:2,phase:'broker',resourceId:'i-abcd1234',verifiedCostMicros:null}]);
  const result=await h.call('audit',{taskId:'autonomous-1'}),a=(result.structuredContent as any).externalActions;assert.deepEqual(a.map((v:any)=>v.revision),[1,2]);assert.equal(a[0].billingSource,'operator_attested');assert.match(a[0].billingSourceLabel,/운영자/);assert.equal(a[0].evidenceRef,'invoice-fixture');
});

test('audit retains durable approved target and hash per action without substituting registry or exposing target extras',async t=>{
  const h=await session(t);h.setExternalActions([{requestId:'old-action',revision:1,phase:'broker',profileId:'reused-profile',approvedTarget:{repository:'owner/old',branch:'old-branch',credential:'NEVER_TARGET_CREDENTIAL'},approvedProfileHash:'a'.repeat(64),resourceId:'owned-old',ownershipToken:'NEVER_OWNER'}, {requestId:'no-proof',revision:2,phase:'intent',profileId:'reused-profile'}]);
  const result=await h.call('audit',{taskId:'autonomous-1'}),rows=(result.structuredContent as any).externalActions;
  assert.equal(rows[0].profileId,'reused-profile');assert.deepEqual(rows[0].approvedTarget,{repository:'owner/old',branch:'old-branch'});assert.equal(rows[0].approvedProfileHash,'a'.repeat(64));assert.equal(rows[0].approvedTargetLabel,'승인 당시 대상');assert.equal(rows[1].approvedTarget,undefined);assert.equal(rows[1].approvedProfileHash,undefined);assert.ok(!JSON.stringify(result).includes('NEVER_'));
  h.setExternalActions([{requestId:'bad-target',phase:'intent',approvedTarget:{url:'https://not-an-approved-target',token:'NEVER_TOKEN'},approvedProfileHash:'bad'}]);const bad=await h.call('audit',{taskId:'autonomous-1'});assert.equal((bad.structuredContent as any).externalActions[0].approvedTarget,undefined);assert.ok(!JSON.stringify(bad).includes('NEVER_'));
});

test('R9 audit forwards typed artifact and durable provider result without arbitrary message or receipt authority',async t=>{
  const h=await session(t);h.setExternalActions([{requestId:'published',revision:1,phase:'broker',parameterHash:'a'.repeat(64),parametersSubset:{artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(40),message:'NEVER_MESSAGE',authorization:'NEVER_AUTH'},providerResult:{kind:'github_commit',oid:'d'.repeat(40),ownershipToken:'NEVER_OWNER'},evidenceId:'NEVER_EVIDENCE'}, {requestId:'spot',phase:'broker',parametersSubset:{lifetimeMs:40000},providerResult:{kind:'aws_instance',id:'i-1234abcd'}}, {requestId:'inspect',phase:'broker',parametersSubset:{startActionId:'owned-start'}}, {requestId:'model',phase:'broker',providerResult:{kind:'hf_commit',oid:'e'.repeat(64)}}]);
  const result=await h.call('audit',{taskId:'autonomous-1'}),rows=(result.structuredContent as any).externalActions;
  assert.equal(rows[0].parameterHash,'a'.repeat(64));assert.deepEqual(rows[0].parametersSubset,{artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(40)});assert.deepEqual(rows[0].providerResult,{kind:'github_commit',oid:'d'.repeat(40)});assert.deepEqual(rows[1].providerResult,{kind:'aws_instance',id:'i-1234abcd'});assert.equal(rows[1].parametersSubset.lifetimeMs,40000);assert.equal(rows[2].parametersSubset.startActionId,'owned-start');assert.deepEqual(rows[3].providerResult,{kind:'hf_commit',oid:'e'.repeat(64)});assert.ok(!JSON.stringify(result).includes('NEVER_'));assert.ok(!h.calls.some(c=>c.body));
});

test('R9 audit drops malformed typed metadata rather than reflecting raw provider data',async t=>{
  const h=await session(t);for(const metadata of [{parameterHash:'bad',parametersSubset:{artifactDigest:'NEVER_DIGEST'},providerResult:{kind:'github_commit',oid:'NEVER_OID'}},{parametersSubset:{lifetimeMs:-1},providerResult:{kind:'aws_instance',id:'NEVER_ID'}},{parametersSubset:{startActionId:'x'.repeat(1000)},providerResult:{kind:'arbitrary',message:'NEVER_MESSAGE'}}]){
    h.setExternalActions([{requestId:'bad',phase:'broker',...metadata}]);const result=await h.call('audit',{taskId:'autonomous-1'}),a=(result.structuredContent as any).externalActions[0];assert.equal(a.parameterHash,undefined);assert.equal(a.parametersSubset,undefined);assert.equal(a.providerResult,undefined);assert.ok(!JSON.stringify(result).includes('NEVER_'));
  }
});

test('R9 audit accepts current producer typed parameters wire name through the same subset allowlist',async t=>{
  const h=await session(t);h.setExternalActions([{requestId:'producer-wire',phase:'broker',parameterHash:'a'.repeat(64),parameters:{artifactDigest:'b'.repeat(64),message:'NEVER_MESSAGE'},providerResult:{kind:'hf_commit',oid:'c'.repeat(40)}}]);
  const result=await h.call('audit',{taskId:'autonomous-1'}),a=(result.structuredContent as any).externalActions[0];assert.deepEqual(a.parametersSubset,{artifactDigest:'b'.repeat(64)});assert.equal(a.parameters,undefined);assert.ok(!JSON.stringify(result).includes('NEVER_'));
});

test('MCP public large metadata preserves boolean consent and rejects malformed acknowledgement',async t=>{
 const h=await session(t),current=task();(current.spec as any).externalProfiles=['hf-ref'];h.setTask(current);
 const p={id:'hf-ref',enabled:true,profileHash:'b'.repeat(64),provider:'hf',target:{repository:'owner/model',revision:'main',visibility:'public',allowPublicLarge:true},operations:['hf.model.lfs_commit'],upperBoundMicros:100,hfVisibilityDisplay:{visibility:'public',publicEffect:true,notice:'공개 저장소'}};
 h.setProfiles({profiles:[p]});const result=await h.call('get',{taskId:current.id});
 const view=result.structuredContent as any;assert.equal(view.task.externalProfilesMetadata[0].target.allowPublicLarge,true);assert.equal(view.task.externalProfilesMetadata[0].publicEffect,true);
 h.setExternalActions([{requestId:'old',operation:'hf.model.lfs_commit',phase:'broker',approvedTarget:p.target}]);const audit=await h.call('audit',{taskId:current.id});assert.equal((audit.structuredContent as any).externalActions[0].approvedTarget.allowPublicLarge,true);
 for(const flag of [undefined,false,'true',null]){
  h.setProfiles({profiles:[{...p,target:{...p.target,allowPublicLarge:flag}}]});const bad=await h.call('get',{taskId:current.id});assert.equal((bad.structuredContent as any).task.externalProfileMetadataAvailable,false);
 }
});

test('MCP mixed HF profile preserves consent for inline and LFS audit targets',async t=>{
 const h=await session(t),current=task();(current.spec as any).externalProfiles=['hf-ref'];h.setTask(current);
 const target={repository:'owner/model',revision:'main',visibility:'public',allowPublicLarge:true};
 h.setProfiles({profiles:[{id:'hf-ref',enabled:true,profileHash:'b'.repeat(64),provider:'hf',target,operations:['hf.model.commit','hf.model.lfs_commit'],upperBoundMicros:100,hfVisibilityDisplay:{visibility:'public',publicEffect:true,notice:'공개 대형 게시 허용'}}]});
 for(const operation of ['hf.model.commit','hf.model.lfs_commit']){
  h.setExternalActions([{requestId:'audit',phase:'broker',operation,approvedTarget:target}]);const audit=await h.call('audit',{taskId:current.id});assert.deepEqual((audit.structuredContent as any).externalActions[0].approvedTarget,target);
  for(const allowPublicLarge of [false,'true',null]){h.setExternalActions([{requestId:'audit',phase:'broker',operation,approvedTarget:{...target,allowPublicLarge}}]);const bad=await h.call('audit',{taskId:current.id});assert.equal((bad.structuredContent as any).externalActions[0].approvedTarget,undefined);}
 }
});
