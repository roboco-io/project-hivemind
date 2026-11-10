import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HivemindMcpConfigOptions { projectRoot:string; nodePath?:string; apiUrl?:string; operatorTokenFile?:string }
export interface HivemindMcpConfigResult { configPath:string; changed:boolean }
const begin='# BEGIN HIVEMIND MCP (managed)',end='# END HIVEMIND MCP (managed)';
function fail(message:string):never {throw new Error(message);}
function checkPath(path:string,kind:'directory'|'file'|'either',required=false):void {
  let stat;
  try {stat=lstatSync(path);} catch(error) {if(!required && (error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink() || (kind==='directory'&&!stat.isDirectory()) || (kind==='file'&&!stat.isFile()) || (kind==='either'&&!stat.isDirectory()&&!stat.isFile())) fail('Unsafe HIVEMIND configuration path.');
}
function checkChildren(root:string,parts:string[],file=false,required=false):void {
  let path=root;
  for(const [index,part] of parts.entries()) {path=join(path,part);checkPath(path,file&&index===parts.length-1?'file':'directory',required);}
}
function readOptional(path:string):string {return existsSync(path)?readFileSync(path,'utf8'):'';}
function git(root:string,args:string[]):string {
  const nullDevice=process.platform==='win32'?'NUL':'/dev/null';
  const env:NodeJS.ProcessEnv={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_SYSTEM:nullDevice};
  for(const key of ['PATH','LANG','LC_ALL','LC_CTYPE','SystemRoot','WINDIR','TMPDIR','TMP','TEMP']) {if(process.env[key]!==undefined)env[key]=process.env[key];}
  return execFileSync('git',['--no-optional-locks','-c','core.hooksPath='+nullDevice,'-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env,timeout:5000}).trim();
}
function keyParts(source:string):string[]|null {
  const keys:string[]=[];let rest=source.trim();
  while(rest) {
    let key='',used=0;
    if(rest[0]==='"'||rest[0]==="'") {
      const quote=rest[0];let finish=1;
      for(;finish<rest.length;finish++) {if(quote==='"'&&rest[finish]==='\\'){finish++;continue;}if(rest[finish]===quote)break;}
      if(finish===rest.length)return null;
      const quoted=rest.slice(0,finish+1);
      try {key=quote==="'"?quoted.slice(1,-1):JSON.parse(quoted.replace(/\\U([0-9a-fA-F]{8})/g,(_all,hex:string)=>String.fromCodePoint(parseInt(hex,16)))) as string;} catch{return null;}
      used=finish+1;
    } else {const match=/^[A-Za-z0-9_-]+/.exec(rest);if(!match)return null;key=match[0];used=key.length;}
    keys.push(key);rest=rest.slice(used).trimStart();if(!rest)break;if(rest[0]!=='.')return null;rest=rest.slice(1).trimStart();if(!rest)return null;
  }
  return keys.length?keys:null;
}
function assignmentKey(line:string):string|null {
  let quote='';
  for(let i=0;i<line.length;i++) {
    const char=line[i];if(quote) {if(char==='\\'&&quote==='"')i++;else if(char===quote)quote='';}
    else if(char==='"'||char==="'")quote=char;else if(char==='#')return null;else if(char==='=')return line.slice(0,i);
  }
  return null;
}
function refuseConflict(source:string):void {
  let table:string[]=[];
  for(const raw of source.split(/\r?\n/)) {
    const line=raw.trim();if(!line||line[0]==='#')continue;
    if(line[0]==='[') {
      const header=/^\[\[?\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if(!header)fail('Cannot safely inspect existing Codex configuration.');
      const parts=keyParts(header[1]!);if(!parts)fail('Cannot safely inspect existing Codex configuration.');table=parts;
      if(table[0]==='mcp_servers'&&table[1]==='hivemind')fail('An unmanaged HIVEMIND MCP server already exists.');
    } else {
      const key=assignmentKey(line);if(key===null)continue;const parts=keyParts(key);if(!parts)continue;const path=[...table,...parts];
      if(path[0]==='mcp_servers'&&(path.length===1||path[1]==='hivemind'))fail('An unmanaged HIVEMIND MCP server already exists.');
    }
  }
}
function managed(source:string,block:string):string {
  const starts=[...source.matchAll(/^# BEGIN HIVEMIND MCP \(managed\)\r?$/gm)],ends=[...source.matchAll(/^# END HIVEMIND MCP \(managed\)\r?$/gm)];
  if(starts.length===0&&ends.length===0) {refuseConflict(source);return source+(source&&!source.endsWith('\n')?'\n':'')+(source?'\n':'')+block;}
  if(starts.length!==1||ends.length!==1||starts[0]!.index>=ends[0]!.index)fail('Invalid managed HIVEMIND MCP block.');
  const start=starts[0]!.index,finish=ends[0]!.index+ends[0]![0].length;
  const prefix=source.slice(0,start),suffix=source.slice(finish+(source[finish]==='\n'?1:0));
  const next=suffix.split(/\r?\n/).map(l=>l.trim()).find(l=>l&&l[0]!=='#');
  if(next&&!next.startsWith('['))fail('Unmanaged settings follow the HIVEMIND MCP block.');
  refuseConflict(prefix+suffix);return prefix+block+suffix;
}
function atomicWrite(path:string,value:string):boolean {
  if(existsSync(path)&&readFileSync(path,'utf8')===value&&(lstatSync(path).mode&0o777)===0o600)return false;
  const temp=join(dirname(path),'.hivemind-'+randomUUID()+'.tmp');let fd:number|undefined;
  try {
    checkPath(path,'file');fd=openSync(temp,'wx',0o600);writeFileSync(fd,value,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
    checkPath(path,'file');renameSync(temp,path);return true;
  } finally {if(fd!==undefined)closeSync(fd);rmSync(temp,{force:true});}
}

export function configureHivemindMcp(options:HivemindMcpConfigOptions):HivemindMcpConfigResult {
  checkPath(resolve(options.projectRoot),'directory',true);const root=realpathSync(options.projectRoot);
  checkPath(join(root,'.git'),'either',true);if(realpathSync(git(root,['rev-parse','--show-toplevel']))!==root)fail('Run the installer at a Git project root.');
  const nodePath=options.nodePath??process.execPath;if(!isAbsolute(nodePath))fail('An absolute Node executable is required.');checkPath(nodePath,'file',true);
  const entryParts=['dist','apps','mcp-server','src','main.js'];checkChildren(root,entryParts,true,true);const entry=join(root,...entryParts);
  const rawUrl=options.apiUrl??'http://127.0.0.1:4310';let url:URL;
  try {url=new URL(rawUrl);}catch{fail('Invalid HIVEMIND API URL.');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(/\s/.test(rawUrl)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!loopback)||(!loopback&&!options.operatorTokenFile))fail('Invalid HIVEMIND API URL.');
  const tokenFile=options.operatorTokenFile?resolve(root,options.operatorTokenFile):undefined;if(tokenFile)checkPath(tokenFile,'file');
  const configPath=join(root,'.codex','config.toml');checkChildren(root,['.codex','config.toml'],true);
  let tracked=false;try {git(root,['ls-files','--error-unmatch','--','.codex/config.toml']);tracked=true;} catch(error) {if((error as {status?:number}).status!==1)throw error;}
  if(tracked)fail('Tracked project configuration cannot be modified.');
  const common=resolve(root,git(root,['rev-parse','--path-format=absolute','--git-common-dir']));checkPath(common,'directory',true);checkChildren(common,['info','exclude'],true);
  const excludePath=join(common,'info','exclude'),existingExclude=readOptional(excludePath),rule='/.codex/config.toml';
  const nextExclude=existingExclude.split(/\r?\n/).includes(rule)?existingExclude:existingExclude+(existingExclude&&!existingExclude.endsWith('\n')?'\n':'')+rule+'\n';
  const lines=[begin,'[mcp_servers.hivemind]','command = '+JSON.stringify(nodePath),'args = ['+JSON.stringify(entry)+']','cwd = '+JSON.stringify(root),'default_tools_approval_mode = "writes"','','[mcp_servers.hivemind.env]','HIVEMIND_API_URL = '+JSON.stringify(url.origin)];
  if(tokenFile)lines.push('HIVEMIND_OPERATOR_TOKEN_FILE = '+JSON.stringify(tokenFile));lines.push(end,'');
  const nextConfig=managed(readOptional(configPath),lines.join('\n'));
  // Preflight both targets before creating either generated file.
  mkdirSync(join(root,'.codex'),{recursive:true,mode:0o700});mkdirSync(join(common,'info'),{recursive:true});
  atomicWrite(excludePath,nextExclude);
  try {git(root,['check-ignore','--quiet','--','.codex/config.toml']);}catch{fail('Project ignore rules do not exclude machine-specific Codex configuration.');}
  const changed=atomicWrite(configPath,nextConfig);return {configPath,changed};
}

function cli():void {
  const options:HivemindMcpConfigOptions={projectRoot:process.cwd()};
  const flags:Record<string,keyof HivemindMcpConfigOptions>={'--project-root':'projectRoot','--node-path':'nodePath','--api-url':'apiUrl','--operator-token-file':'operatorTokenFile'};
  for(let i=2;i<process.argv.length;i++) {const flag=process.argv[i]!,key=flags[flag],value=process.argv[++i];if(!key||!value||value.startsWith('--'))fail('Invalid HIVEMIND installer arguments.');options[key]=value;}
  configureHivemindMcp(options);process.stdout.write('HIVEMIND MCP configured for this project. Start a new Codex session if needed.\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {cli();}catch {process.stderr.write('HIVEMIND MCP configuration failed. Existing unmanaged settings were not replaced.\n');process.exitCode=1;}
}
