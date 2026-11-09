import { appendFileSync, writeFileSync, readFileSync, writeSync } from 'node:fs';

let outsideDenied = false, receiptDenied = false;
try { writeFileSync('/home/node/phase0-claude-outside.txt', 'escaped'); } catch { outsideDenied = true; }
try { appendFileSync('/home/node/.hivemind-phase0/claude-agents.jsonl', 'forged'); } catch { receiptDenied = true; }
const managed = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'PROBE_TOKEN', 'AUTH_WRAP_KEY'];
const noContent = (path: string) => { try { return readFileSync(path).length === 0; } catch { return true; } };
const runtimeInputReadDenied = noContent('/runtime/input.json');
const privateReadDenied = noContent('/home/node/.hivemind-phase0/claude-agents.jsonl');
const parentEnvironmentDenied = noContent(`/proc/${process.ppid}/environ`);
const guardApplied=process.env.HIVEMIND_NAMESPACE_GUARD==='seccomp-v1';
const subscriptionTokenAbsent = !process.env.CLAUDE_CODE_OAUTH_TOKEN;
const managementSecretsAbsent = managed.every(key => !process.env[key]);
if (!outsideDenied || !receiptDenied || !privateReadDenied || !runtimeInputReadDenied || !parentEnvironmentDenied || !guardApplied || !subscriptionTokenAbsent || !managementSecretsAbsent) process.exit(31);
writeSync(1,'CLAUDE_SANDBOX_BOUNDARIES_VERIFIED\n');
