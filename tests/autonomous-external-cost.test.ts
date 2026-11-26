import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,createHmac} from 'node:crypto';
import {externalParametersHash} from '../packages/core/src/autonomous-external.js';
import {createAwsCostExplorerReader,createExternalCostCache} from '../packages/adapters/src/autonomous-external-cost.ts';
import type {ExternalInvocation} from '../packages/contracts/src/autonomous-external.js';
const day=86400000,start=Date.parse('2026-01-01T10:00:00Z'),stop=start+day,now=start+4*day;
const invocation:ExternalInvocation={taskId:'task',revision:1,actionId:'action',profile:{id:'aws',enabled:true,provider:'aws',target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'work'},operations:['aws.spot.start'],credentialRef:'aws-ref',maxLifetimeMs:120000,upperBoundMicros:100000,maxActiveActions:1},operation:'aws.spot.start',parameters:{lifetimeMs:120000},parametersHash:'',ownershipToken:'owner-unique',idempotencyKey:'request-unique',expiresAt:start+120000};
invocation.parametersHash=externalParametersHash(invocation.profile,invocation.operation,invocation.parameters);
const proof={resourceConfirmedAbsent:true,observedStoppedAt:stop};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function daily(date:string,amount:string){const end=new Date(Date.parse(date)+day).toISOString().slice(0,10);return {TimePeriod:{Start:date,End:end},Estimated:false,Groups:[{Keys:['123456789012','hivemind:owner$owner-unique'],Metrics:{UnblendedCost:{Amount:amount,Unit:'USD'}}}]};}
const usage=()=>({GroupDefinitions:[{Type:'DIMENSION',Key:'LINKED_ACCOUNT'},{Type:'TAG',Key:'hivemind:owner'}],ResultsByTime:[daily('2026-01-01','0.0000001'),daily('2026-01-02','0.0100000')]});
const activation=()=>({CostAllocationTags:['hivemind:owner','hivemind:workload'].map(TagKey=>({TagKey,Status:'Active',Type:'UserDefined',LastUpdatedDate:'2025-12-01T00:00:00Z'}))});
function fixture(){
 const db=new DatabaseSync(':memory:');const sql={exec(q:string,...p:(string|number|null)[]){const s=db.prepare(q);return s.columns().length?s.all(...p):(s.run(...p),[]);},transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 let clock=now,credentials=0;const calls:{url:string;init:RequestInit;body:any}[]=[];let data:unknown=usage(),tags:unknown=activation(),fail=false;
 const options:any={enabled:true,accountId:'123456789012',resourceRegion:'ap-northeast-2',workloadId:'work',queryUpperBoundMicros:3,maxQueryCount:4,resourceUpperBoundMicros:50000,tagActivation:{evidenceId:'server-verified-active-tags',activeSince:Date.parse('2025-12-01T00:00:00Z'),observedAt:start-1,validUntil:now+10*day},cache:createExternalCostCache(sql),credentials:async()=>{credentials++;return {accessKeyId:'SYNTHETIC',secretAccessKey:'synthetic-secret'};},now:()=>clock,fetch:async(url:string,init:RequestInit)=>{
  const body=JSON.parse(String(init.body));calls.push({url:String(url),init,body});if(fail)throw Error('SENSITIVE-DO-NOT-RETURN');
  return Response.json(new Headers(init.headers).get('x-amz-target')!.endsWith('.ListCostAllocationTags')?tags:data,{headers:{'x-amzn-requestid':'remote-evidence-'+calls.length}});
 }};
 return {db,options,calls,reader:()=>createAwsCostExplorerReader(options),setData(v:unknown){data=v;},setTags(v:unknown){tags=v;},time(v:number){clock=v;},fail(){fail=true;},get credentials(){return credentials;}};
}
test('disabled, incomplete scope, absent resource proof and missing active-tag evidence never query CE',async()=>{
 const f=fixture();try{for(const patch of [{enabled:false},{enabled:undefined},{tagActivation:undefined},{cache:undefined},{queryUpperBoundMicros:undefined}])assert.deepEqual(await createAwsCostExplorerReader({...f.options,...patch}).read(invocation,proof),{verifiedCostMicros:null,final:false});
 assert.deepEqual(await f.reader().read(invocation,{...proof,resourceConfirmedAbsent:false}),{verifiedCostMicros:null,final:false});assert.equal(f.calls.length,0);assert.equal(f.credentials,0);
 }finally{f.db.close();}
});
test('fixed CE us-east-1 signature, exact account/region/owner filters and decimal upward micro conversion',async()=>{
 const f=fixture();try{
 const r=await f.reader().read(invocation,proof);assert.equal(r.verifiedCostMicros,10001);assert.equal(r.final,false);assert.equal(f.calls.length,2);
 for(const call of f.calls){assert.equal(call.url,'https://ce.us-east-1.amazonaws.com/');assert.equal(call.init.redirect,'manual');const h=new Headers(call.init.headers),auth=h.get('authorization')!;
  const m=/Credential=SYNTHETIC\/(\d{8})\/us-east-1\/ce\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(auth);assert.ok(m);
  const names=m[2]!,headers=names.split(';').map(k=>`${k}:${h.get(k)!.trim()}\n`).join(''),request=['POST','/','',headers,names,hash(String(call.init.body))].join('\n'),scope=`${m[1]}/us-east-1/ce/aws4_request`;
  let key:Buffer=Buffer.from('AWS4synthetic-secret');for(const s of [m[1]!,'us-east-1','ce','aws4_request'])key=createHmac('sha256',key).update(s).digest();
  assert.equal(m[3],createHmac('sha256',key).update(['AWS4-HMAC-SHA256',h.get('x-amz-date'),scope,hash(request)].join('\n')).digest('hex'));
 }
 const query=f.calls[1]!.body;assert.deepEqual(query.TimePeriod,{Start:'2026-01-01',End:'2026-01-03'});assert.match(JSON.stringify(query.Filter),/123456789012/);assert.match(JSON.stringify(query.Filter),/ap-northeast-2/);assert.match(JSON.stringify(query.Filter),/owner-unique/);assert.match(JSON.stringify(query.Filter),/hivemind:workload/);assert.ok(!JSON.stringify(r).includes('synthetic-secret'));
 assert.equal(f.reader().quote(invocation)?.maximumQueryFeeMicros,12);
 }finally{f.db.close();}
});
test('SQL cooldown and consumed request cap survive reader recreation and timeout',async()=>{
 const f=fixture();try{f.fail();await f.reader().read(invocation,proof);assert.equal(f.calls.length,1);
 await f.reader().read(invocation,proof);assert.equal(f.calls.length,1);
 f.time(now+day);await f.reader().read(invocation,proof);assert.equal(f.calls.length,2);
 f.time(now+2*day);await f.reader().read(invocation,proof);assert.equal(f.calls.length,2);
 }finally{f.db.close();}
});
test('empty, estimated, incomplete, paginated, negative, non-USD and foreign group data remain unknown',async()=>{
 const cases:unknown[]=[{}, {...usage(),ResultsByTime:[]},{...usage(),NextPageToken:'more'}, {...usage(),ResultsByTime:[daily('2026-01-01','1')]}, {...usage(),ResultsByTime:[{...daily('2026-01-01','1'),Estimated:true},daily('2026-01-02','1')]}];
 for(const amount of ['-1','1e-6','NaN','9007199254740992',' 0.0','1.00000000000000000001'])cases.push({...usage(),ResultsByTime:[daily('2026-01-01',amount),daily('2026-01-02','1')]});
 const foreign=usage();foreign.ResultsByTime[0]!.Groups[0]!.Keys[0]='999999999999';cases.push(foreign);
 const unit=usage();unit.ResultsByTime[0]!.Groups[0]!.Metrics.UnblendedCost.Unit='KRW';cases.push(unit);
 for(const value of cases){const f=fixture();try{f.setData(value);const r=await f.reader().read(invocation,proof);assert.equal(r.verifiedCostMicros,null);assert.equal(r.final,false);}finally{f.db.close();}}
});
test('inactive/newly activated ownership tags, premature periods and oversized date ranges never finalize',async()=>{
 const f=fixture();try{f.setTags({CostAllocationTags:[]});assert.equal((await f.reader().read(invocation,proof)).verifiedCostMicros,null);}finally{f.db.close();}
 const g=fixture();try{g.time(stop+day);assert.equal((await g.reader().read(invocation,proof)).verifiedCostMicros,null);assert.equal(g.calls.length,0);
 assert.equal((await g.reader().read(invocation,{...proof,observedStoppedAt:start+15*day})).verifiedCostMicros,null);assert.equal(g.calls.length,0);
 }finally{g.db.close();}
});
test('final billing requires a separate verified source covering CE queries and non-EC2/EBS costs',async()=>{
 const f=fixture();try{f.options.supplement={async read(_i:unknown,scope:any){return {scope:'ce_queries_and_non_ec2_ebs',scopeHash:scope.scopeHash,coveredRequestCount:scope.requestCount,verifiedCostMicros:7,final:true,evidenceId:'verified-separate-invoice'};}};
 const r=await f.reader().read(invocation,proof);assert.equal(r.verifiedCostMicros,10008);assert.equal(r.final,true);assert.equal(f.calls.length,2);
 assert.deepEqual(await f.reader().read(invocation,proof),r);assert.equal(f.calls.length,2);
 }finally{f.db.close();}
});
test('account/region/parameter binding and quote changes cannot reset persisted query slots',async()=>{
 const f=fixture();try{await f.reader().read(invocation,proof);f.time(now+day);f.options.maxQueryCount=14;
 const changed=await f.reader().read(invocation,proof);assert.equal(changed.final,false);assert.equal(f.calls.length,2);
 const other={...invocation,profile:{...invocation.profile,target:{accountId:'999999999999',region:'ap-northeast-2',workloadId:'work'}}} as ExternalInvocation;
 assert.equal((await f.reader().read(other,proof)).verifiedCostMicros,null);assert.equal(f.calls.length,2);
 }finally{f.db.close();}
});
test('first live absence observation persists before mature CE period, even when later proof time advances',async()=>{
 const f=fixture();try{f.time(stop);await f.reader().read(invocation,proof);assert.equal(f.calls.length,0);
 f.time(now);const result=await f.reader().read(invocation,{...proof,observedStoppedAt:now});assert.equal(result.verifiedCostMicros,10001);assert.equal(f.calls[1]!.body.TimePeriod.End,'2026-01-03');
 }finally{f.db.close();}
});
test('later verified supplementary receipt finalizes cached resource cost without creating new CE fees',async()=>{
 const f=fixture();let ready=false;
 try{f.options.supplement={async read(_i:unknown,s:any){return ready?{scope:'ce_queries_and_non_ec2_ebs',scopeHash:s.scopeHash,coveredRequestCount:s.requestCount,verifiedCostMicros:7,final:true,evidenceId:'later-verified-invoice'}:null;}};
 assert.equal((await f.reader().read(invocation,proof)).final,false);assert.equal(f.calls.length,2);ready=true;
 const final=await f.reader().read(invocation,proof);assert.equal(final.final,true);assert.equal(final.verifiedCostMicros,10008);assert.equal(f.calls.length,2);
 }finally{f.db.close();}
});
test('cost quote refuses a cache without a real transaction function',()=>{
 const f=fixture();try{assert.equal(createAwsCostExplorerReader({...f.options,cache:{}}).quote(invocation),null);}finally{f.db.close();}
});
test('CE group definition JSON field order does not change its verified meaning',async()=>{
 const f=fixture();try{f.setData({...usage(),GroupDefinitions:[{Key:'LINKED_ACCOUNT',Type:'DIMENSION'},{Key:'hivemind:owner',Type:'TAG'}]});assert.equal((await f.reader().read(invocation,proof)).verifiedCostMicros,10001);}finally{f.db.close();}
});

test('Ohio resource cost scope keeps fixed billing endpoint and passes actual resource region',async()=>{
 const f=fixture();try{
 const i=structuredClone(invocation);i.profile.target={...i.profile.target,region:'us-east-2'};i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);
 Object.assign(f.options,{resourceRegion:'us-east-2',allowedRegions:['us-east-2']});let credentialScope:unknown;
 f.options.credentials=async(scope:unknown)=>{credentialScope=scope;return {accessKeyId:'SYNTHETIC',secretAccessKey:'synthetic-secret'};};
 assert.equal((await f.reader().read(i,proof)).verifiedCostMicros,10001);
 assert.deepEqual(credentialScope,{accountId:'123456789012',resourceRegion:'us-east-2',billingRegion:'us-east-1',purpose:'cost_read'});
 assert.deepEqual(f.calls[1]!.body.Filter.And[1].Dimensions.Values,['us-east-2']);assert.equal(f.calls[1]!.url,'https://ce.us-east-1.amazonaws.com/');
 }finally{f.db.close();}
 const g=fixture();try{g.options.resourceRegion='us-east-2';assert.equal(g.reader().quote(invocation),null);await g.reader().read(invocation,proof);assert.equal(g.calls.length,0);assert.equal(g.credentials,0);}finally{g.db.close();}
});

test('Workers-compatible CE fetch avoids unsupported redirect error mode',async()=>{
 const f=fixture();try{const base=f.options.fetch;f.options.fetch=async(url:string,init:RequestInit)=>{if(init.redirect==='error')throw new TypeError('Unsupported redirect mode: error');return base(url,init);};assert.equal((await f.reader().read(invocation,proof)).verifiedCostMicros,10001);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.init.redirect==='manual'));}finally{f.db.close();}
});
test('CE refuses 302 without following location or claiming verified cost',async()=>{
 const f=fixture();try{const calls:{url:string;redirect:RequestRedirect|undefined}[]=[];f.options.fetch=async(url:string,init:RequestInit)=>{calls.push({url,redirect:init.redirect});return new Response('redirect',{status:302,headers:{location:'https://foreign.example.org/credential-target'}});};assert.deepEqual(await f.reader().read(invocation,proof),{verifiedCostMicros:null,final:false});assert.equal(calls.length,1);assert.equal(calls[0]!.redirect,'manual');assert.equal(calls[0]!.url,'https://ce.us-east-1.amazonaws.com/');}finally{f.db.close();}
});
test('CE rejects a response marked redirected even when status is 200',async()=>{
 const f=fixture();try{let calls=0;f.options.fetch=async()=>{calls++;const r=Response.json(activation(),{headers:{'x-amzn-requestid':'redirected-fixture'}});Object.defineProperty(r,'redirected',{value:true});return r;};assert.deepEqual(await f.reader().read(invocation,proof),{verifiedCostMicros:null,final:false});assert.equal(calls,1);}finally{f.db.close();}
});
