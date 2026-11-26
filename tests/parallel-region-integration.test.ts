import test from 'node:test';
import assert from 'node:assert/strict';
import {externalAwsConfigurationHash} from '../packages/adapters/src/autonomous-external.ts';
import {createAutonomousExternalRuntime} from '../cloudflare/backend/src/autonomous-external.ts';
import {DatabaseSync} from 'node:sqlite';
const accountId='123456789012';
function configuration(region='ap-northeast-2',extra:object={}){
 const aws={enabled:true,accountId,region,workloadId:'train',imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:`arn:aws:iam::${accountId}:instance-profile/train`,maxLifetimeMs:60000,credentialRef:'aws',maxUpperBoundMicros:10,billingPolicy:'reserved_ceiling_only',...extra};
 return {version:1,profiles:[{id:'aws',enabled:true,provider:'aws',target:{accountId,region,workloadId:'train'},operations:['aws.spot.start'],credentialRef:'aws',maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1}],providers:{aws},ttlGuard:{guardArn:`arn:aws:events:${region}:${accountId}:rule/guard`}};
}
function make(config:unknown){const db=new DatabaseSync(':memory:');return createAutonomousExternalRuntime({env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({aws:{provider:'aws',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'}})},core:{execute:async()=>({})} as never,sql:{exec(q:string,...b:(string|number|null)[]){const s=db.prepare(q);return s.columns().length?s.all(...b):(s.run(...b),[]);},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}},artifacts:{async get(){return null;}},awsTtlGuard:{async attest(){throw Error('unused');},async arm(){throw Error('unused');}}})!;}
test('region integration admits explicit Ohio and denies omitted allowlist outside Seoul',()=>{
 assert.throws(()=>make(configuration('us-east-2')),/unavailable/);
 assert.equal(make(configuration('us-east-2',{allowedRegions:['ap-northeast-2','us-east-2'],availabilityZoneId:'use2-az1'})).enabled,true);
 assert.throws(()=>make(configuration('us-west-2',{allowedRegions:['ap-northeast-2','us-east-2']})),/unavailable/);
});
test('AZ binding changes launch hash while omitted optional values preserve legacy hash',()=>{
 const aws=configuration().providers.aws;
 const old=externalAwsConfigurationHash(aws as never);
 assert.equal(externalAwsConfigurationHash({...aws,allowedRegions:['ap-northeast-2']} as never),old);
 assert.notEqual(externalAwsConfigurationHash({...aws,availabilityZoneId:'apne2-az1'} as never),old);
 assert.notEqual(externalAwsConfigurationHash({...aws,availabilityZoneId:'apne2-az1'} as never),externalAwsConfigurationHash({...aws,availabilityZoneId:'apne2-az2'} as never));
});
test('OIDC-only config participates in availability and approval metadata without long keys',async()=>{
 const config=configuration(),db=new DatabaseSync(':memory:');
 const policy=JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['ec2:DescribeInstances'],Resource:'*'}]});
 const {createHash}=await import('node:crypto');const policyHash=createHash('sha256').update(policy).digest('hex');
 const oidc={version:1,oidc:{issuer:'https://issuer.example.org',audience:'hivemind',roles:{aws:{executeRoleArn:`arn:aws:iam::${accountId}:role/execute`,cleanupRoleArn:`arn:aws:iam::${accountId}:role/cleanup`}}},scoping:{aws:Object.fromEntries(['execute','inspect','cleanup'].map(p=>[p,{policy,policyHash,durationSeconds:60}]))}};
 const core={execute:async()=>({id:'task',revision:1,spec:{externalProfiles:['aws']}})} as never;
 const runtime=createAutonomousExternalRuntime({env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_OIDC_CONFIG:JSON.stringify(oidc)} as never,oidcSigner:{async sign(){throw Error('must not sign approval preview');}},core,sql:{exec(q:string,...b:(string|number|null)[]){const s=db.prepare(q);return s.columns().length?s.all(...b):(s.run(...b),[]);},transactionSync:<T>(fn:()=>T)=>fn()},artifacts:{async get(){return null;}},awsTtlGuard:{async attest(){throw Error('unused');},async arm(){throw Error('unused');}}} as never)!;
 assert.equal(runtime.enabled,true);
 const profiles=await runtime.service.profiles('task');assert.equal(profiles[0]!.oidc?.execute.roleArn,oidc.oidc.roles.aws.executeRoleArn);assert.equal(profiles[0]!.oidc?.execute.policyHash,policyHash);assert.match(profiles[0]!.oidc!.execute.subject,/:execute$/);assert.doesNotMatch(JSON.stringify(profiles),/Statement|private-key|sessionToken/);
});
