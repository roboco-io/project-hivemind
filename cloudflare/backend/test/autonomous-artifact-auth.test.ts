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
