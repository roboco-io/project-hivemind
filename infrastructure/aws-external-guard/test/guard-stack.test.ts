import test from 'node:test';
import assert from 'node:assert/strict';
import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AwsExternalGuardStack,type GuardDeploymentConfig} from '../lib/guard-stack.ts';
// FIXTURE account only. synth assertions perform no account lookup or AWS call.
const account='111111111111';
const config:GuardDeploymentConfig={accountId:account,region:'ap-northeast-2',resourcePrefix:'fixture-hivemind',controllerPrincipalArn:`arn:aws:iam::${account}:role/fixture-controller`,validUntil:1795219200000,profiles:[{workloadId:'fixture-workload',configurationHash:'c'.repeat(64),parameterPolicy:'opaque_broker_sha256',launchHeadroomMs:30000,maxLifetimeMs:3600000,quote:{source:'SYNTHETIC user quote',maxExposureMicros:100,validUntil:1795219200000}}]};
test('FIXTURE synth has external minute rule, scoped boundaries and no workload escape',()=>{
 const app=new App();const stack=new AwsExternalGuardStack(app,'Fixture',{configuration:config,fixture:true,env:{account,region:'ap-northeast-2'}});const template=Template.fromStack(stack);template.resourceCountIs('AWS::Events::Rule',1);template.hasResourceProperties('AWS::Events::Rule',{Name:'fixture-hivemind',EventBusName:'default',State:'ENABLED',ScheduleExpression:'rate(1 minute)'});
 template.resourceCountIs('AWS::Scheduler::ScheduleGroup',1);template.resourceCountIs('AWS::EC2::Instance',0);template.resourceCountIs('AWS::DynamoDB::Table',1);template.hasResourceProperties('AWS::DynamoDB::Table',{DeletionProtectionEnabled:true,KeySchema:[{AttributeName:'owner',KeyType:'HASH'}]});template.resourceCountIs('AWS::Scheduler::Schedule',0);
 template.hasResourceProperties('AWS::Lambda::Permission',{Principal:'events.amazonaws.com',SourceAccount:account,SourceArn:`arn:aws:events:ap-northeast-2:${account}:rule/fixture-hivemind`});
 const resources=template.toJSON().Resources as Record<string,any>;
 const roles=Object.values(resources).filter(r=>r.Type==='AWS::IAM::Role');assert.equal(roles.length,4);for(const role of roles)assert.ok(role.Properties.PermissionsBoundary);
 const workload=roles.find(r=>r.Properties.RoleName==='fixture-hivemind-workload')!;const workloadPolicy=JSON.stringify(workload.Properties.Policies);assert.match(workloadPolicy,/"Deny"/);assert.match(workloadPolicy,/events:\*/);assert.match(workloadPolicy,/sts:AssumeRole/);assert.match(workloadPolicy,/RunInstances/);
 const scheduler=roles.find(r=>r.Properties.RoleName==='fixture-hivemind-scheduler')!;assert.match(JSON.stringify(scheduler.Properties.AssumeRolePolicyDocument),/aws:SourceArn/);assert.match(JSON.stringify(scheduler.Properties.AssumeRolePolicyDocument),/schedule-group\/fixture-hivemind/);
 const guard=roles.find(r=>r.Properties.RoleName==='fixture-hivemind-guard')!;assert.match(JSON.stringify(guard.Properties.Policies),/ec2:ResourceTag\/hivemind:guard/);assert.match(JSON.stringify(guard.Properties.Policies),/ec2:TerminateInstances/);assert.match(JSON.stringify(guard.Properties.Policies),/ec2:ResourceTag\/hivemind:owner/);assert.match(JSON.stringify(guard.Properties.Policies),/dynamodb:GetItem/);assert.doesNotMatch(JSON.stringify(guard.Properties.Policies),/dynamodb:PutItem/);assert.equal(JSON.stringify(resources).includes('fixture-owner'),false);
 const controller=roles.find(r=>r.Properties.RoleName==='fixture-hivemind-admission')!;const statements=controller.Properties.Policies[0].PolicyDocument.Statement;const pass=statements.find((s:any)=>s.Action.includes('iam:PassRole'));assert.deepEqual(pass.Resource,[`arn:aws:iam::${account}:role/fixture-hivemind-scheduler`]);assert.equal(pass.Condition.StringEquals['iam:PassedToService'],'scheduler.amazonaws.com');
 assert.equal(app.synth().stacks.length,1);
});
test('deployment refuses guessed account/region/controller and excessive environment config',()=>{
 for(const bad of [{accountId:''},{region:'us-east-1'},{controllerPrincipalArn:''},{resourcePrefix:'bad/name'}])assert.throws(()=>new AwsExternalGuardStack(new App(),'Bad',{configuration:{...config,...bad} as GuardDeploymentConfig,fixture:true,env:{account,region:'ap-northeast-2'}}));
 assert.throws(()=>new AwsExternalGuardStack(new App(),'Real',{configuration:config,env:{account,region:'ap-northeast-2'}}));
});
test('R11 guard EBS permissions are read-only discovery plus tag-scoped deletion; workload cannot mutate EC2',()=>{
 const stack=new AwsExternalGuardStack(new App(),'EbsFixture',{configuration:config,fixture:true,env:{account,region:'ap-northeast-2'}});const resources=Object.values(Template.fromStack(stack).toJSON().Resources) as any[];
 const guard=resources.find(r=>r.Type==='AWS::IAM::Role'&&r.Properties.RoleName==='fixture-hivemind-guard')!;
 const statements=guard.Properties.Policies[0].PolicyDocument.Statement;
 const describe=statements.find((s:any)=>s.Action.includes('ec2:DescribeVolumes'));assert.ok(describe);assert.deepEqual(describe.Resource,['*']);
 const deletion=statements.find((s:any)=>s.Action.includes('ec2:DeleteVolume'));assert.ok(deletion);assert.deepEqual(deletion.Resource,[`arn:aws:ec2:ap-northeast-2:${account}:volume/*`]);
 const termination=statements.find((s:any)=>s.Action.includes('ec2:TerminateInstances'));assert.deepEqual(deletion.Condition,termination.Condition);assert.equal(deletion.Condition.StringEquals['ec2:ResourceTag/hivemind:guard'],`arn:aws:events:ap-northeast-2:${account}:rule/fixture-hivemind`);assert.equal(deletion.Condition.Null['ec2:ResourceTag/hivemind:owner'],'false');
 assert.equal(statements.some((s:any)=>s.Action.includes('ec2:DetachVolume')||s.Action.includes('ec2:AttachVolume')),false);
 const workload=resources.find(r=>r.Type==='AWS::IAM::Role'&&r.Properties.RoleName==='fixture-hivemind-workload')!;assert.equal(workload.Properties.Policies[0].PolicyDocument.Statement.filter((s:any)=>s.Effect==='Allow').some((s:any)=>s.Action.some((a:string)=>a.startsWith('ec2:'))),false);
 const boundaries=resources.filter(r=>r.Type==='AWS::IAM::ManagedPolicy');const boundary=boundaries.find(r=>r.Properties.ManagedPolicyName==='fixture-hivemind-guard')!;assert.deepEqual(boundary.Properties.PolicyDocument,guard.Properties.Policies[0].PolicyDocument);
});
