import {classifyBash,bashDiagnostic} from './bash-diagnostic.ts';
import {createHash} from 'node:crypto';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';

const isTarget=(origin,path)=>(
  (origin==='https://chatgpt.com'&&path==='/backend-api/codex/responses')||
  (origin==='https://hivemind-terra.invalid'&&path==='/codex/responses')
);

// Measure the same boundaries in the desktop CLI and in the benchmark container.
export default function piLatency(pi) {
  let started, sent, firstFrame, firstToken, firstText, transport;
  let totalRequests=0,requests=0,turn=0,websocketReused,websocketDelta;
  const sockets=new WeakSet();
  const tools=new Map();
  const mark=()=>Math.round(performance.now()-started);
  const isRequest=request=>request?.method==='POST'&&isTarget(String(request.origin),request.path);
  const onSend=({request})=>{
    if(started===undefined||!isRequest(request))return;
    requests++;totalRequests++;
    sent=mark();
    transport='sse';
    firstFrame=undefined;
  };
  const onHeaders=({request})=>{
    if(started!==undefined&&transport==='sse'&&isRequest(request))firstFrame??=mark();
  };
  subscribe('undici:request:bodySent',onSend);
  subscribe('undici:request:headers',onHeaders);

  const socket=globalThis.WebSocket?.prototype;
  const originalSend=socket?.send;
  if(socket)socket.send=function(data){
    const watched=started!==undefined&&this.url==='wss://chatgpt.com/backend-api/codex/responses'&&
      typeof data==='string'&&data.startsWith('{"type":"response.create",');
    if(watched){
      requests++;totalRequests++;
      sent=mark();
      transport='websocket';
      websocketReused=sockets.has(this);
      sockets.add(this);
      websocketDelta=typeof JSON.parse(data).previous_response_id==='string';
      firstFrame=undefined;
      this.addEventListener('message',()=>{if(transport==='websocket')firstFrame??=mark();},{once:true});
    }
    return originalSend.call(this,data);
  };

  pi.on('before_provider_request',()=>{started??=performance.now();});
  pi.on('message_update',event=>{
    if(started===undefined)return;
    const delta=event.assistantMessageEvent;
    if((delta.type==='text_delta'||delta.type==='thinking_delta'||delta.type==='toolcall_delta')&&delta.delta)firstToken??=mark();
    if(delta.type==='text_delta'&&delta.delta)firstText??=mark();
  });
  pi.on('message_end',event=>{
    if(started===undefined||event.message.role!=='assistant')return;
    const text=event.message.content.filter(part=>part.type==='text').map(part=>part.text).join('').trim();
    process.stderr.write('HIVEMIND_PI_LATENCY '+JSON.stringify({turn:++turn,transport,requests,sentMs:sent,firstFrameMs:firstFrame,
      firstTokenMs:firstToken,firstTextMs:firstText,completeMs:mark(),stopReason:event.message.stopReason,
      outputTokens:event.message.usage?.output,inputTokens:event.message.usage?.input,cacheReadTokens:event.message.usage?.cacheRead,
      reasoningTokens:event.message.usage?.reasoning??0,
      textSha256:createHash('sha256').update(text).digest('hex'),websocketReused,websocketDelta})+'\n');
    started=sent=firstFrame=firstToken=firstText=transport=websocketReused=websocketDelta=undefined;
    requests=0;
  });
  pi.on('tool_execution_start',event=>{
    tools.set(event.toolCallId,{turn,request:totalRequests,startedAt:performance.now(),categories:event.toolName==='bash'?classifyBash(event.args?.command):undefined});
  });
  pi.on('tool_execution_end',event=>{
    const entry=tools.get(event.toolCallId);
    if(!entry)return;
    tools.delete(event.toolCallId);
    process.stderr.write('HIVEMIND_PI_TOOL '+JSON.stringify({turn:entry.turn,name:event.toolName,
      durationMs:Math.round(performance.now()-entry.startedAt),error:event.isError===true,request:entry.request,
      ...(entry.categories?{bash:bashDiagnostic(entry.categories,event.result,event.isError===true)}:{})})+'\n');
  });
  pi.on('session_shutdown',()=>{
    unsubscribe('undici:request:bodySent',onSend);
    unsubscribe('undici:request:headers',onHeaders);
    if(socket)socket.send=originalSend;
  });
}
