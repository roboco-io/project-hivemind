import test from 'node:test';
import assert from 'node:assert/strict';
import {extractClaudeResultMetrics,validateClaudeResultMetrics} from '../src/claude-result-metrics.ts';
import {parseProviderResult} from '../src/runtime/providers.ts';
import type {ProcessResult} from '../src/contracts.ts';
const native={type:'result',subtype:'success',is_error:false,result:'final text',duration_ms:1100,duration_api_ms:500,num_turns:7,
 modelUsage:{'claude-opus-5-5':{inputTokens:20,outputTokens:5,costUSD:0.002,secret:'not retained',arbitraryCounter:100}},secret:'not retained'};
const process=(records:unknown[]):ProcessResult=>({status:'passed',exitCode:0,stdout:records.map(x=>JSON.stringify(x)).join('\n'),stderr:'',durationMs:1200,truncated:false});
test('Claude final result keeps only bounded numeric metrics with explicit limited coverage',()=>{
 const parsed=parseProviderResult('claude',process([native]));
 assert.deepEqual(parsed.claudeResultMetrics,{coverage:'final-result-provider-reported',duration_ms:1100,duration_api_ms:500,num_turns:7,
  modelUsage:{'claude-opus-5-5':{inputTokens:20,outputTokens:5,costUSD:0.002}}});
 assert.deepEqual(validateClaudeResultMetrics(parsed.claudeResultMetrics),parsed.claudeResultMetrics);
 assert.equal(parseProviderResult('codex',process([{...native,type:'turn.completed'}])).claudeResultMetrics,undefined);
});
test('malformed model names, free text, negative and nonfinite numbers never enter metrics',()=>{
 assert.equal(extractClaudeResultMetrics({duration_ms:-1,num_turns:1.5,duration_api_ms:Infinity,modelUsage:{'token=secret':{inputTokens:1}}}),undefined);
 const good=extractClaudeResultMetrics(native)!;
 for(const bad of [{...good,secret:'s'},{...good,num_turns:-1},{...good,modelUsage:{'claude-opus':{inputTokens:1,secret:'s'}}},{...good,modelUsage:{'not-model':{inputTokens:1}}},{...good,duration_api_ms:Infinity}])assert.throws(()=>validateClaudeResultMetrics(bad));
});
test('metrics describe only last native receipt and never silently sum repeated results',()=>{
 const first={...native,duration_ms:9000};
 const parsed=parseProviderResult('claude',process([first,native]));
 assert.equal(parsed.claudeResultMetrics,undefined); // Multiple unbound receipts are not trusted.
 const single=parseProviderResult('claude',process([{type:'assistant',message:{usage:{output_tokens:900}}},native]));
 assert.equal(single.claudeResultMetrics?.num_turns,7);
 assert.equal(single.claudeResultMetrics?.duration_ms,1100);
});
