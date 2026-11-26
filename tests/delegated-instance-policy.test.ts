import assert from 'node:assert/strict';
import test from 'node:test';
import {buildDelegatedInstancePolicy} from '../packages/adapters/src/delegated-instance-policy.js';
const input={accountId:'123456789012',region:'us-east-2',bucket:'approved-models',prefix:'tasks/t1/',policyRevision:'v1',inputVersions:[{key:'tasks/t1/input.json',versionId:'exact-version'}]};
test('instance policy fixes S3 scope versions region and maximum scoped session TTL',()=>{
 const result=buildDelegatedInstancePolicy(input);assert.equal(result.policy.Version,'2012-10-17');assert.match(result.policyHash,/^[a-f0-9]{64}$/);
 const text=JSON.stringify(result.policy);assert.ok(text.includes('arn:aws:s3:::approved-models/tasks/t1/*'));assert.ok(text.includes('exact-version'));assert.ok(text.includes('s3:VersionId'));assert.ok(text.includes('aws:RequestedRegion'));assert.ok(text.includes('sts:GetScopedCredentials'));assert.ok(text.includes('sts:DurationSeconds'));assert.ok(text.includes('120'));
 assert.ok(result.policy.Statement.some(s=>s.Effect==='Deny'&&s.NotAction));
 const scoped=JSON.stringify(result.scopePolicy);assert.ok(!scoped.includes('sts:'));assert.ok(!scoped.includes('GetObjectVersion'));assert.ok(!scoped.includes('iam:'));
 assert.notEqual(buildDelegatedInstancePolicy({...input,policyRevision:'v2'}).policyHash,result.policyHash);
});
test('policy builder rejects IAM wildcard and path escape configuration',()=>{
 for(const changed of [{bucket:'*'},{prefix:'tasks/*/'},{prefix:'../x/'},{prefix:'tasks/'+'x'.repeat(1000)+'/'},{region:'bad/region'},{accountId:'*'},{inputVersions:[{key:'outside/input',versionId:'*'}]}])assert.throws(()=>buildDelegatedInstancePolicy({...input,...changed}));
});
test('explicit deny guards prevent other policies from granting unapproved input versions',()=>{
 const r=buildDelegatedInstancePolicy(input);const guards=r.policy.Statement.filter(s=>s.Effect==='Deny');assert.ok(guards.some(s=>s.Sid==='DenyUnapprovedInputKey'));assert.ok(guards.some(s=>String(s.Sid).startsWith('DenyUnapprovedInputVersion')));
 const noInputs=buildDelegatedInstancePolicy({...input,inputVersions:[]});assert.ok(noInputs.policy.Statement.some(s=>s.Sid==='DenyAllInputReads'&&s.Action==='s3:GetObjectVersion'&&s.Effect==='Deny'));
});
