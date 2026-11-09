import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeThreads } from '../scripts/phase0/native-thread-receipts.ts';

test('native thread identity comes from the thread store without exporting prompt columns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hivemind-thread-metadata-'));
  const path = join(directory, 'state_5.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT, first_user_message TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('child-A', '/private/sessions/rollout-child-A.jsonl', '{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}', 'fixture-private-prompt');
    const receipts = readNativeThreads(path);
    assert.equal(receipts[0]?.threadId, 'child-A');
    assert.equal(receipts[0]?.rolloutFile, 'rollout-child-A.jsonl');
    assert.equal(JSON.stringify(receipts).includes('fixture-private-prompt'), false);
    assert.equal(JSON.stringify(receipts).includes('/private/sessions'), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});
