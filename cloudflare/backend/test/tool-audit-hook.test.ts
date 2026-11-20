import test from 'node:test';
import assert from 'node:assert/strict';
import {recordToolAuditEvent} from '../src/runtime/tool-audit-hook.ts';
import {foldToolAuditSpool} from '../src/runtime/tool-audit-spool.ts';
const policy={version:1 as const,tools:['Bash','WebFetch'],model:'claude-opus-5-5',subagentModel:'claude-opus-5-5',web:{allowedHosts:['example.com']}};
function harness(over:Record<string,unknown>={}){
 const lines:string[]=[];let t=1000;
 return {lines,run:(event:unknown,more:Record<string,unknown>={})=>recordToolAuditEvent(event,{policy:policy as any,secrets:['topsecretvalue'],now:()=>t+=10,append:async (l:string)=>{lines.push(l);},...over,...more} as any)};
}
test('allowed Bash, post success, redaction',async()=>{
 const h=harness();
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'tu1',tool_name:'Bash',tool_input:{command:'echo topsecretvalue'}});
 await h.run({hook_event_name:'PostToolUse',tool_use_id:'tu1',tool_name:'Bash',tool_response:{stdout:'SECRETOUT'}});
 const raw=h.lines.join('\n')+'\n';assert.ok(!raw.includes('topsecretvalue')&&!raw.includes('SECRETOUT'));
 const r=foldToolAuditSpool(raw).records as any[];assert.equal(r.length,1);
 assert.deepEqual([r[0].tool,r[0].outcome,r[0].durationMs,r[0].inputSummary],['Bash','allowed',10,'echo [REDACTED]']);
});
test('disallowed WebFetch host is denied with null duration; hook itself does not throw',async()=>{
 const h=harness();
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'tu2',tool_name:'WebFetch',tool_input:{url:'https://evil.test/x',prompt:'p'}});
 const r=foldToolAuditSpool(h.lines.join('\n')+'\n').records[0]!;
 assert.equal(r.outcome,'denied');assert.equal(r.durationMs,null);
});
test('ungated tool is not recorded as denied; subagent flag, failure outcome',async()=>{
 const h=harness();
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'a',tool_name:'Write',tool_input:{}});
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'b',agent_id:'ag1',tool_name:'Bash',tool_input:{command:'ls'}});
 await h.run({hook_event_name:'PostToolUseFailure',tool_use_id:'b'});
 const r=foldToolAuditSpool(h.lines.join('\n')+'\n').records;
 assert.deepEqual(r.map(x=>[x.outcome,x.subagent]),[['allowed',undefined],['error',true]]);
});
test('PreToolUse fails closed when spool append fails; Post does not',async()=>{
 const h=harness({append:async()=>{throw Error('disk');}});
 await assert.rejects(h.run({hook_event_name:'PreToolUse',tool_use_id:'x',tool_name:'Read',tool_input:{}}));
 await h.run({hook_event_name:'PostToolUse',tool_use_id:'x'});
});
test('event name may come from argument; unknown or malformed events are handled defensively',async()=>{
 const h=harness();
 await h.run({tool_use_id:'q',tool_name:'Read',tool_input:{}},{eventName:'PreToolUse'});assert.equal(h.lines.length,1);
 await assert.rejects(h.run({tool_name:'Read'}));
 await assert.rejects(h.run(null));
 await h.run({hook_event_name:'PreToolUse'});assert.equal(foldToolAuditSpool(h.lines.join('\n')+'\n').records[1]!.tool,'unknown');
});
test('Bash that claude-bash-hook would reject (NUL byte, sandbox override) is recorded as denied',async()=>{
 const h=harness();
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'n1',tool_name:'Bash',tool_input:{command:'ls\0'}});
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'n2',tool_name:'Bash',tool_input:{command:'ls',dangerouslyDisableSandbox:true}});
 await h.run({hook_event_name:'PreToolUse',tool_use_id:'n3',tool_name:'Agent',tool_input:{subagent_type:'other'}});
 assert.deepEqual(foldToolAuditSpool(h.lines.join('\n')+'\n').records.map(r=>r.outcome),['denied','denied','denied']);
});
