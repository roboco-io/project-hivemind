import type {TerraGatewayTiming} from './terra-latency.ts';
import type {CarbonUsage} from './carbon-benchmark.ts';
import {CarbonStreamError,meterStream,type CarbonAdmission} from './carbon-gateway.ts';

export const terraModel='gpt-6.1-terra';
export const terraOrigin='https://hivemind-terra.invalid';
export const terraEndpoint=terraOrigin+'/codex/responses';
export interface TerraCredential {access:string;accountId:string;expires:number}
interface TerraOptions {
  credential?:TerraCredential;
  reserve(capability:string):Promise<CarbonAdmission|null>;
  settle(capability:string,reservationId:string,cost:number|null,usage?:CarbonUsage,failure?:string,modelWaitMs?:number,timing?:TerraGatewayTiming):Promise<void>;
  fetchImpl?:typeof fetch;
}

function object(value:unknown):Record<string,unknown>|undefined {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}

export function terraCredential(raw:string|undefined):(TerraCredential&{requestId:string})|undefined {
  try{
    const value=object(JSON.parse(raw??'null'));
    if(typeof value?.access!=='string'||!/^[-_a-zA-Z0-9.]{1,16000}$/.test(value.access)||
      typeof value.accountId!=='string'||!/^[-_a-zA-Z0-9]{1,128}$/.test(value.accountId)||
      typeof value.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(value.requestId)||
      typeof value.expires!=='number'||!Number.isSafeInteger(value.expires)||value.expires<=Date.now())return;
    return {access:value.access,accountId:value.accountId,expires:value.expires,requestId:value.requestId};
  }catch{return;}
}

function readUsage(raw:unknown):CarbonUsage {
  const usage=object(raw);
  const count=(n:unknown):number=>{
    if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>2_000_000)throw new Error('Invalid Responses token count');
    return n;
  };
  const input=count(usage?.input_tokens),output=count(usage?.output_tokens);
  const cacheRead=count(object(usage?.input_tokens_details)?.cached_tokens??0);
  const thinking=count(object(usage?.output_tokens_details)?.reasoning_tokens??0);
  if(cacheRead>input||thinking>output||count(usage?.total_tokens)!==input+output)throw new Error('Invalid Responses usage');
  return {input:input-cacheRead,output:output-thinking,cacheRead,thinking};
}

const reply=(status:number)=>new Response('Terra benchmark request rejected',{status});

export async function handleTerraGateway(request:Request,options:TerraOptions):Promise<Response> {
  const arrivedAt=Date.now();
  const offset=()=>Math.max(0,Date.now()-arrivedAt);
  if(request.url!==terraEndpoint||request.method!=='POST')return reply(403);
  const credential=options.credential;
  if(!credential||credential.expires<=Date.now())return reply(503);
  const capability=request.headers.get('authorization')?.slice('Bearer '.length);
  if(!request.headers.get('authorization')?.startsWith('Bearer ')||!capability||!/^hmb_[a-f0-9]{64}$/.test(capability))return reply(403);
  let body:string;
  try{
    if(request.headers.has('content-encoding'))return reply(400);
    const reader=request.body?.getReader();
    if(!reader)return reply(400);
    const chunks:Uint8Array[]=[];
    let bytes=0;
    try{
      for(;;){
        const chunk=await reader.read();
        if(chunk.done)break;
        bytes+=chunk.value.byteLength;
        if(bytes>8*1024*1024){await reader.cancel();return reply(413);}
        chunks.push(chunk.value);
      }
    }finally{reader.releaseLock();}
    body=await new Blob(chunks as BlobPart[]).text();
    const payload=object(JSON.parse(body));
    if(payload?.model!==terraModel||object(payload.reasoning)?.effort!=='medium'||
      payload.stream!==true||payload.store!==false||!Array.isArray(payload.input)||(payload.tools!==undefined&&!Array.isArray(payload.tools))||
      payload.previous_response_id!==undefined||
      (payload.tools??[]).some((tool:unknown)=>!['function','custom'].includes(String(object(tool)?.type))))return reply(400);
  }catch{return reply(400);}
  const admitted=await options.reserve(capability);
  if(!admitted)return reply(429);
  const abort=new AbortController();
  const deadline=setTimeout(()=>abort.abort(),Math.min(1200000,Math.max(1,credential.expires-Date.now())));
  let idle:ReturnType<typeof setTimeout>|undefined;
  const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>abort.abort(),270000);};
  let settlement:Promise<void>|undefined;
  const startedAt=Date.now();
  const timing:TerraGatewayTiming={dispatchMs:offset(),settledMs:0};
  const finish=(cost:number|null,usage?:CarbonUsage,failure?:string)=>{
    if(settlement)return settlement;
    clearTimeout(idle);
    clearTimeout(deadline);
    timing.settledMs=offset();
    settlement=options.settle(capability,admitted.reservationId,cost,usage,failure,Math.max(0,Date.now()-startedAt),timing);
    return settlement;
  };
  touch();
  try{
    const headers=new Headers({'content-type':'application/json',accept:'text/event-stream',
      authorization:'Bearer '+credential.access,'chatgpt-account-id':credential.accountId,originator:'pi',
      'openai-beta':'responses=experimental','user-agent':'pi/0.87.1'});
    for(const key of ['session-id','x-client-request-id']){
      const value=request.headers.get(key);
      if(value&&/^[-_a-zA-Z0-9.]{1,128}$/.test(value))headers.set(key,value);
    }
    timing.dispatchMs=offset();
    const upstream=await (options.fetchImpl??fetch)('https://chatgpt.com/backend-api/codex/responses',{
      method:'POST',headers,body,signal:abort.signal,redirect:'manual',
    });
    timing.upstreamHeadersMs=offset();
    if(!upstream.ok||!upstream.body){
      await upstream.body?.cancel();
      await finish(null,undefined,'UPSTREAM_HTTP_'+upstream.status);
      return reply(502);
    }
    touch();
    const stream=meterStream(upstream.body,abort,touch,finish,chunk=>{
      const type=chunk.type;
      if(type==='error'||type==='response.failed')throw new CarbonStreamError('UPSTREAM_STREAM_ERROR');
      const response=object(chunk.response);
      const pinned=response?.model!==undefined;
      if(pinned&&response?.model!==terraModel)throw new CarbonStreamError('MODEL_VERSION_MISMATCH');
      if(typeof chunk.delta==='string'&&chunk.delta){
        if(type==='response.output_text.delta'||type==='response.reasoning_summary_text.delta'||type==='response.reasoning_text.delta'||type==='response.function_call_arguments.delta'||type==='response.custom_tool_call_input.delta')
          timing.firstUpstreamTokenMs??=offset();
        if(type==='response.output_text.delta')timing.firstUpstreamTextMs??=offset();
      }
      const finished=type==='response.completed'||type==='response.done'||type==='response.incomplete';
      if(finished)timing.upstreamCompleteMs??=offset();
      return {pinned,finished,usage:finished?response?.usage:undefined};
    },raw=>({usage:readUsage(raw),cost:0}));
    return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
  }catch{
    await finish(null,undefined,'UPSTREAM_FETCH_TRANSPORT');
    return reply(502);
  }
}

export function syntheticTerraStream():Response {
  const text='Terra fixture complete.';
  const part={type:'output_text',text:'',annotations:[]};
  const item={type:'message',id:'msg_fixture',role:'assistant',status:'in_progress',content:[]};
  const events=[
    {type:'response.created',response:{model:terraModel,status:'in_progress'}},
    {type:'response.output_item.added',output_index:0,item},
    {type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part},
    {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:text},
    {type:'response.output_item.done',output_index:0,item:{...item,status:'completed',content:[{...part,text}]}},
    {type:'response.completed',response:{model:terraModel,status:'completed',output:[{...item,status:'completed',content:[{...part,text}]}],
      usage:{input_tokens:123,output_tokens:45,total_tokens:168,input_tokens_details:{cached_tokens:23},output_tokens_details:{reasoning_tokens:5}}}},
  ];
  return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
}
