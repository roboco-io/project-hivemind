import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTerraGateway,terraCredential,terraEndpoint} from '../src/terra-gateway.ts';

const capability='hmb_'+'a'.repeat(64);
const input={model:'gpt-6.1-terra',reasoning:{effort:'medium'},stream:true,store:false,input:[],tools:[]};
const credential={access:'subscription-fixture',accountId:'account-fixture',expires:Date.now()+60_000};
const usage={input_tokens:123,output_tokens:45,total_tokens:168,input_tokens_details:{cached_tokens:23},output_tokens_details:{reasoning_tokens:5}};
const request=(body=input)=>new Request(terraEndpoint,{method:'POST',body:JSON.stringify(body),headers:{authorization:'Bearer '+capability}});
const frame=(response:unknown)=>'data: '+JSON.stringify({type:'response.completed',response})+'\n\n';

test('Terra OAuth must name the authorized campaign request',()=>{
  assert.equal(terraCredential(JSON.stringify(credential)),undefined);
  assert.equal(terraCredential(JSON.stringify({...credential,requestId:'invalid/id'})),undefined);
  assert.equal(terraCredential(JSON.stringify({...credential,requestId:'terra-timing-medium'}))?.requestId,'terra-timing-medium');
});

test('Terra gateway scopes subscription authorization and settles real usage once',async()=>{
  const settlements:unknown[][]=[];
  const res=await handleTerraGateway(request(),{
    credential,
    reserve:async token=>token===capability?{effort:'medium',reservationId:'fixture'}:null,
    settle:async(...args)=>{settlements.push(args);},
    fetchImpl:async(url,options)=>{
      assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');
      const headers=new Headers(options?.headers);
      assert.equal(headers.get('authorization'),'Bearer subscription-fixture');
      assert.equal(headers.get('chatgpt-account-id'),'account-fixture');
      assert.equal(options?.redirect,'manual');
      return new Response(frame({model:input.model,usage}),{headers:{'content-type':'text/event-stream'}});
    },
  });
  assert.equal(res.status,200);
  assert.match(await res.text(),/response.completed/);
  assert.ok(Number.isSafeInteger(settlements[0]?.[5]));
  assert.deepEqual(settlements.map(args=>args.slice(0,5)),[[capability,'fixture',0,{input:100,cacheRead:23,output:40,thinking:5},undefined]]);
});

test('Terra rejects a changed effort before upstream and withholds unmetered completion',async()=>{
  const failures:unknown[][]=[];
  let sent=0;
  const options={
    credential,
    reserve:async()=>({effort:'medium' as const,reservationId:'fixture'}),
    settle:async(...args:unknown[])=>{failures.push(args);},
    fetchImpl:async()=>{sent++;return new Response(frame({model:input.model}));},
  };
  assert.equal((await handleTerraGateway(request({...input,reasoning:{effort:'low'}}),options)).status,400);
  assert.equal(sent,0);
  const res=await handleTerraGateway(request(),options);
  await assert.rejects(res.text(),/FINAL_USAGE_MISSING/);
  assert.ok(Number.isSafeInteger(failures[0]?.[5]));
  assert.deepEqual(failures.map(args=>args.slice(0,5)),[[capability,'fixture',null,undefined,'FINAL_USAGE_MISSING']]);
});

test('Terra meters a fragmented stream larger than 1 MiB before releasing completion',async()=>{
  const encoder=new TextEncoder();
  const payload='data: '+JSON.stringify({type:'response.output_text.delta',delta:'x'.repeat(200_000)})+'\n\n';
  const upstream=new Response(new ReadableStream({
    start(controller){
      const created='data: '+JSON.stringify({type:'response.created',response:{model:input.model}})+'\n\n';
      controller.enqueue(encoder.encode(created));
      for(let i=0;i<7;i++){
        controller.enqueue(encoder.encode(payload.slice(0,-1)));
        controller.enqueue(encoder.encode(payload.slice(-1)));
      }
      controller.enqueue(encoder.encode(frame({model:input.model,usage})));
      controller.close();
    },
  }));
  let settled=false;
  const res=await handleTerraGateway(request(),{
    credential,
    reserve:async()=>({effort:'medium',reservationId:'fixture'}),
    settle:async(_cap,_id,cost)=>{assert.equal(cost,0);settled=true;},
    fetchImpl:async()=>upstream,
  });
  const reader=res.body!.getReader();
  let bytes=0;
  while(true){
    const part=await reader.read();
    if(part.done)break;
    bytes+=part.value.byteLength;
    if(new TextDecoder().decode(part.value).includes('response.completed'))assert.equal(settled,true);
  }
  assert.ok(bytes>1024*1024);
  assert.equal(settled,true);
});
