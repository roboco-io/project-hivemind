import assert from 'node:assert/strict';
import test from 'node:test';
import {createDelegatedInstanceAuth,type DelegatedInstanceChallenge,type DelegatedOwnedInstance} from '../packages/adapters/src/delegated-instance-auth.js';
const time=Date.parse('2026-11-23T01:00:00Z');
const binding={taskId:'task',workloadId:'workload',revision:1,instanceId:'i-0123456789abcdef0',descriptorHash:'d'.repeat(64),accountId:'123456789012',region:'ap-northeast-2'};
const owned:DelegatedOwnedInstance={...binding,accountId:'123456789012',roleName:'TrainingRole',roleId:'AROA123456789EXAMPLE',region:'ap-northeast-2',active:true,expiresAt:time+600000,hfTokenRef:'hf:approved'};
function signed(c:DelegatedInstanceChallenge){const headers:Record<string,string>={
 'content-type':'application/x-www-form-urlencoded','host':'sts.ap-northeast-2.amazonaws.com','x-amz-date':'20261123T010000Z','x-amz-security-token':'temporary-session',
 'x-hivemind-audience':c.audience,'x-hivemind-nonce':c.nonce,'x-hivemind-purpose':c.purpose,
 ...(c.keyThumbprint?{'x-hivemind-key-thumbprint':c.keyThumbprint}:{}),
};const names=Object.keys(headers).sort().join(';');headers.authorization=`AWS4-HMAC-SHA256 Credential=ASIA123456789EXAMPLE/20261123/ap-northeast-2/sts/aws4_request, SignedHeaders=${names}, Signature=${'a'.repeat(64)}`;
return {method:'POST',url:'https://sts.ap-northeast-2.amazonaws.com/',headers,body:'Action=GetCallerIdentity&Version=2011-06-15'};}
function response(account=owned.accountId,session=binding.instanceId){return new Response(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${account}:assumed-role/${owned.roleName}/${session}</Arn><UserId>${owned.roleId}:${session}</UserId><Account>${account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>request</RequestId></ResponseMetadata></GetCallerIdentityResponse>`);}
function keyStore(){let key:string|undefined;return {read:async()=>key,register:async(_b:unknown,k:string)=>{if(key&&key!==k)return false;key=k;return true;}};}
function setup(){let now=time;let active=true;let calls=0;const keys=keyStore();const auth=createDelegatedInstanceAuth({bootstrapKeys:keys,audience:'https://control.example/instance',region:owned.region,now:()=>now,lookupOwnedInstance:async()=>({...owned,active}),fetch:async(url,init)=>{calls++;assert.equal(url,'https://sts.ap-northeast-2.amazonaws.com/');assert.equal(init?.redirect,'manual');return response();}});return {auth,pin:(k:string)=>keys.register(binding,k),get calls(){return calls;},setNow:(n:number)=>{now=n;},stop:()=>{active=false;}};}
test('central challenge authenticates only matching owned STS session and consumes once',async()=>{
 const s=setup();const c=await s.auth.issueChallenge(binding,'report');assert.match(c.nonce,/^[A-Za-z0-9_-]{43}$/);
 assert.deepEqual(await s.auth.authenticate({challengeId:c.id,request:signed(c)}),{...binding,purpose:'report',expiresAt:c.expiresAt});
 await assert.rejects(s.auth.authenticate({challengeId:c.id,request:signed(c)}),/instance authentication denied/);assert.equal(s.calls,1);
});
test('noncanonical endpoints, unsigned bindings, actions and clocks fail before any forwarding',async()=>{
 for(const alter of [
  (r:ReturnType<typeof signed>)=>{r.url='https://169.254.169.254/';},
  (r:ReturnType<typeof signed>)=>{r.url+='?Action=GetCallerIdentity';},
  (r:ReturnType<typeof signed>)=>{r.method='GET';},
  (r:ReturnType<typeof signed>)=>{r.body+='&Action=AssumeRole';},
  (r:ReturnType<typeof signed>)=>{r.headers['x-hivemind-audience']='https://other.example';},
  (r:ReturnType<typeof signed>)=>{r.headers.authorization=r.headers.authorization!.replace('x-hivemind-nonce;','');},
  (r:ReturnType<typeof signed>)=>{r.headers['x-amz-date']='20261123T005800Z';},
  (r:ReturnType<typeof signed>)=>{r.headers['X-Amz-Date']=r.headers['x-amz-date']!;},
  (r:ReturnType<typeof signed>)=>{r.headers['x-hivemind-nonce']='wrong';},
  (r:ReturnType<typeof signed>)=>{r.headers['x-hivemind-purpose']='bootstrap';},
  (r:ReturnType<typeof signed>)=>{r.headers['x-amz-security-token']='secret\r\nx-header: poison';},
 ]){const s=setup();const c=await s.auth.issueChallenge(binding,'report');const request=signed(c);alter(request);await assert.rejects(s.auth.authenticate({challengeId:c.id,request}),/^Error: instance authentication denied$/);assert.equal(s.calls,0);}
});
test('expired and cancelled instances cannot authenticate',async()=>{
 const s=setup();const c=await s.auth.issueChallenge(binding,'report');s.setNow(c.expiresAt);await assert.rejects(s.auth.authenticate({challengeId:c.id,request:signed(c)}));assert.equal(s.calls,0);
 const t=setup();const next=await t.auth.issueChallenge(binding,'bootstrap','k'.repeat(43));t.stop();await assert.rejects(t.auth.authenticate({challengeId:next.id,request:signed(next)}));assert.equal(t.calls,0);
});
test('STS wrong account/session/role ID and provider error text are never reflected',async()=>{
 for(const body of [await response('999999999999').text(),await response(owned.accountId,'i-11111111111111111').text(),(await response().text()).replace(owned.roleId,'AROAOTHERROLEIDEXAMPLE'),'secret provider error']){
  const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'https://control.example/instance',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>owned,fetch:async()=>new Response(body)});const c=await a.issueChallenge(binding,'report');await assert.rejects(a.authenticate({challengeId:c.id,request:signed(c)}),/^Error: instance authentication denied$/);
 }
});
test('one challenge cannot forward twice while STS is held',async()=>{
 let release:()=>void=()=>{};const held=new Promise<void>(r=>{release=r;});let count=0;
 const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'https://control.example/instance',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>owned,fetch:async()=>{count++;await held;return response();}});
 const c=await a.issueChallenge(binding,'report');const first=a.authenticate({challengeId:c.id,request:signed(c)});await assert.rejects(a.authenticate({challengeId:c.id,request:signed(c)}));release();await first;assert.equal(count,1);
});
test('oversized STS stream is cancelled before its complete body is buffered',async()=>{
 let cancelled=false;let reads=0;const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'https://control.example/instance',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>owned,fetch:async()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(16385));if(reads>3)c.close();},cancel(){cancelled=true;}}))});
 const c=await a.issueChallenge(binding,'report');await assert.rejects(a.authenticate({challengeId:c.id,request:signed(c)}));assert.equal(cancelled,true);assert.ok(reads<4);
});
test('parallel challenge admission reserves capacity before owned-instance lookup',async()=>{
 let checks=0;let release:()=>void=()=>{};const held=new Promise<void>(r=>{release=r;});const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'https://control.example/instance',region:owned.region,maxChallenges:2,now:()=>time,lookupOwnedInstance:async()=>{checks++;await held;return owned;},fetch:async()=>response()});
 const result=Promise.allSettled([a.issueChallenge(binding,'report'),a.issueChallenge(binding,'report'),a.issueChallenge(binding,'report')]);release();const r=await result;assert.equal(r.filter(i=>i.status==='fulfilled').length,2);assert.equal(checks,2);
});
test('RSA-OAEP delivery requires signed RFC7638 key thumbprint and exact scoped ref',async()=>{
 const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
 const full=await crypto.subtle.exportKey('jwk',keys.publicKey);const jwk={e:full.e!,kty:'RSA',n:full.n!};
 const thumbprint=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(jwk)))).toString('base64url');
 const s=setup();
 const bootstrap=await s.auth.issueChallenge(binding,'bootstrap',thumbprint);
 await s.auth.authenticate({challengeId:bootstrap.id,request:signed(bootstrap),publicKeyJwk:jwk});
 const c=await s.auth.issueChallenge(binding,'hf-token',thumbprint);
 const identity=await s.auth.authenticate({challengeId:c.id,request:signed(c),publicKeyJwk:jwk});
 assert.equal(await s.auth.authorize(identity,binding,'hf-token'),true);
 let calls=0;const envelope=await s.auth.deliverHfToken(identity,'hf:approved',async()=>{calls++;return 'hf_private_scoped_value';});
 assert.equal(calls,1);assert.ok(!JSON.stringify(envelope).includes('hf_private_scoped_value'));assert.equal(envelope.keyThumbprint,thumbprint);
 const value=await crypto.subtle.decrypt({name:'RSA-OAEP',label:new TextEncoder().encode(envelope.context)},keys.privateKey,Buffer.from(envelope.ciphertext,'base64url'));
 assert.equal(new TextDecoder().decode(value),'hf_private_scoped_value');
 await assert.rejects(s.auth.deliverHfToken(identity,'hf:approved',async()=>{calls++;return 'hf_again';}));assert.equal(calls,1);
});
test('wrong key and forged contexts fail without returning or resolving tokens',async()=>{
 const s=setup();let resolved=0;await assert.rejects(s.auth.deliverHfToken({...binding,purpose:'hf-token',expiresAt:time+1000},'hf:approved',async()=>{resolved++;return 'hf_secret';}));assert.equal(resolved,0);
 await s.pin('a'.repeat(43));const c=await s.auth.issueChallenge(binding,'hf-token','a'.repeat(43));await assert.rejects(s.auth.authenticate({challengeId:c.id,request:signed(c),publicKeyJwk:{kty:'RSA',e:'AQAB',n:'a'.repeat(342)}}));assert.equal(s.calls,0);
});
test('authenticated identity cannot cross descriptor, purpose or cancellation boundaries',async()=>{
 const s=setup();const c=await s.auth.issueChallenge(binding,'report');const identity=await s.auth.authenticate({challengeId:c.id,request:signed(c)});
 assert.equal(await s.auth.authorize({...identity},binding,'report'),false);assert.equal(await s.auth.authorize(identity,{...binding,descriptorHash:'b'.repeat(64)},'report'),false);
 assert.equal(await s.auth.authorize(identity,binding,'bootstrap'),false);s.stop();assert.equal(await s.auth.authorize(identity,binding,'report'),true);
});

test('HF key is pinned before use and cannot be replaced by another IAM-signed request',async()=>{
 const s=setup();await assert.rejects(s.auth.issueChallenge(binding,'hf-token','a'.repeat(43)));
 await s.pin('a'.repeat(43));await assert.rejects(s.auth.issueChallenge(binding,'hf-token','b'.repeat(43)));
 await assert.rejects(s.auth.issueChallenge(binding,'bootstrap','b'.repeat(43)));
 assert.equal(s.calls,0);
});
test('historical owned instance may report after execution expires without bootstrap or secret authority',async()=>{
 const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'central',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>({...owned,active:false,expiresAt:time-1}),fetch:async()=>response()});
 const c=await a.issueChallenge(binding,'report');assert.equal(c.expiresAt,time+60000);const identity=await a.authenticate({challengeId:c.id,request:signed(c)});assert.equal(await a.authorize(identity,binding,'report'),true);assert.equal(await a.authorize(identity,binding,'bootstrap'),false);
 await assert.rejects(a.issueChallenge(binding,'bootstrap','k'.repeat(43)));await assert.rejects(a.issueChallenge(binding,'hf-token','k'.repeat(43)));
});
test('malformed owned execution timestamps never create usable bootstrap authority',async()=>{
 const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'central',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>({...owned,expiresAt:Number.NaN}),fetch:async()=>response()});
 await assert.rejects(a.issueChallenge(binding,'bootstrap','k'.repeat(43)));
});
test('Workers-compatible manual redirect never forwards signed credentials to an attacker',async()=>{
 const urls:string[]=[];let mode='redirect';
 const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'central',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>owned,fetch:async(url,init)=>{
  if(init?.redirect==='error')throw new TypeError('Workers unsupported redirect mode');
  assert.equal(init?.redirect,'manual');urls.push(String(url));
  if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://attacker.example/steal'}});
  return response();
 }});
 const c=await a.issueChallenge(binding,'report');await assert.rejects(a.authenticate({challengeId:c.id,request:signed(c)}));assert.deepEqual(urls,['https://sts.ap-northeast-2.amazonaws.com/']);
 mode='success';const next=await a.issueChallenge(binding,'report');assert.equal((await a.authenticate({challengeId:next.id,request:signed(next)})).instanceId,binding.instanceId);
});
test('an already-followed STS response is rejected even with status 200',async()=>{
 const r=response();Object.defineProperty(r,'redirected',{value:true});const a=createDelegatedInstanceAuth({bootstrapKeys:keyStore(),audience:'central',region:owned.region,now:()=>time,lookupOwnedInstance:async()=>owned,fetch:async()=>r});const c=await a.issueChallenge(binding,'report');await assert.rejects(a.authenticate({challengeId:c.id,request:signed(c)}));
});
