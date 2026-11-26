import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createHivemindMcpServer} from '../apps/mcp-server/src/server.js';
const workflowId='43c19f35-0f90-469e-8f20-0b5631d69131';
test('team MCP advertises explicit operator intent and only forwards bounded fixed operations',async t=>{
 const calls:{path:string;body:unknown}[]=[];
 const server=createHivemindMcpServer({apiUrl:'http://127.0.0.1:4310',operatorToken:'operator-private',fetchImpl:async(url,init={})=>{calls.push({path:new URL(String(url)).pathname+new URL(String(url)).search,body:init.body?JSON.parse(String(init.body)):undefined});return Response.json({id:'team',workflowId,status:'blocked',blocked:true,recoveryRequired:false,reviewed:false,endsAt:10000,taskCounts:{pending:1,claimed:0,submitted:0,verified:0,failed:0,recovery_required:0},block:{category:'identity_mismatch',reason:'operator-private',evidenceRef:'fixture'},leases:[{token:'private-lease'}]});}});
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'team-test',version:'1'});await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const tools=(await client.listTools()).tools;
 for(const op of ['get','block','review']){const tool=tools.find(x=>x.name==='hivemind_workflow_team_'+op);assert.ok(tool);assert.match(tool.description!,/운영자/);assert.equal(tool.annotations!.readOnlyHint,op==='get');}
 const result=await client.callTool({name:'hivemind_workflow_team_get',arguments:{workflowId}});assert.equal(result.isError,undefined);assert.doesNotMatch(JSON.stringify(result),/private-lease|operator-private/);
 const block=await client.callTool({name:'hivemind_workflow_team_block',arguments:{workflowId,category:'identity_mismatch',reason:'explicit operator block',evidenceRef:'fixture'}});assert.equal(block.isError,undefined);
 const review=await client.callTool({name:'hivemind_workflow_team_review',arguments:{workflowId,reason:'explicit review'}});assert.equal(review.isError,undefined);
 assert.deepEqual(calls.map(x=>x.path),['','/block','/review'].map(x=>'/api/cloudflare/workflows/'+workflowId+'/team'+x));
 const before=calls.length;assert.equal((await client.callTool({name:'hivemind_workflow_team_block',arguments:{workflowId,category:'identity_mismatch',reason:'x',evidenceRef:'fixture',memberId:'forged'}})).isError,true);assert.equal(calls.length,before);
});

test('public MCP note content and structured DTO redact escaped operator secrets and preserve normal data',async t=>{
 const operatorToken='local"operator\\credential';
 const server=createHivemindMcpServer({apiUrl:'http://127.0.0.1:4310',operatorToken,fetchImpl:async()=>Response.json({notes:[{source:'worker_report',sequence:1,at:1,memberId:'worker',text:'before '+JSON.stringify(operatorToken).slice(1,-1)+' after'},{source:'worker_report',sequence:2,at:2,memberId:'worker',text:'ordinary "quoted" path\\file'}],nextAfter:2})});
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'team-escaped-secret-test',version:'1'});await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const result=await client.callTool({name:'hivemind_workflow_team_get',arguments:{workflowId,section:'notes'}});
 assert.equal(result.isError,undefined);
 const expected={notes:[{source:'worker_report',sequence:1,at:1,memberId:'worker',text:'before [REDACTED] after'},{source:'worker_report',sequence:2,at:2,memberId:'worker',text:'ordinary "quoted" path\\file'}],nextAfter:2};
 assert.deepEqual(result.structuredContent,expected);
 assert.deepEqual(JSON.parse((result.content as {type:string;text:string}[])[0]!.text),expected);
});
