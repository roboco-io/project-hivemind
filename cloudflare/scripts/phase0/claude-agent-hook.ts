import { appendFile } from 'node:fs/promises';
import { claudeAgentReceipt } from './claude-receipts.ts';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(1);
}
let value: unknown;
try { value = JSON.parse(input); } catch { process.exit(1); }
const receipt = claudeAgentReceipt(value, new Date().toISOString());
if (receipt) await appendFile('/home/node/.hivemind-phase0/claude-agents.jsonl', JSON.stringify(receipt)+'\n', { mode: 0o600 });
