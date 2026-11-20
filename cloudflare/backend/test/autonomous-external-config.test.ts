import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createAutonomousExternalRuntime} from '../src/autonomous-external.ts';

// Local SQL and fake buckets only. No provider request is made.
const account='123456789012';
function sqlPort(){
 const db=new DatabaseSync(':memory:');
 return {exec(query:string,...bindings:(string|number|null)[]){const st=db.prepare(query);const result=st.columns().length?st.all(...bindings):(st.run(...bindings),[]);return Object.assign(result,{toArray(){return [...result];}});},transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
const base={maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1,enabled:true};
const s3Target={accountId:account,region:'ap-northeast-2',bucket:'hivemind-fixture',prefix:'runs/',maxObjectBytes:1024,retentionDays:30};
const lfs={maxFileBytes:1024**3,maxTotalBytes:2*1024**3,uploadHosts:['cdn-lfs.example.test']};
function config(over:{s3?:object;hf?:object;hfTarget?:object;ops?:string[]}={}){
 return {version:1,profiles:[
  {...base,id:'s3',provider:'s3',target:{...s3Target,...over.s3},operations:['aws.s3.put','aws.s3.inspect'],credentialRef:'aws-ref'},
  {...base,id:'hf',provider:'hf',target:{repository:'org/model',revision:'main',...over.hfTarget},operations:over.ops??['hf.model.commit','hf.model.lfs_commit'],credentialRef:'hf-ref'},
 ],providers:{s3:{enabled:true,target:{...s3Target,...over.s3}},hf:{enabled:true,repository:'org/model',revision:'main',lfs,...over.hf}}};
}
const credentials={'aws-ref':{provider:'aws',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'},'hf-ref':{provider:'hf',token:'fixture-token-value'}};
const multipartBucket={async get(){return null;},async put(){return {};},async createMultipartUpload(){return {uploadId:'u'};},resumeMultipartUpload(){return {async uploadPart(){return {etag:'e'};},async complete(){return {};},async abort(){return {};}};},async delete(){return {};}};
const make=(cfg:unknown,creds:unknown=credentials,bucket:unknown=multipartBucket)=>createAutonomousExternalRuntime({env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(cfg),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify(creds)},core:{execute:async()=>({})} as never,sql:sqlPort(),artifacts:bucket as never})!;

test('s3 profile with the aws credential shape is enabled; a non-aws credential leaves it disabled',()=>{
 const only=(c:any)=>({...c,profiles:[c.profiles[0]],providers:{s3:c.providers.s3}});
 assert.equal(make(only(config())).enabled,true);
 assert.equal(make(only(config()),{'aws-ref':{provider:'hf',token:'fixture-token-value'}}).enabled,false);
 assert.equal(make(config()).enabled,true);
});
test('invalid s3 targets and unsafe hf settings make the configuration unavailable',()=>{
 assert.throws(()=>make(config({s3:{bucket:'dotted.bucket'}})),/unavailable/);
 assert.throws(()=>make(config({s3:{prefix:'runs'}})),/unavailable/);
 assert.throws(()=>make({...config(),providers:{...config().providers,s3:{enabled:true,target:{...s3Target,bucket:'other-bucket'}}}}),/unavailable/);
 assert.throws(()=>make(config({hfTarget:{visibility:'public'}})),/unavailable/);
 assert.throws(()=>make(config({hfTarget:{visibility:'Public'},hf:{visibility:'Public'}})),/unavailable/);
 assert.throws(()=>make(config({hfTarget:{visibility:'public'},hf:{visibility:'public'}})),/unavailable/,'public repository may not offer large commits');
 assert.doesNotThrow(()=>make(config({hfTarget:{visibility:'public'},hf:{visibility:'public',lfs:undefined},ops:['hf.model.commit']})));
 assert.throws(()=>make(config({hf:{lfs:undefined}})),/unavailable/,'lfs_commit without providers.hf.lfs');
 assert.throws(()=>make(config({hf:{lfs:{...lfs,uploadHosts:['huggingface.co']}}})),/unavailable/);
 assert.throws(()=>make(config({hf:{lfs:{...lfs,maxFileBytes:6*1024**3,maxTotalBytes:7*1024**3}}})),/unavailable/);
 assert.throws(()=>make(config({hf:{lfs:{...lfs,uploadHosts:[]}}})),/unavailable/);
 assert.throws(()=>make(config({hf:{lfs:{...lfs,extra:1}}})),/unavailable/);
});
test('profile count is capped at four and each provider appears once',()=>{
 const c=config() as any;
 c.profiles.push({...base,id:'github',provider:'github',target:{repository:'org/repo',branch:'main'},operations:['github.branch.push'],credentialRef:'gh-ref'});c.providers.github={enabled:true,repository:'org/repo',branch:'main'};
 c.profiles.push({...base,id:'aws',provider:'aws',target:{accountId:account,region:'ap-northeast-2',workloadId:'w'},operations:['aws.spot.start'],credentialRef:'aws-ref'});
 c.providers.aws={enabled:true,accountId:account,region:'ap-northeast-2',workloadId:'w',imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:'arn:aws:iam::'+account+':instance-profile/x',maxLifetimeMs:60000,credentialRef:'aws-ref',maxUpperBoundMicros:10,billingPolicy:'reserved_ceiling_only'};
 c.ttlGuard={guardArn:'arn:aws:events:ap-northeast-2:'+account+':rule/g'};
 assert.doesNotThrow(()=>make(c,{...credentials,'gh-ref':{provider:'github',token:'fixture-gh-token'}}));
 c.profiles.push({...c.profiles[0],id:'s3b'});
 assert.throws(()=>make(c),/unavailable/);
});
test('every new setting changes the configuration fingerprint',()=>{
 const f=(cfg:unknown)=>make(cfg).configurationFingerprint,original=f(config());
 for(const changed of [config({s3:{retentionDays:31}}),config({s3:{kmsKeyId:'alias/fixture'}}),config({s3:{maxObjectBytes:2048}}),config({hf:{lfs:{...lfs,uploadHosts:['other.example.test']}}}),config({hf:{lfs:{...lfs,maxFileBytes:1024**2}}}),config({hf:{lfs:{...lfs,maxTotalBytes:3*1024**3}}}),config({hf:{visibility:'private'},hfTarget:{visibility:'private'}})])assert.notEqual(f(changed),original);
});
test('large wiring exists only with lfs settings and a multipart bucket',()=>{
 assert.ok(make(config()).large);
 assert.equal(make(config(),credentials,{async get(){return null;},async put(){return {};}}).large,undefined);
 assert.equal(make(config({hf:{lfs:undefined},ops:['hf.model.commit']})).large,undefined);
});
