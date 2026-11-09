import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { collectLocal } from './collect.ts';

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  backend: { type: 'string', default: 'cloudflare' }, account: { type: 'string' },
  profile: { type: 'string' }, region: { type: 'string' },
} });
if (values.backend !== 'cloudflare' && values.backend !== 'aws') {
  process.stderr.write('Backend must be cloudflare or aws.\n');
  process.exit(1);
}

const report = await collectLocal({
  ...values, backend: values.backend,
  profile: values.backend === 'aws' ? values.profile ?? 'roboco' : undefined,
  region: values.backend === 'aws' ? values.region ?? 'ap-northeast-2' : undefined,
}, async (bin, args) => {
  try {
    const result = await exec(bin, args, {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024,
      env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
    });
    return { ok: true, stdout: result.stdout };
  } catch {
    // Credentials, endpoint URLs and provider errors must not enter the report.
    return { ok: false, stdout: '' };
  }
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
// Local preflight never grants permission to proceed past the real Fargate gate.
process.exitCode = report.gate.status === 'PASS' ? 0 : 2;
