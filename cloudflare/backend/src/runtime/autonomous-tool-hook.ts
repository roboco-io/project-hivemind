import {validateAutonomousCapabilities,validateAutonomousModelPin,AUTONOMOUS_EXTERNAL_TOOL} from '../runtime-shared/autonomous.ts';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export const AUTONOMOUS_POLICY='/home/node/.hivemind-phase0/autonomous-policy.json';
export interface AutonomousPolicy {version:1;tools:string[];model:string;subagentModel:string;web?:{allowedHosts:string[]};externalProfiles?:string[]}
export function validateAutonomousPolicy(value:unknown):AutonomousPolicy {
 const p=value as AutonomousPolicy;
 if(!p||Object.keys(p).some(key=>!['model','subagentModel','tools','version','web','externalProfiles'].includes(key))||p.version!==1)throw Error('Invalid autonomous policy');
 validateAutonomousModelPin(p.model);validateAutonomousModelPin(p.subagentModel);
 validateAutonomousCapabilities(p);
 return p;
}
export async function loadAutonomousPolicy(path=AUTONOMOUS_POLICY):Promise<AutonomousPolicy|undefined>{
 let parent;try{parent=await lstat(path.slice(0,path.lastIndexOf('/')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o022))throw Error('Unsafe policy parent');
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 try{const s=await file.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.size>16384)throw Error('Unsafe policy');return validateAutonomousPolicy(JSON.parse(await file.readFile('utf8')));}finally{await file.close();}
}
export function autonomousToolGate(event:unknown,policy:AutonomousPolicy|undefined):void {
 const e=event as {tool_name?:string;tool_input?:Record<string,unknown>};
 if(!policy){if(e?.tool_name==='WebFetch'||e?.tool_name===AUTONOMOUS_EXTERNAL_TOOL)throw Error('Autonomous policy required');return;}validateAutonomousPolicy(policy);
 if(!e||!policy.tools.includes(e.tool_name??''))throw Error('Unapproved autonomous tool');
 if(e.tool_name==='WebFetch'){
  const input=e.tool_input;if(!input||Object.keys(input).some(key=>!['url','prompt'].includes(key))||typeof input.url!=='string'||input.url.length>8192||!/^[\x21-\x7e]+$/.test(input.url)||input.url.includes('\\')||typeof input.prompt!=='string'||!input.prompt||input.prompt.length>24000)throw Error('Unapproved WebFetch');
  const url=new URL(input.url);if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!policy.web?.allowedHosts.includes(url.hostname))throw Error('Unapproved WebFetch');
 }
 if(e.tool_name===AUTONOMOUS_EXTERNAL_TOOL&&(!e.tool_input||typeof e.tool_input.profileId!=='string'||!policy.externalProfiles?.includes(e.tool_input.profileId)))throw Error('Unapproved external profile');
 if(e.tool_name==='Agent'&&(!e.tool_input||e.tool_input.subagent_type!=='worker'||e.tool_input.model!==undefined||Object.keys(e.tool_input).some(k=>!['subagent_type','prompt','description','max_turns','run_in_background'].includes(k))||e.tool_input.run_in_background!==undefined&&e.tool_input.run_in_background!==false||!['prompt','description'].every(k=>typeof e.tool_input![k]==='string'&&(e.tool_input![k] as string).length>0&&(e.tool_input![k] as string).length<=24000)||e.tool_input.max_turns!==undefined&&(!Number.isSafeInteger(e.tool_input.max_turns)||Number(e.tool_input.max_turns)<1||Number(e.tool_input.max_turns)>100)))throw Error('Unapproved autonomous worker');
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>1048576)throw Error();}autonomousToolGate(JSON.parse(raw),await loadAutonomousPolicy());process.stdout.write('{}\n');}catch{process.stderr.write('Autonomous tool denied\n');process.exitCode=2;}}
