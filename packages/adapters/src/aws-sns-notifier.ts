import { createHash, createHmac } from 'node:crypto';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';

/**
 * Notification kinds. `urgent` kinds go to every subscription; the others carry `channel=email` so an SMS
 * subscription filtered on `channel` urgent-or-absent skips them (SMS has a small monthly quota; budget
 * alerts from AWS Budgets carry no attribute and must still reach SMS).
 */
export const NOTIFICATION_KINDS = {
  release_published: { urgent: false },
  release_failed: { urgent: false },
  task_finished: { urgent: false },
  /** A worker wrote a proposal to change protected paths under plans/improvements/; a person reviews it. */
  improvement_proposed: { urgent: false },
  budget_exhausted: { urgent: true },
  loop_stopped: { urgent: true },
  auto_merge_refused: { urgent: true },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export interface NotificationInput {
  kind: NotificationKind;
  subject: string;
  message: string;
}

export interface NotifierPort {
  notify(input: NotificationInput, signal?: AbortSignal): Promise<{ messageId: string }>;
}

const TOPIC_ARN = /^arn:aws:sns:([a-z]{2}-[a-z]+-\d+):\d{12}:[A-Za-z0-9_-]{1,256}$/;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Publishes to one SNS topic with SigV4, over the regional endpoint of the topic. */
export function createAwsSnsNotifier(options: {
  topicArn: string;
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  /** Values that must never leave in a message (tokens). They are replaced before sending. */
  redact?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
}): NotifierPort {
  const match = TOPIC_ARN.exec(options.topicArn);
  if (!match) throw new Error('Invalid SNS topic ARN');
  const region = match[1]!;
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const scrub = (value: string) => {
    let out = value;
    for (const secret of options.redact ?? []) if (secret) out = out.split(secret).join('[REDACTED]');
    return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  };

  return {
    async notify(input, signal) {
      const kind = NOTIFICATION_KINDS[input.kind];
      if (!kind) throw new Error(`Unknown notification kind: ${input.kind}`);
      const subject = scrub(input.subject).replace(/[\r\n]+/g, ' ').slice(0, 99) || 'HIVEMIND';
      const message = scrub(input.message).slice(0, 4000);
      const params: Record<string, string> = {
        Action: 'Publish',
        Version: '2010-03-31',
        TopicArn: options.topicArn,
        Subject: subject,
        Message: message,
        'MessageAttributes.entry.1.Name': 'channel',
        'MessageAttributes.entry.1.Value.DataType': 'String',
        'MessageAttributes.entry.1.Value.StringValue': kind.urgent ? 'urgent' : 'email',
        'MessageAttributes.entry.2.Name': 'kind',
        'MessageAttributes.entry.2.Value.DataType': 'String',
        'MessageAttributes.entry.2.Value.StringValue': input.kind,
      };
      const body = new URLSearchParams(params).toString();
      const credentials = await options.credentials();
      const host = `sns.${region}.amazonaws.com`;
      const stamp = new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g, '');
      const day = stamp.slice(0, 8);
      const scope = `${day}/${region}/sns/aws4_request`;
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        host,
        'x-amz-date': stamp,
        ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
      };
      const keys = Object.keys(headers).sort();
      const canonical = ['POST', '/', '', keys.map((k) => `${k}:${headers[k]}\n`).join(''), keys.join(';'), sha(body)].join('\n');
      const hmac = (key: string | Uint8Array, value: string) => createHmac('sha256', key).update(value).digest();
      let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
      for (const part of [region, 'sns', 'aws4_request']) key = hmac(key, part);
      const signature = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', stamp, scope, sha(canonical)].join('\n')).digest('hex');
      headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${keys.join(';')}, Signature=${signature}`;
      const response = await fetcher(`https://${host}/`, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      const messageId = /<MessageId>([^<]+)<\/MessageId>/.exec(text)?.[1];
      if (!response.ok || !messageId) throw new Error(`SNS Publish failed with HTTP ${response.status}`);
      return { messageId };
    },
  };
}
