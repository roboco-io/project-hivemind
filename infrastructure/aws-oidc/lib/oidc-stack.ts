import {CfnOutput,Stack,type StackProps,aws_iam as iam} from 'aws-cdk-lib';
import type {Construct} from 'constructs';
import {validateOidcIssuer} from '../../../packages/core/src/oidc.ts';
import {assertAwsRegion} from '../../../packages/adapters/src/autonomous-aws-region.ts';
export interface AwsOidcDeploymentConfig {accountId:string;region:string;allowedRegions?:readonly string[];issuer:string;audience:string;rolePrefix:string;executeSubjects:string[];cleanupSubjects:string[];executePolicy:Record<string,unknown>;cleanupPolicy:Record<string,unknown>}
const fail=()=>new Error('Explicit OIDC IAM configuration required');
function check(v:unknown):asserts v {if(!v)throw fail();}
const cleanupActions=new Set(['ec2:TerminateInstances','ec2:DeleteVolume','ec2:CancelSpotInstanceRequests','ec2:DescribeInstances','ec2:DescribeSpotInstanceRequests','ec2:DescribeVolumes','s3:GetObject','s3:GetObjectVersion','s3:GetBucketAcl','s3:GetObjectAcl','s3:GetObjectVersionAcl','s3:GetObjectAttributes','s3:GetObjectVersionAttributes','s3:ListBucket','s3:DeleteObjectVersion','ce:GetCostAndUsage','ce:GetTags','iam:GetRole','iam:GetRolePolicy','iam:GetPolicy','iam:GetPolicyVersion','lambda:GetFunction','events:DescribeRule','events:ListTargetsByRule','scheduler:GetSchedule','dynamodb:GetItem','dynamodb:DescribeTable']);
function policy(document:Record<string,unknown>,cleanup:boolean){
 check(document&&Object.keys(document).every(k=>['Version','Statement'].includes(k))&&document.Version==='2012-10-17'&&Array.isArray(document.Statement)&&document.Statement.length>0&&document.Statement.length<=16);
 for(const raw of document.Statement){
  check(raw&&typeof raw==='object'&&!Array.isArray(raw));const s=raw as Record<string,unknown>;
  check(Object.keys(s).every(k=>['Sid','Effect','Action','Resource','Condition'].includes(k))&&s.Effect==='Allow');
  const actions=Array.isArray(s.Action)?s.Action:[s.Action],resources=Array.isArray(s.Resource)?s.Resource:[s.Resource];
  check(actions.length>0&&resources.length>0&&actions.every(a=>typeof a==='string'&&/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(a)&&!a.startsWith('sts:')&&(!cleanup||cleanupActions.has(a))));
  check(resources.every(r=>typeof r==='string'&&(r.startsWith('arn:aws:')&&!/[\s\p{Cc}]/u.test(r)||r==='*'&&actions.every(a=>/:(?:Describe|Get|List)/.test(String(a))))));
  if(s.Condition!==undefined)check(s.Condition&&typeof s.Condition==='object'&&!Array.isArray(s.Condition));
 }
 return document.Statement;
}
/** Synth-only template: all account, issuer, subjects and permissions are explicit inputs. */
export class AwsOidcStack extends Stack {
 constructor(scope:Construct,id:string,props:StackProps&{configuration:AwsOidcDeploymentConfig}){
  super(scope,id,props);const c=structuredClone(props.configuration);
  check(Object.keys(c).every(k=>['accountId','region','allowedRegions','issuer','audience','rolePrefix','executeSubjects','cleanupSubjects','executePolicy','cleanupPolicy'].includes(k)));
  assertAwsRegion(c.region,c.allowedRegions);validateOidcIssuer(c.issuer);
  check(/^\d{12}$/.test(c.accountId)&&this.account===c.accountId&&this.region===c.region&&/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(c.rolePrefix)&&typeof c.audience==='string'&&c.audience.length>=1&&c.audience.length<=255&&!/[\s\p{Cc}*?]/u.test(c.audience));
  for(const [subjects,purpose] of [[c.executeSubjects,'execute'],[c.cleanupSubjects,'(?:cleanup|inspect)']] as const){
   check(Array.isArray(subjects)&&subjects.length>=1&&subjects.length<=8&&new Set(subjects).size===subjects.length);
   check(subjects.every(s=>typeof s==='string'&&new RegExp(`^hivemind:task:[a-f0-9]{64}:rev:[1-9][0-9]{0,14}:profile:[a-f0-9]{64}:${purpose}$`).test(s)));
  }
  const execute=policy(c.executePolicy,false),cleanup=policy(c.cleanupPolicy,true);
  const provider=new iam.CfnOIDCProvider(this,'Issuer',{url:c.issuer,clientIdList:[c.audience]});
  const conditionKey=c.issuer.slice('https://'.length);
  for(const [purpose,statements,subjects] of [['execute',execute,c.executeSubjects],['cleanup',cleanup,c.cleanupSubjects]] as const){
   const role=new iam.CfnRole(this,purpose+'Role',{roleName:c.rolePrefix+'-'+purpose,maxSessionDuration:3600,assumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:'sts:AssumeRoleWithWebIdentity',Principal:{Federated:provider.attrArn},Condition:{StringEquals:{[conditionKey+':aud']:c.audience,[conditionKey+':sub']:subjects}}}]},policies:[{policyName:'approved-'+purpose,policyDocument:{Version:'2012-10-17',Statement:[...statements,{Effect:'Allow',Action:'sts:GetScopedCredentials',Resource:'*',Condition:{NumericLessThanEquals:{'sts:DurationSeconds':120},Null:{'sts:DurationSeconds':'false'}}}]}}]});
   new CfnOutput(this,purpose+'RoleArn',{value:role.attrArn});
  }
  new CfnOutput(this,'IssuerArn',{value:provider.attrArn});
 }
}
