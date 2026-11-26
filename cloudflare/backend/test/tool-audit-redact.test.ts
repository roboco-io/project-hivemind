import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {redactText,summarizeToolInput,TOOL_AUDIT_LIMITS} from '../src/runtime/tool-audit-redact.ts';
import {TOOL_AUDIT_LIMITS as CONTRACT_LIMITS} from '../../../packages/contracts/src/autonomous-tool-audit.ts';
test('HF token assignment is redacted and digest uses the raw command',()=>{
 const command='export HF_TOKEN=hf_abcdefghijklmnopqrstuvwx; ls';
 const s=summarizeToolInput('Bash',{command},[]);
 assert.equal(s.inputSummary,'export HF_TOKEN=[REDACTED]; ls');
 assert.equal(s.inputDigest,createHash('sha256').update(command).digest('hex'));
 assert.equal(s.inputTruncated,false);
});
test('60000 byte command is truncated within limits',()=>{
 const s=summarizeToolInput('Bash',{command:'é'.repeat(30000)},[]);
 assert.ok(Buffer.byteLength(s.inputSummary)<=512);assert.equal(s.inputTruncated,true);
 assert.ok(!s.inputSummary.includes('�'));
 const quoted=summarizeToolInput('Bash',{command:'"\n\0'.repeat(20000)},[]);
 assert.ok(Buffer.byteLength(JSON.stringify(quoted))<=1024-200);
});
test('secret patterns',()=>{
 const cases=['sk-ant-api03-abcdefghijkl','sk-proj-abcdefghijkl','ghp_abcdefghijklmnopqrstu','github_pat_abcdefghijklmnop12','AKIAABCDEFGHIJKLMNOP'];
 for(const c of cases)assert.equal(redactText('x '+c+' y',[]),'x [REDACTED] y',c);
 assert.equal(redactText('Authorization: Bearer abc.def-ghi1234',[]),'Authorization: [REDACTED]');
 assert.equal(redactText('curl -H "Authorization: Basic dXNlcjpwYXNz" u',[]),'curl -H "Authorization: [REDACTED]" u');
 assert.equal(redactText('use Bearer abcdefgh12345 now',[]),'use Bearer [REDACTED] now');
 assert.equal(redactText('git clone https://user:pw@github.com/a/b',[]),'git clone https://[REDACTED]@github.com/a/b');
 assert.equal(redactText('password: hunter2 api-key=abc',[]),'password: [REDACTED] api-key=[REDACTED]');
 assert.equal(redactText('a -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- b',[]),'a [REDACTED] b');
 assert.equal(redactText('truncated -----BEGIN RSA PRIVATE KEY-----\nMIIE',[]),'truncated [REDACTED]');
 assert.equal(redactText('echo mysecretvalue and mysecretvalue2',['mysecretvalue']),'echo [REDACTED] and [REDACTED]2');
 assert.equal(redactText('ls -la /tmp',[]),'ls -la /tmp');
});
test('non-Bash input digests canonical JSON independent of key order',()=>{
 const a=summarizeToolInput('Read',{b:1,a:{d:1,c:2}},[]),b=summarizeToolInput('Read',{a:{c:2,d:1},b:1},[]);
 assert.equal(a.inputDigest,b.inputDigest);assert.equal(a.inputSummary,'{"a":{"c":2,"d":1},"b":1}');
});
test('limits equal the contracts constant',()=>{assert.deepEqual({...TOOL_AUDIT_LIMITS},{...CONTRACT_LIMITS});});
test('quoted values with escaped quotes or spaces are removed completely, including JSON-escaped input',()=>{
 assert.equal(redactText('echo {"token":"a\\"bcd efg"} done',[]),'echo {"token":[REDACTED]} done');
 assert.equal(redactText("PASSWORD='it\\'s secret' ls",[]),'PASSWORD=[REDACTED] ls');
 const s=summarizeToolInput('Write',{content:'password="hunter two" x'},[]).inputSummary;
 assert.ok(!s.includes('hunter')&&!s.includes('two'),s);
});
