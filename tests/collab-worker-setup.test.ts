import assert from 'node:assert/strict';
import test from 'node:test';
import { setUpCollabWorkerOrFailSubtask } from '../apps/worker/src/collab-worker-setup.js';

test('collab worker set-up failure reports the subtask as failed and rethrows the original error', async () => {
  const reports: string[] = [];
  await assert.rejects(
    () =>
      setUpCollabWorkerOrFailSubtask(
        async () => {
          throw new Error('ModelSubscriptionAuthSecret is missing claude credentials');
        },
        async (reason) => {
          reports.push(reason);
        },
      ),
    /missing claude credentials/,
  );
  assert.deepEqual(reports, [
    'Worker set-up failed before the model run: ModelSubscriptionAuthSecret is missing claude credentials',
  ]);

  // A failing report must not hide the set-up error, and a long reason is capped at 1000 characters.
  const capped: string[] = [];
  await assert.rejects(
    () =>
      setUpCollabWorkerOrFailSubtask(
        async () => {
          throw new Error('x'.repeat(5000));
        },
        async (reason) => {
          capped.push(reason);
          throw new Error('Collab API unreachable');
        },
      ),
    /^Error: x+$/,
  );
  assert.equal(capped[0]!.length, 1000);

  // A successful set-up returns its value and reports nothing.
  const quiet: string[] = [];
  assert.equal(await setUpCollabWorkerOrFailSubtask(async () => 'auth', async (r) => void quiet.push(r)), 'auth');
  assert.deepEqual(quiet, []);
});
