import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open} from 'node:fs/promises';
export const MAX_HOOK_BYTES=1024*1024;
export const MAX_COMMAND_BYTES=64*1024;
export const GUARD='/opt/hivemind/backend/src/runtime/claude-command-guard.ts';
export interface SandboxReceipt {sessionId:string;agentId:string|null;toolUseId:string;commandHash:string;timestamp:string}
const auditDirectory='/home/node/.hivemind-phase0';
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function checkedReceipt(value:unknown):SandboxReceipt {
 const invalid=()=>new Error('Invalid sandbox audit metadata');
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const item=value as Record<string,unknown>;
 if(!id(item.sessionId)||!(item.agentId===null||id(item.agentId))||!id(item.toolUseId)||typeof item.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(item.commandHash)||typeof item.timestamp!=='string'||item.timestamp.length!==24||!Number.isFinite(Date.parse(item.timestamp))||new Date(item.timestamp).toISOString()!==item.timestamp)throw invalid();
 return {sessionId:item.sessionId,agentId:item.agentId,toolUseId:item.toolUseId,commandHash:item.commandHash,timestamp:item.timestamp};
}
export function sandboxReceipt(value:unknown,timestamp:string):SandboxReceipt {
 bashHookReply(value);const item=value as {session_id:unknown;agent_id?:unknown;tool_use_id:unknown;tool_input:{command:string}};
 try{return checkedReceipt({sessionId:item.session_id,agentId:item.agent_id??null,toolUseId:item.tool_use_id,commandHash:createHash('sha256').update(item.tool_input.command).digest('hex'),timestamp});}catch{throw new Error('Protected Bash input is required');}
}
export function parseSandboxReceipts(raw:string):SandboxReceipt[] {
 if(Buffer.byteLength(raw)>MAX_HOOK_BYTES)throw new Error('Invalid sandbox audit metadata');const lines=raw.split(/\r?\n/).filter(Boolean);
 if(lines.length>256)throw new Error('Invalid sandbox audit metadata');
 try{return lines.map(line=>checkedReceipt(JSON.parse(line)));}catch{throw new Error('Invalid sandbox audit metadata');}
}
export async function auditedBashHookReply(value:unknown,timestamp:string,append:(receipt:SandboxReceipt)=>Promise<void>):Promise<unknown> {
 const reply=bashHookReply(value),receipt=sandboxReceipt(value,timestamp);
 try{await append(receipt);}catch{throw new Error('Sandbox audit could not be persisted');}return reply;
}
async function appendAudit(receipt:SandboxReceipt):Promise<void> {
 await mkdir(auditDirectory,{recursive:true,mode:0o700});
 const file=await open(auditDirectory+'/bash-guards.jsonl',constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.nlink!==1)throw new Error('Invalid audit destination');await file.writeFile(JSON.stringify(receipt)+'\n');await file.sync();}finally{await file.close();}
}
export function shellQuote(value:string):string {return "'"+value.replaceAll("'","'\\''")+"'";}
export function bashHookReply(value:unknown):unknown {
 const invalid=()=>new Error('Protected Bash input is required');
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const event=value as Record<string,unknown>;
 if(event.tool_name!=='Bash'||!event.tool_input||typeof event.tool_input!=='object'||Array.isArray(event.tool_input))throw invalid();
 const input=event.tool_input as Record<string,unknown>,command=input.command;
 if(typeof command!=='string'||!command||command.includes('\0')||Buffer.byteLength(command)>MAX_COMMAND_BYTES||(input.dangerouslyDisableSandbox!==undefined&&input.dangerouslyDisableSandbox!==false))throw invalid();
 return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input,command:`${shellQuote(GUARD)} -- /bin/bash -c ${shellQuote(command)}`}}};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{let bytes=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){const part=Buffer.from(chunk);bytes+=part.length;if(bytes>MAX_HOOK_BYTES)throw new Error('Input limit');chunks.push(part);}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));const reply=await auditedBashHookReply(value,new Date().toISOString(),appendAudit);process.stdout.write(JSON.stringify(reply)+'\n');}
 catch{process.stderr.write('Hivemind requires a protected Bash command.\n');process.exitCode=2;}
}
