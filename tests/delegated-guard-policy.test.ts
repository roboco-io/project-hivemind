import assert from 'node:assert/strict';import test from 'node:test';
import {awsGuardPolicies,awsGuardDigest,type AwsGuardManifest} from '../packages/adapters/src/autonomous-aws-guard.js';
const base:AwsGuardManifest={schemaVersion:1,ownershipMode:'broker_uuid_registry_v1',registryTableArn:'arn:aws:dynamodb:ap-northeast-2:123456789012:table/guard-bindings',guardArn:'arn:aws:events:ap-northeast-2:123456789012:rule/guard',validUntil:2000000000000,profiles:[]};
const settings={accountId:'123456789012',region:'ap-northeast-2',guardArn:base.guardArn,functionArn:'arn:aws:lambda:ap-northeast-2:123456789012:function:guard',scheduleGroupArn:'arn:aws:scheduler:ap-northeast-2:123456789012:schedule-group/guard'};
test('optional guard delegated upload grants fixed S3 prefix and GSC without changing guard management deny',()=>{
 const legacy=awsGuardPolicies({...settings,manifest:base});const manifest={...base,delegatedUpload:{bucket:'approved-models',prefix:'tasks/t1/',maxScopedSeconds:60}};
 const enabled=awsGuardPolicies({...settings,manifest});assert.deepEqual(enabled.guard,legacy.guard);assert.deepEqual(enabled.scheduler,legacy.scheduler);
 assert.deepEqual(enabled.workload.policy.Statement[1],legacy.workload.policy.Statement[1]);const text=JSON.stringify(enabled.workload.policy);assert.ok(text.includes('s3:PutObject'));assert.ok(text.includes('sts:GetScopedCredentials'));assert.ok(text.includes('arn:aws:s3:::approved-models/tasks/t1/*'));assert.ok(text.includes('"sts:DurationSeconds":60'));assert.notEqual(awsGuardDigest(enabled.workload.policy),awsGuardDigest(legacy.workload.policy));
 assert.equal(JSON.stringify(legacy).includes('s3:PutObject'),false);
});
test('guard delegated extension rejects escaped scope invalid TTL and unknown options',()=>{
 for(const bad of [{bucket:'*',prefix:'tasks/',maxScopedSeconds:120},{bucket:'models-bucket',prefix:'../',maxScopedSeconds:120},{bucket:'models-bucket',prefix:'tasks/',maxScopedSeconds:121},{bucket:'models-bucket',prefix:'tasks/',maxScopedSeconds:0},{bucket:'models-bucket',prefix:'tasks/',maxScopedSeconds:120,extra:true}])assert.throws(()=>awsGuardPolicies({...settings,manifest:{...base,delegatedUpload:bad} as AwsGuardManifest}));
});
