import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { loadWorkerSettings } from '../apps/worker/src/config.js';

test('default worker remains mock and requires no repository or credentials for Codex',()=>{
  const config = loadWorkerSettings({});
  assert.equal(config.provider,'mock');
  assert.equal(config.codex,undefined);
  assert.equal(config.apiUrl,'http://127.0.0.1:4310');
});
test('Codex configuration requires an operator repository and preserves argv boundaries',()=>{
  assert.throws(()=>loadWorkerSettings({HIVEMIND_PROVIDER:'codex'}),/REPO_PATH/);
  const config = loadWorkerSettings({HIVEMIND_PROVIDER:'codex',HIVEMIND_REPO_PATH:'.',HIVEMIND_TEST_COMMAND:'["node","--test","file with spaces.test.js"]',HIVEMIND_SETUP_COMMAND:'["npm","ci","--ignore-scripts"]'});
  assert.equal(config.provider,'codex'); assert.equal(config.repositoryId,'local');
  assert.ok(isAbsolute(config.codex!.repositoryPath));
  assert.deepEqual(config.codex!.testCommand,['node','--test','file with spaces.test.js']);
  assert.deepEqual(config.codex!.setupCommand,['npm','ci','--ignore-scripts']);
  assert.equal(config.codex!.model,undefined);
});
test('bad providers, command strings and invalid execution deadlines fail at startup',()=>{
  const base = {HIVEMIND_PROVIDER:'codex',HIVEMIND_REPO_PATH:'.'};
  assert.throws(()=>loadWorkerSettings({HIVEMIND_PROVIDER:'unsupported'}),/PROVIDER/);
  for(const value of ['npm test','[]','["node",1]','[""]','["node","\\u0000"]']) assert.throws(()=>loadWorkerSettings({...base,HIVEMIND_TEST_COMMAND:value}),/TEST_COMMAND/);
  assert.throws(()=>loadWorkerSettings({...base,HIVEMIND_CODEX_TIMEOUT_MS:'NaN'}),/TIMEOUT/);
  assert.throws(()=>loadWorkerSettings({...base,HIVEMIND_TEST_TIMEOUT_MS:'-1'}),/TIMEOUT/);
});

test('Claude worker has independent CLI, model and timeout settings with shared repository policy',()=>{
  assert.throws(()=>loadWorkerSettings({HIVEMIND_PROVIDER:'claude'}),/REPO_PATH/);
  const config=loadWorkerSettings({HIVEMIND_PROVIDER:'claude',HIVEMIND_REPO_PATH:'.',HIVEMIND_CLAUDE_BIN:'/opt/test/claude',HIVEMIND_CLAUDE_MODEL:'configured-model',HIVEMIND_CLAUDE_TIMEOUT_MS:'123000',HIVEMIND_TEST_COMMAND:'["node","--test"]'});
  assert.equal(config.provider,'claude');assert.equal(config.codex,undefined);
  assert.equal(config.workerId,'worker-claude-1');assert.equal(config.repositoryId,'local');
  assert.equal(config.claude!.claudeCommand,'/opt/test/claude');
  assert.equal(config.claude!.model,'configured-model');assert.equal(config.claude!.timeoutMs,123000);
  assert.deepEqual(config.claude!.testCommand,['node','--test']);
  assert.equal(loadWorkerSettings({HIVEMIND_PROVIDER:'claude',HIVEMIND_REPO_PATH:'.'}).claude!.model,undefined);
});
