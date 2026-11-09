import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProviderResult} from '../src/runtime/providers.ts';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import type {ProcessResult} from '../src/contracts.ts';
const nonce='0123456789abcdef0123456789abcdef',marker='hivemind-phase0-mcp-v1';
const processResult=(events:unknown[]):ProcessResult=>({status:'passed',exitCode:0,stdout:events.map(e=>JSON.stringify(e)).join('\n'),stderr:'',durationMs:1,truncated:false});
const codex=(patch:Record<string,unknown>={})=>({type:'item.completed',item:{id:'item_7',type:'mcp_tool_call',server:'phase0',tool:'phase0_probe',status:'completed',error:null,result:{structured_content:{nonce,marker,private:'never export'}},arguments:{nonce,private:'never export'},...patch}});
const use=(id='toolu_1',value=nonce)=>({type:'assistant',message:{content:[{type:'tool_use',id,name:'mcp__phase0__phase0_probe',input:{nonce:value,private:'never export'}}]}});
const returned=(id='toolu_1',value=nonce,error=false)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error:error,content:[{type:'text',text:JSON.stringify({content:[{type:'text',text:JSON.stringify({nonce:value,marker,private:'never export'})}]})}]}]}});
const receipts=(provider:'codex'|'claude',events:unknown[])=>(parseProviderResult(provider,processResult(events)) as {mcpReceipts?:unknown[]}).mcpReceipts??[];
test('Codex exports only the fixed successful MCP receipt fields',()=>{assert.deepEqual(receipts('codex',[codex(),{type:'turn.completed'}]),[{callId:'item_7',nonce,marker}]);});
test('Codex rejects failed, unrelated and malformed MCP claims',()=>{
 for(const patch of [{server:'other'},{tool:'other'},{status:'failed'},{error:{message:'failed'}},{error:undefined},{id:''},{result:{structured_content:{nonce:'not-hex',marker}}},{result:{structured_content:{nonce,marker:'wrong'}}},{arguments:{nonce:'f'.repeat(32)}},{result:{isError:true,structured_content:{nonce,marker}}}])assert.deepEqual(receipts('codex',[codex(patch),{type:'turn.completed'}]),[],JSON.stringify(patch));
 assert.deepEqual(receipts('codex',[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({nonce,marker})}},{type:'turn.completed'}]),[]);
});
test('Claude links the fixed tool call to the successful matching returned JSON receipt',()=>{assert.deepEqual(receipts('claude',[use(),returned(),{type:'result',subtype:'success',is_error:false,result:'done'}]),[{callId:'toolu_1',nonce,marker}]);});
test('Claude rejects unlinked, failed, mismatched and malformed MCP claims',()=>{
 for(const events of [[returned()],[returned(),use()],[use(),returned('other')],[use(),returned('toolu_1','f'.repeat(32))],[use(),returned('toolu_1',nonce,true)],[use('toolu_1','not-hex'),returned()],[{type:'assistant',message:{content:[{type:'tool_use',id:'toolu_1',name:'other',input:{nonce}}]}},returned()],[use(),{type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_1',content:JSON.stringify({nonce,marker,isError:true})}]}}],[use(),{type:'assistant',message:{content:[{type:'text',text:JSON.stringify({nonce,marker})}]}}]])assert.deepEqual(receipts('claude',events),[]);
});
test('runtime preserves safe MCP receipts after discarding raw native tool events',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-mcp-receipt-'));try{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),cli=join(dir,'fake.cjs'),events=[codex(),{type:'turn.completed'}];
  await writeFile(cli,`#!${process.execPath}\nfor(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`,{mode:0o755});
  const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh'}});
  const value=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'codex',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:5000,auth,authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{codex:cli}});
  assert.equal(value.process.status,'passed');assert.deepEqual(value.mcpReceipts,[{callId:'item_7',nonce,marker}]);assert.equal(value.process.stdout,'');assert.ok(!JSON.stringify(value).includes('never export'));assert.ok(!JSON.stringify(value).includes('fixture-access'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
