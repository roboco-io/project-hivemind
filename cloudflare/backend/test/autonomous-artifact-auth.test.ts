import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAutonomousRoute} from '../src/cloudflare/api.ts';
const request=(token:string,suffix='')=>new Request(`https://fixture/v1/autonomous-tasks/task/external-artifact${suffix}`,{method:'POST',headers:{authorization:`Bearer ${token}`}});
test('external artifact route accepts only the worker role',()=>{
 for(const suffix of ['','/']){
  assert.equal(authorizeAutonomousRoute(request('worker',suffix),'operator','worker','reporter'),null);
  for(const token of ['operator','reporter',''])assert.equal(authorizeAutonomousRoute(request(token,suffix),'operator','worker','reporter')?.status,401);
 }
});
test('external artifact route fails closed for missing or overlapping operator and worker roles',()=>{
 for(const [operator,worker] of [[undefined,'worker'],['operator',undefined],['','worker'],['operator',''],[' ','worker'],['operator',' '],['same','same']]){
  assert.equal(authorizeAutonomousRoute(request(worker??''),operator,worker,'reporter')?.status,503);
 }
});
const route=(method:string,suffix:string,token:string)=>new Request(`https://fixture/v1/autonomous-tasks/task/${suffix}`,{method,headers:{authorization:`Bearer ${token}`}});
test('tool-calls POST takes the reporter token; GET takes the operator token; neither accepts the worker token',()=>{
 assert.equal(authorizeAutonomousRoute(route('POST','tool-calls','reporter'),'operator','worker','reporter'),null);
 for(const token of ['operator','worker',''])assert.equal(authorizeAutonomousRoute(route('POST','tool-calls',token),'operator','worker','reporter')?.status,401);
 assert.equal(authorizeAutonomousRoute(route('GET','tool-calls','operator'),'operator','worker','reporter'),null);
 for(const token of ['reporter','worker',''])assert.equal(authorizeAutonomousRoute(route('GET','tool-calls',token),'operator','worker','reporter')?.status,401);
 for(const [operator,worker,reporter] of [['operator','worker',undefined],['operator','worker','operator'],['operator','worker','worker'],['operator','worker','a b']])assert.equal(authorizeAutonomousRoute(route('POST','tool-calls','reporter'),operator,worker,reporter)?.status,503);
});
test('external-large routes accept only the worker role and fail closed without distinct roles',()=>{
 for(const step of ['begin','part','complete','abort','manifest']){
  assert.equal(authorizeAutonomousRoute(route('POST','external-large/'+step,'worker'),'operator','worker','reporter'),null);
  for(const token of ['operator','reporter',''])assert.equal(authorizeAutonomousRoute(route('POST','external-large/'+step,token),'operator','worker','reporter')?.status,401);
  assert.equal(authorizeAutonomousRoute(route('POST','external-large/'+step,'same'),'same','same','reporter')?.status,503);
 }
});
