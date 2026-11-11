import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createCloudWorkflowControl} from '../packages/core/src/cloud-workflow-store.js';
import type {CloudWorkflowPort} from '../packages/contracts/src/workflow.js';
import {buildApp} from '../apps/control-plane/src/app.js';
import {createHivemindMcpServer} from '../apps/mcp-server/src/server.js';

const id='43c19f35-0f90-469e-8f20-0b5631d69131';
const contractHash='a'.repeat(64),inputSnapshotId='b'.repeat(64);
const draft={requestId:'8e082895-79c0-439d-b8c8-15cdc2e84165',title:'Contract workflow',baseCommit:'c'.repeat(40),
  contractPath:'CONTRACT.md',codex:{instructions:'add',writes:['add.mjs']},claude:{instructions:'multiply',writes:['multiply.mjs']}};

test('workflow registration and explicit approval survive central and MCP restart without resubmission',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'hivemind-workflow-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let drafts=0,approvals=0,status='DRAFT';
  const port:CloudWorkflowPort={
    async draft(){drafts++;return {id,contractHash,inputSnapshotId};},
    async approve(){approvals++;status='RUNNING';return {status};},
    async read(_binding,result,includeDiff){return {
      status,errorCode:null,outputSnapshotId:null,workers:[],integration:null,resultReady:result,
      actualCostMicros:null,diff:includeDiff?'+ verified change':null,privateKey:'private-sentinel',
    };},
  };
  async function open(){
    const control=createCloudWorkflowControl(join(dir,'workflows.sqlite'),'fixture-scope',port);
    const app=buildApp({workflows:control});
    const server=createHivemindMcpServer({apiUrl:'http://127.0.0.1:4310',operatorToken:'local-development-only',
      fetchImpl:async (url,init)=>{
        const headers:Record<string,string>={};
        new Headers(init?.headers).forEach((value,key)=>{headers[key]=value;});
        const result=await app.inject({method:init?.method==='POST'?'POST':'GET',url:String(url),
          headers,payload:init?.body as string|undefined});
        return new Response(result.body,{status:result.statusCode});
      }});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const client=new Client({name:'workflow-test',version:'1'});
    await server.connect(serverTransport);await client.connect(clientTransport);
    const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
    return {call,app,async close(){await client.close();await server.close();await app.close();}};
  }
  const first=await open();
  try {
    const denied=await first.app.inject({method:'GET',url:'/api/cloudflare/workflows',headers:{authorization:'Bearer local-worker-only'}});
    assert.equal(denied.statusCode,401);
    assert.equal((await first.call('hivemind_create_workflow',{...draft,contractPath:'../CONTRACT.md'})).isError,true);
    assert.equal((await first.call('hivemind_create_workflow',{...draft,claude:{...draft.claude,writes:['add.mjs']}})).isError,true);
    assert.equal(drafts,0);
    const created=await first.call('hivemind_create_workflow',draft);
    assert.equal(created.isError,undefined);assert.match(JSON.stringify(created),/"status":"DRAFT"/);
    assert.equal((await first.call('hivemind_approve_workflow',{workflowId:id,contractHash:'f'.repeat(64)})).isError,true);
    assert.equal(approvals,0);
    assert.equal((await first.call('hivemind_approve_workflow',{workflowId:id,contractHash})).isError,undefined);
    assert.equal(approvals,1);
  }finally{await first.close();}
  status='SUCCEEDED';
  const next=await open();
  try{
    const listing=await next.call('hivemind_list_workflows');
    assert.match(JSON.stringify(listing),new RegExp(id));
    const result=await next.call('hivemind_get_workflow',{workflowId:id,includeDiff:true,maxChars:8});
    assert.equal(result.isError,undefined);
    assert.match(JSON.stringify(result),/verifi/);
    assert.match(JSON.stringify(result),/"truncated":true/);
    assert.doesNotMatch(JSON.stringify(result),/private-sentinel/);
    assert.equal((await next.call('hivemind_create_workflow',draft)).isError,undefined);
    assert.equal(drafts,1);assert.equal(approvals,1);
  }finally{await next.close();}
});
