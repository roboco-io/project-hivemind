import test from 'node:test';
import assert from 'node:assert/strict';
import {processDiagnostic,sanitizeProcessStderr} from '../src/runtime/process-diagnostic.ts';
import {runProcess} from '../src/runtime/process.ts';

test('process stderr never retains arbitrary lines, secrets, user paths or telemetry payloads',()=>{
 const value=sanitizeProcessStderr('Error: EACCES open /private/secret token=secret\nBearer private-token\nHIVEMIND_PI_TOOL {"secret":"hidden"}\nTypeError: Cannot read properties of undefined');
 assert.deepEqual(value.messages,['EACCES: filesystem access denied','TypeError: accessed a property on an absent value']);
 assert.equal(value.omittedLines,1);
 assert.doesNotMatch(JSON.stringify(value),/private-token|\/private|hidden|token=secret/);
});
test('process diagnosis differentiates nonzero exit and killed processes',async()=>{
 const options={cwd:process.cwd(),env:process.env,timeoutMs:10000};
 const nonzero=await runProcess([process.execPath,'-e','console.error("EACCES private-data");process.exit(17)'],options);
 assert.equal(nonzero.exitCode,17);assert.equal(nonzero.signal,null);assert.equal(nonzero.terminationReason,'exit');
 assert.deepEqual(processDiagnostic(nonzero).stderr.messages,['EACCES: filesystem access denied']);
 const killed=await runProcess([process.execPath,'-e','process.kill(process.pid,"SIGTERM")'],options);
 assert.equal(killed.signal,'SIGTERM');assert.equal(killed.exitCode,null);assert.equal(killed.terminationReason,'signal');
});
