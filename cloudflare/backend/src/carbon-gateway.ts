import {carbonModel, carbonUsageMicros, readCarbonUsage, type CarbonUsage, type CarbonEffort} from './carbon-benchmark.ts';

const endpoint = 'https://generativelanguage.googleapis.com';
const maximum = 1024 * 1024;
const fixedOutput = 32768;
export interface CarbonAdmission {effort: CarbonEffort; reservationId: string}
interface GatewayOptions {
  key?: string;
  reserve(capability: string, effort: CarbonEffort|null, estimate: number): Promise<CarbonAdmission | null>;
  settle(capability: string, reservationId: string, usage: number | null, tokens?: CarbonUsage, failure?: string): Promise<void>;
  idleMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
const reply = (status:number,category?:string) => new Response(JSON.stringify({error:{message:'Carbon benchmark request rejected',category}}),
  {status,headers:{'content-type':'application/json','cache-control':'no-store'}});

async function boundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) throw new Error('Missing body');
  const reader = body.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error('Body limit exceeded');
      }
      parts.push(next.value);
    }
  } finally {reader.releaseLock();}
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {all.set(part,offset);offset+=part.length;}
  return new TextDecoder('utf-8',{fatal:true}).decode(all);
}
function validateRequest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Gemini request');
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some(key=>!['contents','systemInstruction','tools','toolConfig','generationConfig','safetySettings'].includes(key))||
    !Array.isArray(raw.contents))throw new Error('Unapproved Gemini request feature');
  if(raw.tools!==undefined&&(!Array.isArray(raw.tools)||raw.tools.some(tool=>!tool||typeof tool!=='object'||
    Object.keys(tool).some(key=>key!=='functionDeclarations'))))throw new Error('Only local tool declarations are allowed');
  const config=raw.generationConfig as Record<string,unknown>|undefined;
  const thinking=config?.thinkingConfig as Record<string,unknown>|undefined;
  const effort=thinking?.thinkingLevel;
  if(!thinking||Object.keys(thinking).some(k=>!['includeThoughts','thinkingBudget','thinkingLevel'].includes(k))||
    (effort===undefined?thinking.thinkingBudget!==-1:effort!=='LOW'&&effort!=='MEDIUM'))throw new Error('Invalid Carbon effort');
  if(config?.candidateCount!==undefined&&config.candidateCount!==1)throw new Error('Only one candidate is allowed');
  if(config?.maxOutputTokens!==undefined&&(!Number.isSafeInteger(config.maxOutputTokens)||
    Number(config.maxOutputTokens)<1||Number(config.maxOutputTokens)>fixedOutput))throw new Error('Invalid output cap');
  for(const item of raw.contents){
    const parts=(item as {parts?:unknown}|null)?.parts;
    if(!Array.isArray(parts)||parts.some(p=>!p||typeof p!=='object'||Object.keys(p).some(key=>
      !['text','thought','thoughtSignature','functionCall','functionResponse'].includes(key))))throw new Error('Only text and local tools are allowed');
  }
  return {effort:(effort==='LOW'?'low':effort==='MEDIUM'?'medium':null) as CarbonEffort|null,
    payload:{...raw,generationConfig:{...config,maxOutputTokens:config?.maxOutputTokens??fixedOutput,
      thinkingConfig:{includeThoughts:thinking.includeThoughts===true,thinkingLevel:'MEDIUM'}}}};
}

const maxEventBytes=1024*1024;
const maxStreamBytes=16*1024*1024;

export class CarbonStreamError extends Error {}

export interface MeterReading { pinned?:boolean; finished?:boolean; usage?:unknown }

export function meterStream(
  body:ReadableStream<Uint8Array>, abort:AbortController, touch:()=>void,
  finish:(usage:number|null,tokens?:CarbonUsage,failure?:string)=>Promise<void>,
  readFrame:(chunk:Record<string,unknown>,finished:boolean)=>MeterReading,
  readUsage:(value:unknown)=>{usage:CarbonUsage;cost:number},
):ReadableStream<Uint8Array>{
  const reader=body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const encoder=new TextEncoder();
  let pending='', bytes=0, pinned=false, finished=false, cancelled=false;
  let finalUsage:unknown;
  const queued:string[]=[];
  let queuedBytes=0;
  function frame(text:string){
    const data=text.split(/\r?\n/).filter(line=>line.startsWith('data:'))
      .map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(data&&data!=='[DONE]'){
      let chunk:Record<string,unknown>;
      try{chunk=JSON.parse(data);}catch{throw new CarbonStreamError('INVALID_SSE_JSON');}
      if(!chunk||typeof chunk!=='object'||Array.isArray(chunk)||chunk.error)throw new CarbonStreamError('UPSTREAM_STREAM_ERROR');
      const reading=readFrame(chunk,finished);
      pinned ||= reading.pinned===true;
      finished ||= reading.finished===true;
      if(reading.usage!==undefined)finalUsage=reading.usage;
    }
    queued.push(text+'\n\n');
    queuedBytes+=encoder.encode(text).length+2;
    if(!pinned&&queuedBytes>maxEventBytes)throw new CarbonStreamError('MODEL_VERSION_UNCONFIRMED');
  }
  function parse(data:string,atEnd=false){
    pending+=data;
    for(;;){
      const match=/\r?\n\r?\n/.exec(pending);
      if(!match)break;
      const text=pending.slice(0,match.index);
      if(encoder.encode(text).length>maxEventBytes)throw new CarbonStreamError('SSE_EVENT_LIMIT');
      pending=pending.slice(match.index+match[0].length);
      frame(text);
    }
    if(pending.length>maxEventBytes)throw new CarbonStreamError('SSE_EVENT_LIMIT');
    if(atEnd&&pending.trim())throw new CarbonStreamError('TRUNCATED_SSE_EVENT');
  }
  function drain(controller:ReadableStreamDefaultController<Uint8Array>){
    if(!pinned)return;
    while(queued.length)controller.enqueue(encoder.encode(queued.shift()!));
    queuedBytes=0;
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        for(;;){
          const item=await reader.read();
          if(cancelled)return;
          if(item.done){
            parse(decoder.decode(),true);
            if(!pinned||!finished||finalUsage===undefined)throw new CarbonStreamError('FINAL_USAGE_MISSING');
            let usage:CarbonUsage,cost:number;
            try{({usage,cost}=readUsage(finalUsage));}
            catch{throw new CarbonStreamError('INVALID_FINAL_USAGE');}
            await finish(cost,usage);
            if(!cancelled){drain(controller);controller.close();}
            return;
          }
          touch();
          bytes+=item.value.byteLength;
          if(bytes>maxStreamBytes)throw new CarbonStreamError('SSE_STREAM_LIMIT');
          parse(decoder.decode(item.value,{stream:true}));
          if(pinned&&!finished&&queued.length){drain(controller);return;}
        }
      }catch(error){
        if(cancelled)return;
        const reason=error instanceof CarbonStreamError?error.message:
          abort.signal.aborted?'UPSTREAM_IDLE_OR_DEADLINE':'UPSTREAM_STREAM_TRANSPORT';
        abort.abort();
        await Promise.allSettled([reader.cancel(),finish(null,undefined,reason)]);
        if(!cancelled)controller.error(new Error(reason));
      }
    },
    async cancel(){
      cancelled=true;
      abort.abort();
      await Promise.allSettled([reader.cancel(),finish(null,undefined,'CONSUMER_DISCONNECTED')]);
    },
  });
}

export async function handleCarbonGateway(request: Request, options: GatewayOptions): Promise<Response> {
  const url = new URL(request.url);
  const path = `/v1beta/models/${carbonModel}:streamGenerateContent`;
  if(!options.key || (options.now??Date.now)()>=Date.parse('2026-12-01T00:00:00Z'))return reply(503);
  if(request.method!=='POST'||url.origin!==endpoint||url.pathname!==path||url.search!=='?alt=sse')return reply(403);
  const capability=request.headers.get('x-goog-api-key');
  if(!capability||!/^hmb_[a-f0-9]{64}$/.test(capability))return reply(403);
  let validated:ReturnType<typeof validateRequest>;
  try{validated=validateRequest(JSON.parse(await boundedText(request.body)));}catch{return reply(400);}
  const payload=JSON.stringify(validated.payload);
  // Byte-count bound for the text payload plus the complete output cap.
  const estimate=new TextEncoder().encode(payload).length*2+fixedOutput*10;
  const admitted=await options.reserve(capability,validated.effort,estimate);
  if(!admitted)return reply(429);
  const abort=new AbortController();
  const deadline=setTimeout(()=>abort.abort(),1200000);
  let idle:ReturnType<typeof setTimeout>|undefined;
  const touch=()=>{
    if(idle)clearTimeout(idle);
    idle=setTimeout(()=>abort.abort(),options.idleMs??270000);
  };
  let settlement:Promise<void>|undefined;
  const finish=(cost:number|null,tokens?:CarbonUsage,failure?:string)=>{
    if(settlement)return settlement;
    clearTimeout(deadline);
    if(idle)clearTimeout(idle);
    settlement=options.settle(capability,admitted.reservationId,cost,tokens,failure);
    return settlement;
  };
  const reject=async(status:number,reason:string)=>{
    await finish(null,undefined,reason);
    return reply(status,reason);
  };
  touch();
  try{
    if(validated.effort&&admitted.effort!==validated.effort)return reject(403,'EFFORT_MISMATCH');
    validated.payload.generationConfig.thinkingConfig.thinkingLevel=admitted.effort.toUpperCase();
    const response=await (options.fetchImpl??fetch)(endpoint+path+'?alt=sse',{
      method:'POST',headers:{'content-type':'application/json','x-goog-api-key':options.key},
      body:JSON.stringify(validated.payload),redirect:'manual',signal:abort.signal,
    });
    if(!response.ok){await response.body?.cancel();return reject(502,'UPSTREAM_HTTP_'+response.status);}
    if(!response.body)return reject(502,'UPSTREAM_BODY_MISSING');
    touch();
    return new Response(meterStream(response.body,abort,touch,finish,(chunk,finished)=>{
      const pinned=chunk.modelVersion!==undefined;
      if(pinned&&chunk.modelVersion!==carbonModel)throw new CarbonStreamError('MODEL_VERSION_MISMATCH');
      const ended=Array.isArray(chunk.candidates)&&chunk.candidates.some(candidate=>
        candidate&&typeof candidate.finishReason==='string'&&candidate.finishReason!=='FINISH_REASON_UNSPECIFIED');
      return {pinned,finished:ended,usage:finished||ended?chunk.usageMetadata:undefined};
    },value=>({usage:readCarbonUsage(value),cost:carbonUsageMicros(value)})),
      {headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
  }catch{return reject(502,abort.signal.aborted?'UPSTREAM_HEADER_TIMEOUT':'UPSTREAM_FETCH_TRANSPORT');}
}

/** Only the authenticated probe lane may request this non-provider stream. */
export function syntheticCarbonStream():Response{
  let sent=0;
  const encoder=new TextEncoder();
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      if(sent>0)await new Promise(resolve=>setTimeout(resolve,20000));
      const last=sent===14;
      const value=last?{modelVersion:carbonModel,candidates:[{finishReason:'STOP'}],
        usageMetadata:{promptTokenCount:1000,cachedContentTokenCount:800,candidatesTokenCount:100,thoughtsTokenCount:30}}:
        {modelVersion:carbonModel,candidates:[{content:{parts:[{text:'x'.repeat(90000)}]}}]};
      controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));
      sent++;
      if(last)controller.close();
    },
  });
  return new Response(body,{headers:{'content-type':'text/event-stream'}});
}
