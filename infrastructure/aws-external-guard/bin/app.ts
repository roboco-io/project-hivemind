import {App} from 'aws-cdk-lib';
import {readFileSync} from 'node:fs';
import {AwsExternalGuardStack,type GuardDeploymentConfig} from '../lib/guard-stack.ts';
const app=new App();const path=app.node.tryGetContext('config');
if(typeof path!=='string'||!path||process.env.AWS_PROFILE!=='roboco')throw Error('Supply --context config=/private/real-config.json and AWS_PROFILE=roboco; no account lookup is permitted');
const configuration=JSON.parse(readFileSync(path,'utf8')) as GuardDeploymentConfig;
if(configuration.accountId==='111111111111'||configuration.region!=='ap-northeast-2'||!/^\d{12}$/.test(configuration.accountId))throw Error('Real explicit account and ap-northeast-2 required');
new AwsExternalGuardStack(app,'HivemindAwsExternalGuard',{configuration,env:{account:configuration.accountId,region:configuration.region}});
app.synth();
