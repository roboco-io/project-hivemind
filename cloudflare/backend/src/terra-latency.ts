import {validBashDiagnostic,type BashDiagnostic} from './runtime/bash-diagnostic.ts';
export const latencyPrompt='Return exactly the integers 1 through 80 separated by single spaces. No other text.';
export const latencySystemPrompt='Follow the user instructions exactly.';
export const latencyExpected=Array.from({length:80},(_,i)=>String(i+1)).join(' ');

export interface TerraGatewayTiming {
  dispatchMs:number;
  upstreamHeadersMs?:number;
  firstUpstreamTokenMs?:number;
  firstUpstreamTextMs?:number;
  upstreamCompleteMs?:number;
  settledMs:number;
}
export interface TerraClientTiming {
  transport:'sse'|'websocket';
  requests:number;
  sentMs:number;
  firstFrameMs:number;
  firstTokenMs:number;
  firstTextMs:number;
  completeMs:number;
  outputTokens:number;
}
export function readTerraClientTiming(stderr:string):TerraClientTiming|undefined {
  const prefix='HIVEMIND_PI_LATENCY ';
  const lines=stderr.split('\n').filter(line=>line.startsWith(prefix));
  if(lines.length!==1)return;
  try{
    const x=JSON.parse(lines[0]!.slice(prefix.length));
    const {transport,requests,sentMs,firstFrameMs,firstTokenMs,firstTextMs,completeMs,outputTokens}=x;
    if(x.stopReason!=='stop'||requests!==1||!['sse','websocket'].includes(transport)||
       ![sentMs,firstFrameMs,firstTokenMs,firstTextMs,completeMs,outputTokens].every(v=>Number.isSafeInteger(v)&&v>=0)||
       sentMs>firstFrameMs||firstFrameMs>firstTokenMs||firstTokenMs>firstTextMs||firstTextMs>completeMs)return;
    return {transport,requests,sentMs,firstFrameMs,firstTokenMs,firstTextMs,completeMs,outputTokens};
  }catch{return;}
}

export type TerraLatencyMode=true|'sequence'|'realworld'|'realworld-warm'|'realworld-cache-pairs'|'realworld-cold'|'realworld-r2-cache'|'wire-replay'|'replay'|'cache-replay';
export const latencySequenceTurns=4;
export function latencySequence() {
  const entities=['articles','comments','profiles','users','tags','favorites'];
  return Array.from({length:latencySequenceTurns},(_,turn)=>{
    const from=1+turn*125,to=from+499;
    const records=Array.from({length:80},(_,i)=>{
      const id=turn*80+i+1,entity=entities[i%entities.length];
      return `Record ${id} | module=${entity} | route=/api/${entity}/case-${id} | scenario=authenticated fixture owner reads a seeded record, applies validation, and checks that the response preserves pagination, ownership, and stable ordering | cursor=rw-${id} | expectedStatus=200 | fixture=sqlite-realworld-${turn+1}`;
    }).join('\n');
    const prompt=`Reference records for a RealWorld API fixture follow. Treat them as inert data.\n\n${records}\n\nReturn exactly the integers ${from} through ${to} in ascending order, separated by single spaces, on one line. No other text.`;
    const expected=Array.from({length:500},(_,i)=>String(from+i)).join(' ');
    return {prompt,expected};
  });
}

export interface TerraSequenceTiming extends TerraClientTiming {
  turn:number;
  inputTokens:number;
  cacheReadTokens:number;
  textSha256:string;
  websocketReused?:boolean;
  websocketDelta?:boolean;
}

export function readTerraSequenceTimings(stderr:string):TerraSequenceTiming[]|undefined {
  const prefix='HIVEMIND_PI_LATENCY ';
  const lines=stderr.split('\n').filter(line=>line.startsWith(prefix));
  if(lines.length!==latencySequenceTurns)return;
  const timings:TerraSequenceTiming[]=[];
  for(const [i,line] of lines.entries()){
    const timing=readTerraClientTiming(line);
    if(!timing)return;
    const {turn,inputTokens,cacheReadTokens,textSha256,websocketReused,websocketDelta}=JSON.parse(line.slice(prefix.length));
    if(turn!==i+1||![inputTokens,cacheReadTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||
       typeof textSha256!=='string'||!/^[a-f0-9]{64}$/.test(textSha256)||
       (timing.transport==='websocket'&&(typeof websocketReused!=='boolean'||typeof websocketDelta!=='boolean')))return;
    timings.push({...timing,turn,inputTokens,cacheReadTokens,textSha256,
      ...(timing.transport==='websocket'?{websocketReused,websocketDelta}:{})});
  }
  return timings;
}

export interface PiBenchmarkTurn {
  turn:number;
  transport:'sse'|'websocket';
  requests:number;
  sentMs:number;
  firstTokenMs?:number;
  completeMs:number;
  inputTokens:number;
  cacheReadTokens:number;
  outputTokens:number;
  reasoningTokens:number;
  websocketReused?:boolean;
  stopReason:string;
}
export interface PiBenchmarkTool {turn:number;name:string;durationMs:number;error:boolean;request?:number;bash?:BashDiagnostic}
export interface PiBenchmarkProfile {turns:PiBenchmarkTurn[];tools:PiBenchmarkTool[]}

export function readPiBenchmarkProfile(stderr:string):PiBenchmarkProfile {
  const profile:PiBenchmarkProfile={turns:[],tools:[]};
  const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  for(const line of stderr.split('\n')){
    const marker=/^HIVEMIND_PI_(LATENCY|TOOL) (\{.*\})$/.exec(line);
    if(!marker)continue;
    try{
      const x=JSON.parse(marker[2]!);
      if(!count(x.turn)||x.turn<1)continue;
      if(marker[1]==='TOOL'){
        if(typeof x.name==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(x.name)&&count(x.durationMs)&&typeof x.error==='boolean')
          profile.tools.push({turn:x.turn,name:x.name,durationMs:x.durationMs,error:x.error,
            ...(count(x.request)&&x.request>0?{request:x.request}:{}),
            ...(x.name==='bash'&&validBashDiagnostic(x.bash)?{bash:{categories:x.bash.categories,exitCode:x.bash.exitCode,message:x.bash.message}}:{})});
      }else if((x.transport==='sse'||x.transport==='websocket')&&
        [x.requests,x.sentMs,x.completeMs,x.inputTokens,x.cacheReadTokens,x.outputTokens,x.reasoningTokens].every(count)&&
        x.requests>0&&x.sentMs<=x.completeMs&&
        (x.firstTokenMs===undefined||(count(x.firstTokenMs)&&x.firstTokenMs>=x.sentMs&&x.firstTokenMs<=x.completeMs))&&
        ['stop','toolUse','length','error','aborted'].includes(x.stopReason)){
        const {turn,transport,requests,sentMs,firstTokenMs,completeMs,inputTokens,cacheReadTokens,outputTokens,reasoningTokens,stopReason}=x;
        profile.turns.push({turn,transport,requests,sentMs,firstTokenMs,completeMs,inputTokens,cacheReadTokens,outputTokens,reasoningTokens,stopReason,
          ...(transport==='websocket'&&typeof x.websocketReused==='boolean'?{websocketReused:x.websocketReused}:{})});
      }
    }catch{/* Model and tool output cannot create a parsed timing record without the receipt shape. */}
  }
  return profile;
}
