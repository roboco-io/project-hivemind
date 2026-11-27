import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { NotificationGate } from '../apps/control-plane/src/notifications-api.js';
import { createAwsSnsNotifier, type NotifierPort } from '../packages/adapters/src/aws-sns-notifier.js';

const TOPIC = 'arn:aws:sns:us-east-2:123456789012:smf-budget';

function capture() {
  const bodies: URLSearchParams[] = [];
  const hosts: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    hosts.push(new URL(String(url)).host);
    bodies.push(new URLSearchParams(String(init?.body)));
    return new Response('<PublishResponse><PublishResult><MessageId>m-1</MessageId></PublishResult></PublishResponse>', { status: 200 });
  }) as typeof fetch;
  return { bodies, hosts, fetchImpl };
}

test('SNS notifications carry a channel attribute: urgent kinds for every subscription, others email only', async () => {
  const { bodies, hosts, fetchImpl } = capture();
  const notifier = createAwsSnsNotifier({ topicArn: TOPIC, credentials: () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's'.repeat(40) }), fetch: fetchImpl, redact: ['secret-token-value-1234567890'] });
  assert.deepEqual(await notifier.notify({ kind: 'release_published', subject: 'Released\nmodel', message: 'ok with secret-token-value-1234567890' }), { messageId: 'm-1' });
  await notifier.notify({ kind: 'budget_exhausted', subject: 'Budget', message: 'cap reached' });
  assert.deepEqual(hosts, ['sns.us-east-2.amazonaws.com', 'sns.us-east-2.amazonaws.com']);
  assert.equal(bodies[0]!.get('TopicArn'), TOPIC);
  assert.equal(bodies[0]!.get('MessageAttributes.entry.1.Value.StringValue'), 'email');
  assert.equal(bodies[1]!.get('MessageAttributes.entry.1.Value.StringValue'), 'urgent');
  assert.equal(bodies[0]!.get('MessageAttributes.entry.2.Value.StringValue'), 'release_published');
  assert.equal(bodies[0]!.get('Subject'), 'Released model');
  assert.equal(bodies[0]!.get('Message'), 'ok with [REDACTED]');
  assert.throws(() => createAwsSnsNotifier({ topicArn: 'arn:aws:sqs:us-east-2:1:x', credentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }) }));
});

test('the notification gate sends at most the hourly limit and quiet sends never throw', async () => {
  let clock = 0;
  const sent: string[] = [];
  const notifier: NotifierPort = { async notify(input) { sent.push(input.kind); return { messageId: String(sent.length) }; } };
  const gate = new NotificationGate(notifier, 2, () => clock);
  assert.ok('messageId' in (await gate.send('task_finished', 's', 'm')));
  await gate.send('task_finished', 's', 'm');
  assert.deepEqual(await gate.send('task_finished', 's', 'm'), { skipped: 'rate_limited' });
  clock += 3_600_001;
  assert.ok('messageId' in (await gate.send('loop_stopped', 's', 'm')));
  const failing = new NotificationGate({ async notify() { throw new Error('SNS down'); } });
  await failing.sendQuietly('release_failed', 's', 'm');
});

test('the notification API accepts the operator and the agent, only known kinds, and hides SNS errors', async (t) => {
  const OP = 'operator-token-0000000000000000000001';
  const AG = 'agent-token-000000000000000000000003';
  const sent: string[] = [];
  let fail = false;
  const gate = new NotificationGate({ async notify(input) { if (fail) throw new Error('AccessDenied arn:aws:sns:...'); sent.push(`${input.kind}:${input.subject}`); return { messageId: 'x' }; } });
  const app = buildApp({ operatorToken: OP, workerToken: 'worker-token-00000000000000000000002', agentToken: AG, notifications: gate });
  t.after(() => app.close());
  const post = (token: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/notifications', headers: { authorization: `Bearer ${token}` }, payload });
  assert.equal((await post(AG, { kind: 'task_finished', subject: 'Task done', message: 'rtl-repair finished' })).statusCode, 200);
  assert.equal((await post(OP, { kind: 'loop_stopped', subject: 'Stopped', message: 'three failures' })).statusCode, 200);
  assert.equal((await post('wrong', { kind: 'task_finished', subject: 's', message: 'm' })).statusCode, 401);
  assert.equal((await post(AG, { kind: 'anything', subject: 's', message: 'm' })).statusCode, 400);
  assert.equal((await post(AG, { kind: 'task_finished', subject: '', message: 'm' })).statusCode, 400);
  fail = true;
  const failed = await post(AG, { kind: 'task_finished', subject: 's', message: 'm' });
  assert.equal(failed.statusCode, 502);
  assert.doesNotMatch(failed.body, /arn:aws/);
  assert.deepEqual(sent, ['task_finished:Task done', 'loop_stopped:Stopped']);
});
