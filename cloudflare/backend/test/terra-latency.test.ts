import test from 'node:test';
import assert from 'node:assert/strict';
import {latencySequence,readPiBenchmarkProfile,readTerraClientTiming,readTerraSequenceTimings} from '../src/terra-latency.ts';
import {handleTerraGateway,syntheticTerraStream,terraEndpoint} from '../src/terra-gateway.ts';
import type {TerraGatewayTiming} from '../src/terra-latency.ts';

test('pi timing accepts one completed attempt with ordered boundaries',()=>{
  const record={transport:'websocket',requests:1,sentMs:13,firstFrameMs:28,firstTokenMs:50,firstTextMs:73,completeMs:200,outputTokens:40,stopReason:'stop'};
  const line=(x:unknown)=>'HIVEMIND_PI_LATENCY '+JSON.stringify(x)+'\n';
  const {stopReason:_,...timing}=record;
  assert.deepEqual(readTerraClientTiming(line(record)),timing);
  assert.equal(readTerraClientTiming(line({...record,requests:2})),undefined);
  assert.equal(readTerraClientTiming(line({...record,firstTextMs:1})),undefined);
});

test('Terra gateway timestamps first output before the terminal SSE frame and settlement',async()=>{
  let timing:TerraGatewayTiming|undefined;
  const request=new Request(terraEndpoint,{method:'POST',headers:{authorization:'Bearer hmb_'+'a'.repeat(64)},
    body:JSON.stringify({model:'gpt-6.1-terra',reasoning:{effort:'medium'},stream:true,store:false,input:[]})});
  const result=await handleTerraGateway(request,{
    credential:{access:'fixture',accountId:'fixture',expires:Date.now()+60000},
    reserve:async()=>({effort:'medium',reservationId:'fixture'}),
    settle:async(_cap,_id,_cost,_usage,_failure,_wait,value)=>{timing=value;},
    fetchImpl:async()=>syntheticTerraStream(),
  });
  assert.equal(result.status,200);
  await result.text();
  assert.ok(timing);
  assert.ok(timing.dispatchMs<=timing.upstreamHeadersMs!);
  assert.ok(timing.upstreamHeadersMs!<=timing.firstUpstreamTextMs!);
  assert.ok(timing.firstUpstreamTextMs!<=timing.upstreamCompleteMs!);
  assert.ok(timing.upstreamCompleteMs!<=timing.settledMs);
});


test('sequence timings require one complete receipt for each ordered turn',()=>{
  const turns=latencySequence();
  assert.equal(turns.length,4);
  assert.equal(new Set(turns.map(t=>t.prompt)).size,4);
  assert.ok(turns.every(t=>t.prompt.length>10000&&t.expected.split(' ').length===500));
  const lines=turns.map((_,i)=>'HIVEMIND_PI_LATENCY '+JSON.stringify({
    turn:i+1,transport:'websocket',requests:1,sentMs:13,firstFrameMs:28,firstTokenMs:50,firstTextMs:73,completeMs:200,
    stopReason:'stop',inputTokens:4000,cacheReadTokens:3000,outputTokens:999,textSha256:'a'.repeat(64),
    websocketReused:i>0,websocketDelta:i>0,
  }));
  assert.deepEqual(readTerraSequenceTimings(lines.join('\n'))?.map(t=>t.websocketReused),[false,true,true,true]);
  assert.equal(readTerraSequenceTimings(lines.slice(1).join('\n')),undefined);
  assert.equal(readTerraSequenceTimings(lines.reverse().join('\n')),undefined);
});


test('RealWorld profiling retains tool-only responses and tool timing without raw payloads',()=>{
  const turn={turn:1,transport:'sse',requests:1,sentMs:10,firstTokenMs:30,completeMs:90,
    inputTokens:100,cacheReadTokens:20,outputTokens:30,reasoningTokens:5,stopReason:'toolUse',raw:'private fixture'};
  const tool={turn:1,name:'bash',durationMs:50,error:false,command:'private fixture'};
  const result=readPiBenchmarkProfile('HIVEMIND_PI_LATENCY '+JSON.stringify(turn)+'\nHIVEMIND_PI_TOOL '+JSON.stringify(tool));
  assert.equal(result.turns[0]?.firstTokenMs,30);
  assert.deepEqual(result.tools,[{turn:1,name:'bash',durationMs:50,error:false}]);
  assert.doesNotMatch(JSON.stringify(result),/private fixture/);
});
