import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceCarbonCampaign, carbonUsageMicros, reserveCarbonRequest, settleCarbonRequest, type CarbonCampaign} from '../src/carbon-benchmark.ts';

const empty=():CarbonCampaign=>({id:'campaign',snapshotId:'a'.repeat(64),phase:'compare',runs:[
 {id:'medium',effort:'medium',spentMicros:0,requests:0},
 {id:'low',effort:'low',spentMicros:0,requests:0},
]});
test('a successful effort wins by completion time and launches exactly two repeats',()=>{
 const c=empty(), queued:string[]=[];
 const outcomes={medium:{terminal:true,passed:true,durationMs:12000},low:{terminal:true,passed:true,durationMs:9000}};
 const advance=()=>advanceCarbonCampaign(c,id=>outcomes[id as keyof typeof outcomes],effort=>{
  queued.push(effort);return String(queued.length);
 });
 advance();advance();
 assert.deepEqual(queued,['low','low']);assert.equal(c.phase,'repeat');assert.equal(c.winner,'low');
});
test('an incomplete but faster effort cannot win',()=>{
 const c=empty(), queued:string[]=[];
 advanceCarbonCampaign(c,id=>({terminal:true,passed:id==='medium',durationMs:id==='medium'?20000:100}),effort=>{
  queued.push(effort);return String(queued.length);
 });
 assert.deepEqual(queued,['medium','medium']);
});
test('request reservations enforce run and campaign limits across both slots',()=>{
 const c=empty();
 c.runs[0]!.spentMicros=4900000;
 assert.equal(reserveCarbonRequest(c,'medium',100001),false);
 assert.equal(reserveCarbonRequest(c,'medium',100000),true);
 assert.equal(reserveCarbonRequest(c,'medium',1),false);
 settleCarbonRequest(c,'medium',50000);
 assert.equal(c.runs[0]!.spentMicros,4950000);
 assert.equal(c.runs[0]!.requests,1);
 assert.equal(reserveCarbonRequest(c,'medium',50000),true);
 settleCarbonRequest(c,'medium',null);
 assert.equal(c.runs[0]!.spentMicros,5000000);
});
test('Gemini usage separates cached input and includes thinking output',()=>{
 assert.equal(carbonUsageMicros({promptTokenCount:1000,cachedContentTokenCount:800,candidatesTokenCount:100,thoughtsTokenCount:30}),1780);
 assert.throws(()=>carbonUsageMicros({promptTokenCount:3,cachedContentTokenCount:9,candidatesTokenCount:1}));
});

test('Carbon gateway substitutes the server key only after an effort-bound reservation',async()=>{
 const {handleCarbonGateway}=await import('../src/carbon-gateway.ts');
 const capability='hmb_'+'f'.repeat(64), key='private-test-key';
 const request=(model='gemini-4-carbon')=>new Request('https://generativelanguage.googleapis.com/v1beta/models/'+model+':streamGenerateContent?alt=sse',
  {method:'POST',headers:{'x-goog-api-key':capability},body:JSON.stringify({contents:[{parts:[{text:'hello'}]}],generationConfig:{thinkingConfig:{thinkingLevel:'LOW'}}})});
 let settled:number|null|undefined, calls=0;
 const options={key,now:()=>Date.parse('2026-11-12T00:00:00Z'),async reserve(token:string,effort:'low'|'medium'|null,estimate:number){
  assert.equal(token,capability);assert.equal(effort,'low');assert.ok(estimate>327680);return {effort:'low' as const,reservationId:'fixture'};
 },async settle(_token:string,_reservation:string,amount:number|null){settled=amount;},fetchImpl:async (_url:URL|RequestInfo,init?:RequestInit)=>{
  calls++;assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('x-goog-api-key'),key);
  return new Response('data: '+JSON.stringify({modelVersion:'gemini-4-carbon',candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10}})+'\n\n');
 }};
 assert.equal((await handleCarbonGateway(request('other'),options)).status,403);
 assert.equal(calls,0);
 const result=await handleCarbonGateway(request(),options);
 assert.equal(result.status,200);assert.doesNotMatch(await result.text(),/private-test-key|hmb_/);
 assert.equal(settled,300);
});

test('reservations include in-flight spend in the campaign-wide ceiling',()=>{
 const c=empty();
 c.runs.push({id:'low2',effort:'low',spentMicros:5000000,requests:1},{id:'low3',effort:'low',spentMicros:5000000,requests:1});
 c.runs[0]!.spentMicros=4999900;c.runs[1]!.spentMicros=4999900;
 assert.equal(reserveCarbonRequest(c,'medium',100),true);
 assert.equal(reserveCarbonRequest(c,'low',101),false);
 assert.equal(reserveCarbonRequest(c,'low',100),true);
 settleCarbonRequest(c,'low',null);
 assert.equal(reserveCarbonRequest(c,'low',1),false);
});

test('gateway usage totals remain per run and unknown provider usage prevents follow-up runs',()=>{
 const c=empty();
 assert.equal(reserveCarbonRequest(c,'medium',1000),true);
 settleCarbonRequest(c,'medium',250,{input:100,cacheRead:0,output:5,thinking:0});
 assert.deepEqual(c.runs[0]!.usage,{input:100,cacheRead:0,output:5,thinking:0});
 assert.equal(reserveCarbonRequest(c,'low',1000),true);
 settleCarbonRequest(c,'low',null);
 advanceCarbonCampaign(c,id=>({terminal:true,passed:id==='medium',durationMs:100}),()=>{throw Error('Unexpected repeat');});
 assert.equal(c.phase,'done');
 assert.equal(c.winner,undefined);
});

test('Carbon forwards a long SSE response before EOF and settles only after terminal usage',async()=>{
 const {handleCarbonGateway}=await import('../src/carbon-gateway.ts');
 const capability='hmb_'+'e'.repeat(64);
 const campaign=empty();
 let upstream!:ReadableStreamDefaultController<Uint8Array>;
 const enc=new TextEncoder();
 const send=(value:unknown)=>upstream.enqueue(enc.encode('data: '+JSON.stringify(value)+'\r\n\r\n'));
 const body=new ReadableStream<Uint8Array>({start(c){upstream=c;}});
 const request=new Request('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse',
  {method:'POST',headers:{'x-goog-api-key':capability},body:JSON.stringify({contents:[{parts:[{text:'hello'}]}],generationConfig:{thinkingConfig:{thinkingLevel:'LOW'}}})});
 const pending=handleCarbonGateway(request,{
  key:'fixture',now:()=>Date.parse('2026-11-12'),
  async reserve(_cap,effort,amount){
   assert.equal(effort,'low');
   assert.equal(reserveCarbonRequest(campaign,'low',amount),true);
   return {effort:'low',reservationId:'fixture'};
  },
  async settle(_cap,_id,micros,usage){settleCarbonRequest(campaign,'low',micros,usage);},
  fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}}),
 });
 const timeout=new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('Buffered until EOF')),300);t.unref();});
 const response=await Promise.race([pending,timeout]);
 const reader=response.body!.getReader();
 send({modelVersion:'gemini-4-carbon',candidates:[{content:{parts:[{text:'first'}]}}],usageMetadata:{promptTokenCount:300}});
 assert.match(new TextDecoder().decode((await reader.read()).value),/first/);
 assert.equal(campaign.runs[1]!.requests,0);
 assert.equal(reserveCarbonRequest(campaign,'low',1),false);
 for(let i=0;i<10;i++){
  send({candidates:[{content:{parts:[{text:'x'.repeat(120000)}]}}]});
  assert.ok((await reader.read()).value!.length>100000);
 }
 send({candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:300,cachedContentTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:5}});
 upstream.close();
 while(!(await reader.read()).done){}
 assert.equal(campaign.runs[1]!.spentMicros,560);
 assert.deepEqual(campaign.runs[1]!.usage,{input:200,cacheRead:100,output:10,thinking:5});
 assert.equal(campaign.runs[1]!.reservedMicros,undefined);
});

test('only verified terminal usage releases the request reservation',async()=>{
 const {handleCarbonGateway}=await import('../src/carbon-gateway.ts');
 const capability='hmb_'+'a'.repeat(64);
 const request=()=>new Request('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse',
  {method:'POST',headers:{'x-goog-api-key':capability},body:JSON.stringify({contents:[{parts:[{text:'fixture'}]}],generationConfig:{thinkingConfig:{thinkingLevel:'LOW'}}})});
 for(const disconnect of [false,true]){
  const campaign=empty();
  let stream!:ReadableStreamDefaultController<Uint8Array>;
  const encoder=new TextEncoder();
  const response=await handleCarbonGateway(request(),{
   key:'fixture',now:()=>Date.parse('2026-11-12'),
   async reserve(_cap,_effort,amount){assert.equal(reserveCarbonRequest(campaign,'low',amount),true);return {effort:'low',reservationId:'fixture'};},
   async settle(_cap,_id,cost,usage,failure){settleCarbonRequest(campaign,'low',cost,usage,failure);},
   fetchImpl:async()=>new Response(new ReadableStream({start(c){stream=c;}})),
  });
  const reserved=campaign.runs[1]!.reservedMicros;
  stream.enqueue(encoder.encode('data: {"modelVersion":"gemini-4-carbon","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}\n\n'));
  const reader=response.body!.getReader();
  assert.ok((await reader.read()).value);
  if(disconnect)await reader.cancel();
  else{stream.close();await assert.rejects(reader.read(),/FINAL_USAGE_MISSING/);}
  assert.equal(campaign.runs[1]!.spentMicros,reserved);
  assert.equal(campaign.runs[1]!.requests,1);
  assert.equal(campaign.runs[1]!.blocked,true);
  assert.equal(campaign.runs[1]!.failureCode,disconnect?'CONSUMER_DISCONNECTED':'FINAL_USAGE_MISSING');
 }
});
test('retry campaign retains prior conservative spend and zero output requires a verified total',()=>{
 const c=empty();
 c.priorSpentMicros=19999999;
 assert.equal(reserveCarbonRequest(c,'low',2),false);
 assert.equal(reserveCarbonRequest(c,'low',1),true);
 assert.equal(carbonUsageMicros({promptTokenCount:10,thoughtsTokenCount:2,totalTokenCount:12}),40);
 assert.throws(()=>carbonUsageMicros({promptTokenCount:10,thoughtsTokenCount:2,totalTokenCount:13}));
});


test('Terra sizing alternates three pairs and waits for each container to stop',()=>{
 let campaign:CarbonCampaign={id:'sizing',snapshotId:'snapshot',phase:'compare',model:'terra',sizing:true,
  runs:[{id:'0',effort:'medium',instance:'standard-1',spentMicros:0,requests:0}]};
 const done=new Set<string>();
 const advance=()=>advanceCarbonCampaign(campaign,id=>({terminal:done.has(id),passed:done.has(id),durationMs:100}),
  (effort,instance)=>{assert.equal(effort,'medium');assert.ok(instance);return String(campaign.runs.length);});
 for(let i=0;i<6;i++){
  advance();
  assert.equal(campaign.runs.length,i+1);
  done.add(String(i));
  campaign=JSON.parse(JSON.stringify(campaign));
  advance();
 }
 assert.deepEqual(campaign.runs.map(run=>run.instance),['standard-1','standard-3','standard-1','standard-3','standard-1','standard-3']);
 assert.equal(campaign.phase,'done');
});

test('locked RealWorld cache pairs advance serially through three cold and warm runs',()=>{
 let campaign:CarbonCampaign={id:'cache-pairs',snapshotId:'snapshot',phase:'compare',model:'terra',latency:'realworld-cache-pairs',
  runs:[{id:'0',effort:'medium',instance:'standard-3',cacheMode:'cold',spentMicros:0,requests:0}]};
 const stopped=new Set<string>();
 const advance=()=>advanceCarbonCampaign(campaign,id=>({terminal:stopped.has(id),passed:true,durationMs:100}),
  (_effort,instance,cacheMode)=>{assert.equal(instance,'standard-3');assert.ok(cacheMode);return String(campaign.runs.length);});
 for(let i=0;i<6;i++){
  advance();assert.equal(campaign.runs.length,i+1);
  stopped.add(String(i));
  campaign=JSON.parse(JSON.stringify(campaign));
  advance();
 }
 assert.deepEqual(campaign.runs.map(run=>run.cacheMode),['cold','warm','cold','warm','cold','warm']);
 assert.equal(campaign.phase,'done');
});
