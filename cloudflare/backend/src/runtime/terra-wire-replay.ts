import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';

export const wireReplayTurns=26;
const direct='https://chatgpt.com/backend-api/codex/responses';
const remote='https://hivemind-terra.invalid/codex/responses';
export interface WireReplayTiming {
 turn:number;bodySha256:string;bytes:number;sentMs?:number;headersMs?:number;
 firstTokenMs?:number;firstOutputMs?:number;completionMs?:number;finishedMs:number;input?:number;cached?:number;output?:number;reasoning?:number;error?:string;
}
const isDelta=(type:string)=>['response.output_text.delta','response.reasoning_summary_text.delta','response.reasoning_text.delta',
 'response.function_call_arguments.delta','response.custom_tool_call_input.delta'].includes(type);

export async function replayTerraWire(root:string,auth:{access:string;accountId?:string},signal:AbortSignal,probe=false,startAt=0) {
 const raw=await readFile(join(root,'requests.json'),'utf8');
 const bodies:unknown=JSON.parse(raw);
 if(!Array.isArray(bodies)||bodies.length!==wireReplayTurns||!bodies.every(x=>typeof x==='string'&&Buffer.byteLength(x)<=262144))
  throw Error('Invalid fixed RealWorld replay sequence');
 const rows:WireReplayTiming[]=[];
 const endpoint=auth.accountId?direct:remote;
 const url=new URL(endpoint);
 for(const [i,body] of (probe?bodies.slice(0,1):bodies).entries()){
  if(i<startAt)continue;
  const payload=JSON.parse(body);
  const session=payload.prompt_cache_key;
  if(payload.model!=='gpt-6.1-terra'||payload.reasoning?.effort!=='medium'||payload.stream!==true||payload.store!==false||
    !Array.isArray(payload.input)||payload.previous_response_id!==undefined||typeof session!=='string'||!/^[-a-f0-9]{36}$/.test(session))
   throw Error('Unexpected replay payload');
  const headers:Record<string,string>={authorization:'Bearer '+auth.access,'content-type':'application/json',accept:'text/event-stream',
    'session-id':session,'x-client-request-id':session};
  if(auth.accountId)Object.assign(headers,{'chatgpt-account-id':auth.accountId,'openai-beta':'responses=experimental',originator:'pi','user-agent':'pi/0.87.1'});
  if(probe)headers['x-hivemind-terra-probe']='1';
  const row:WireReplayTiming={turn:i+1,bodySha256:createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body),finishedMs:0};
  rows.push(row);
  const started=performance.now();
  const now=()=>Math.round(performance.now()-started);
  const sent=({request}:any)=>{
   if(String(request?.origin)===url.origin&&request?.path===url.pathname&&request?.method==='POST')row.sentMs??=now();
  };
  subscribe('undici:request:bodySent',sent);
  try{
   const response=await fetch(endpoint,{method:'POST',headers,body,redirect:'error',
    signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
   row.headersMs=now();
   if(!response.ok||!response.body){await response.body?.cancel();throw Error('HTTP_'+response.status);}
   const decoder=new TextDecoder();
   let pending='';
   for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){
    pending+=decoder.decode(chunk,{stream:true});
    let boundary:RegExpExecArray|null;
    while((boundary=/\r?\n\r?\n/.exec(pending))){
     const data=pending.slice(0,boundary.index).split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
     pending=pending.slice(boundary.index+boundary[0].length);
     if(!data||data==='[DONE]')continue;
     const event=JSON.parse(data);
     if(event.type==='error'||event.type==='response.failed')throw Error('UPSTREAM_ERROR');
     if(isDelta(event.type)&&event.delta){
      row.firstTokenMs??=now();
      row.firstOutputMs??=row.firstTokenMs;
     }
     if(event.type==='response.output_item.added'&&['message','function_call','custom_tool_call'].includes(event.item?.type))
      row.firstOutputMs??=now();
     if(['response.function_call_arguments.done','response.custom_tool_call_input.done','response.output_item.done'].includes(event.type)&&
        (event.arguments||event.input||['message','function_call','custom_tool_call'].includes(event.item?.type)))
      row.firstOutputMs??=now();
     if(['response.completed','response.done','response.incomplete'].includes(event.type)){
      const usage=event.response?.usage;
      if(event.response?.model!=='gpt-6.1-terra'||!usage||event.response?.status!=='completed')throw Error('INVALID_COMPLETION');
      row.completionMs=now();
      row.input=usage.input_tokens;row.cached=usage.input_tokens_details?.cached_tokens??0;
      row.output=usage.output_tokens;row.reasoning=usage.output_tokens_details?.reasoning_tokens??0;
     }
    }
    if(pending.length>2*1024*1024)throw Error('SSE_FRAME_LIMIT');
   }
   if(row.completionMs===undefined||row.sentMs===undefined)throw Error('MISSING_TIMING');
  }catch(error){
   const msg=error instanceof Error?error.message:'';
   row.error=/^(?:HTTP_\d+|UPSTREAM_ERROR|INVALID_COMPLETION|SSE_FRAME_LIMIT|MISSING_TIMING)$/.test(msg)?msg:'TRANSPORT_ERROR';
  }finally{
   unsubscribe('undici:request:bodySent',sent);
   row.finishedMs=now();
  }
  if(row.error)break;
 }
 return rows;
}
