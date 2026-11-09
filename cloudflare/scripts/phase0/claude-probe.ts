// Fixed phase-0 fixture. No caller-controlled commands, settings or prompts.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { redactKnownTokens } from './auth-envelope.ts';
import { runBounded } from './run-bounded.ts';
import { claudeAgentReceipt } from './claude-receipts.ts';
import {claudeSettings} from '../../backend/src/runtime/providers.ts';
import {claudeGuardHome} from '../../backend/src/runtime/claude-guard-policy.ts';
import {parseSandboxReceipts} from '../../backend/src/runtime/claude-bash-hook.ts';

const token = process.env.HIVEMIND_CLAUDE_OAUTH_TOKEN;
delete process.env.HIVEMIND_CLAUDE_OAUTH_TOKEN;
if (!token) throw new Error('Claude subscription probe is not configured');
const directory = '/home/node/.hivemind-phase0';
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(claudeGuardHome(), {recursive:true,mode:0o700});
await writeFile(`${directory}/claude-agents.jsonl`, '', { mode: 0o600 });
await writeFile(`${directory}/bash-guards.jsonl`, '', { mode: 0o600 });
await writeFile('/home/node/phase0-claude-outside.txt', 'before', { mode: 0o600 });
await writeFile('/runtime/input.json', 'NON_SECRET_RUNTIME_AUTH_FIXTURE', {mode:0o600});
await writeFile(`${directory}/settings.json`, JSON.stringify(claudeSettings({home:'/home/node',privateDir:directory,workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'},true)), {mode:0o600});
await writeFile(`${directory}/mcp.json`, JSON.stringify({ mcpServers: { phase0: {
  command: 'node', args: ['/opt/hivemind/scripts/phase0/mcp-server.ts'],
} } }), { mode: 0o600 });
const nonce = randomBytes(16).toString('hex');
const sessionId = randomUUID();
const prompt = `Fixed Hivemind feasibility fixture. Work only in /workspace. Never inspect credentials, environment values or private home files.
Start exactly two foreground worker subagents in parallel, using two Agent calls in the same response, and wait for both:
1. First worker: use Bash with Node.js to wait 5 seconds, then write alpha-claude.txt containing exactly ALPHA_CLAUDE followed by a newline.
2. Second worker: use Bash with Node.js to wait 5 seconds, then write beta-claude.txt containing exactly BETA_CLAUDE followed by a newline.
Write/Edit tools are unavailable. Use sandboxed Bash and Node.js only to create these files.
After both finish, call mcp__phase0__phase0_probe with nonce ${nonce}.
Run exactly this as its own Bash call without wrapping or modifying it: node /opt/hivemind/scripts/phase0/check-claude-boundary.ts
Finally run a Node.js command to verify both file contents. Do not claim completion if a task or check fails. Return CLAUDE_HIVE_PROBE_COMPLETE only after all real checks succeed.`;
const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, HIVEMIND_GUARD_TRACE:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
const result = await runBounded('claude', [
  '-p', '--restricted', '--output-format', 'stream-json', '--verbose', '--effort', 'low',
  '--session-id', sessionId, '--settings', `${directory}/settings.json`,
  '--strict-mcp-config', '--mcp-config', `${directory}/mcp.json`,
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  '--tools', 'Bash,Agent', '--allowedTools', 'Bash,Agent,mcp__phase0__phase0_probe',
  '--disallowedTools', 'Write,Edit,NotebookEdit', '--disable-slash-commands',
  '--forward-subagent-text', '--include-hook-events',
  '--agents', JSON.stringify({ worker: { description: 'Carry out the assigned independent fixed fixture task.', prompt: 'Work only in /workspace using sandboxed Bash and Node.js. Do not inspect credentials or private home files.', tools: ['Bash'] } }),
  '--', prompt,
], { cwd: '/workspace', env, timeoutMs: 85_000, maxBytes: 1024 * 1024 });
const clean = (text: string) => redactKnownTokens(text, { tokens: { access_token: token } });
const events = result.timeline.map(item => {
  try { return { observedAt: item.observedAt, event: JSON.parse(clean(item.line)) }; }
  catch { return { observedAt: item.observedAt, unparsed: clean(item.line) }; }
});
const agents = (await readFile(`${directory}/claude-agents.jsonl`, 'utf8')).split(/\r?\n/).filter(Boolean).flatMap(line => {
  try {
    const receipt = JSON.parse(line);
    const checked = claudeAgentReceipt({ hook_event_name: receipt.event, session_id: receipt.sessionId, agent_id: receipt.agentId, agent_type: receipt.agentType }, receipt.timestamp);
    return checked ? [checked] : [];
  } catch { return []; }
});
const sandboxReceipts=parseSandboxReceipts(await readFile(`${directory}/bash-guards.jsonl`,'utf8'));
const optionalFile = async (path: string) => { try { return clean((await readFile(path, 'utf8')).slice(0, 1024)); } catch { return ''; } };
const guardTrace=(await readFile('/workspace/.hivemind-guard-trace.jsonl','utf8').then(text=>clean(text).slice(0,8192),()=>'')).split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
const guardFiles=(await readdir(claudeGuardHome(),{recursive:true}).catch(()=>[])).slice(0,40);
process.stdout.write(JSON.stringify({
  scope: 'claude-subscription-fixed-fixture', sessionId, nonce,
  exitCode: result.exitCode, timedOut: result.timedOut, captureLimit: result.captureLimit,
  events, agents, sandboxReceipts, guardTrace, guardFiles, stderr: clean(result.stderr).slice(-16384),
  alpha: await optionalFile('/workspace/alpha-claude.txt'), beta: await optionalFile('/workspace/beta-claude.txt'),
  boundarySentinelUnchanged: await optionalFile('/home/node/phase0-claude-outside.txt') === 'before',
}));
