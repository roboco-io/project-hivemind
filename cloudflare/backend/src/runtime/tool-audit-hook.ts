import {autonomousToolGate,loadAutonomousPolicy,type AutonomousPolicy} from './autonomous-tool-hook.ts';
import {bashHookReply} from './claude-bash-hook.ts';
import {AUTONOMOUS_EXTERNAL_TOOL} from '../runtime-shared/autonomous.ts';
import {redactText,summarizeToolInput} from './tool-audit-redact.ts';
import {appendToolAuditLine} from './tool-audit-spool.ts';
import {pathToFileURL} from 'node:url';
export const TOOL_AUDIT_SPOOL='/home/node/.hivemind-phase0/tool-audit.jsonl';
const MAX_HOOK_BYTES=1024*1024;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export type ToolAuditEventName='PreToolUse'|'PostToolUse'|'PostToolUseFailure';
export interface ToolAuditHookOptions {policy:AutonomousPolicy|undefined;secrets:readonly string[];now:()=>number;append:(line:string)=>Promise<unknown>;eventName?:string}
/**
 * Payload fields (hook_event_name, session_id, tool_use_id, tool_name, tool_input, agent_id) are an unverified
 * assumption for Claude Code 2.1.319, so they are parsed defensively. Pre events fail closed when the spool is unwritable;
 * Post events never block the tool. The verdict is recomputed with autonomousToolGate because parallel hooks cannot see each other.
 */
export async function recordToolAuditEvent(event:unknown,o:ToolAuditHookOptions):Promise<void> {
 const e=event&&typeof event==='object'&&!Array.isArray(event)?event as Record<string,unknown>:{};
 const name=typeof e.hook_event_name==='string'?e.hook_event_name:o.eventName;
 const at=o.now(),toolUseId=id(e.tool_use_id)?e.tool_use_id:undefined;
 if(name==='PostToolUse'||name==='PostToolUseFailure'){
  if(!toolUseId)return;
  try{await o.append(JSON.stringify({v:1,t:'e',id:toolUseId,ok:name==='PostToolUse',at}));}catch{}
  return;
 }
 if(name!=='PreToolUse')throw Error('Unknown tool audit event');
 const tool=typeof e.tool_name==='string'&&e.tool_name?[...e.tool_name].slice(0,64).join(''):'unknown';
 let outcome:'allowed'|'denied'='allowed';
 // Only a verdict some registered gate hook really enforces may be recorded as denied. Bash is gated by claude-bash-hook and
 // autonomous-tool-hook, Agent/WebFetch/external by autonomous-tool-hook. Any other tool has no gate hook, so its call is
 // not denied by a hook; claiming 'denied' would be a false record for a call that may have run.
 if(GATED_TOOLS.has(tool)){try{autonomousToolGate(event,o.policy);if(tool==='Bash')bashHookReply(event);}catch{outcome='denied';}}
 const s=summarizeToolInput(tool,e.tool_input,o.secrets);
 const line=JSON.stringify({v:1,t:'s',...(toolUseId?{id:toolUseId}:{}),tool:redactTool(tool,o.secrets),digest:s.inputDigest,summary:s.inputSummary,truncated:s.inputTruncated,outcome,at,...(id(e.agent_id)?{sub:true}:{})});
 await o.append(line);
}
const GATED_TOOLS=new Set<string>(['Bash','Agent','WebFetch',AUTONOMOUS_EXTERNAL_TOOL]);
const redactTool=(tool:string,secrets:readonly string[])=>redactText(tool,secrets);
export function secretsFromEnvironment(env:NodeJS.ProcessEnv=process.env):string[] {
 return Object.entries(env).filter(([k,v])=>/token|secret|password|passwd|api[_-]?key|credential/i.test(k)&&typeof v==='string'&&v.length>=8).map(([,v])=>v as string);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  let bytes=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){const part=Buffer.from(chunk);bytes+=part.length;if(bytes>MAX_HOOK_BYTES)throw Error('Input limit');chunks.push(part);}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  let policy:AutonomousPolicy|undefined;try{policy=await loadAutonomousPolicy();}catch{policy=undefined;}
  await recordToolAuditEvent(value,{policy,secrets:secretsFromEnvironment(),now:Date.now,append:line=>appendToolAuditLine(process.env.HIVEMIND_TOOL_AUDIT_SPOOL??TOOL_AUDIT_SPOOL,line),eventName:process.argv[2]});
  process.stdout.write('{}\n');
 }catch{process.stderr.write('Tool audit could not be recorded.\n');process.exitCode=2;}
}
