import test from 'node:test';import assert from 'node:assert/strict';import {App} from 'aws-cdk-lib';import {Template} from 'aws-cdk-lib/assertions';
import {AwsExternalGuardStack,type GuardDeploymentConfig} from '../lib/guard-stack.ts';
import {awsGuardDigest,awsGuardPolicies} from '../../../packages/adapters/src/autonomous-aws-guard.ts';
const account='111111111111',region='us-east-2',prefix='fixture-delegated';
const config:GuardDeploymentConfig={accountId:account,region,allowedRegions:[region],resourcePrefix:prefix,controllerPrincipalArn:`arn:aws:iam::${account}:role/controller`,validUntil:2000000000000,profiles:[{workloadId:'train',configurationHash:'c'.repeat(64),parameterPolicy:'opaque_broker_sha256',launchHeadroomMs:1000,maxLifetimeMs:60000,quote:{source:'fixture',maxExposureMicros:100,validUntil:2000000000000}}],delegatedUpload:{bucket:'approved-models',prefix:'tasks/t1/',maxScopedSeconds:60}};
test('delegated role and permissions boundary synthesize the same attested S3 GSC policy',()=>{
 const stack=new AwsExternalGuardStack(new App(),'Delegated',{configuration:config,fixture:true,env:{account,region}});assert.deepEqual(stack.manifest.delegatedUpload,config.delegatedUpload);
 const resources=Object.values(Template.fromStack(stack).toJSON().Resources) as any[];const role=resources.find(r=>r.Type==='AWS::IAM::Role'&&r.Properties.RoleName===prefix+'-workload');const boundary=resources.find(r=>r.Type==='AWS::IAM::ManagedPolicy'&&r.Properties.ManagedPolicyName===prefix+'-workload');
 const expected=awsGuardPolicies({accountId:account,region,guardArn:stack.manifest.guardArn,functionArn:`arn:aws:lambda:${region}:${account}:function:${prefix}`,scheduleGroupArn:`arn:aws:scheduler:${region}:${account}:schedule-group/${prefix}`,manifest:stack.manifest}).workload.policy;
 assert.deepEqual(role.Properties.Policies[0].PolicyDocument,expected);assert.deepEqual(boundary.Properties.PolicyDocument,expected);assert.equal(stack.workloadPolicySha256,awsGuardDigest(expected));
 const guard=resources.find(r=>r.Type==='AWS::IAM::Role'&&r.Properties.RoleName===prefix+'-guard');assert.equal(JSON.stringify(guard).includes('s3:'),false);assert.equal(JSON.stringify(guard).includes('sts:GetScopedCredentials'),false);
});
test('delegated config validates scope before producing deployable resources',()=>{
 for(const delegatedUpload of [{bucket:'*',prefix:'tasks/',maxScopedSeconds:120},{bucket:'approved-models',prefix:'tasks/',maxScopedSeconds:121}])assert.throws(()=>new AwsExternalGuardStack(new App(),'Invalid',{configuration:{...config,delegatedUpload},fixture:true,env:{account,region}}));
});
