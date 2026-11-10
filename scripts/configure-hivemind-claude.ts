import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HivemindClaudeConfigOptions { projectRoot:string; nodePath?:string; apiUrl?:string; operatorTokenFile?:string }
export interface HivemindClaudeConfigResult { configPath:string; changed:boolean }
const markerName='.claude/hivemind-mcp.local.json';
const transactionName='.claude/hivemind-mcp.transaction.local';
function fail(message:string):never {throw new Error(message);}
function stat(path:string):Stats|undefined {
  try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
function safe(path:string,kind:'directory'|'file'|'either',required=false):void {
  const value=stat(path);if(!value){if(required)fail('Required HIVEMIND configuration path is missing.');return;}
  if(value.isSymbolicLink()||(kind==='directory'&&!value.isDirectory())||(kind==='file'&&!value.isFile())||(kind==='either'&&!value.isFile()&&!value.isDirectory()))fail('Unsafe HIVEMIND configuration path.');
}
function children(root:string,parts:string[],file=true,required=false):void {
  let path=root;for(const [index,part] of parts.entries()){path=join(path,part);safe(path,file&&index===parts.length-1?'file':'directory',required);}
}
function git(root:string,args:string[]):string {
  const nullDevice=process.platform==='win32'?'NUL':'/dev/null';
  const env:NodeJS.ProcessEnv={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_SYSTEM:nullDevice};
  for(const key of ['PATH','LANG','LC_ALL','LC_CTYPE','SystemRoot','WINDIR','TMPDIR','TMP','TEMP'])if(process.env[key]!==undefined)env[key]=process.env[key];
  return execFileSync('git',['--no-optional-locks','-c','core.hooksPath='+nullDevice,'-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env,timeout:5000}).trim();
}
function untracked(root:string,path:string):void {
  try{git(root,['ls-files','--error-unmatch','--',path]);}catch(error){if((error as {status?:number}).status===1)return;throw error;}
  fail('Tracked project configuration cannot be modified.');
}
interface JsonNode {start:number;end:number;properties?:Map<string,JsonNode>}
// Keep source spans so unknown values, including arbitrary-precision numbers, are never reserialized.
function inspectJson(source:string):JsonNode {
  try{JSON.parse(source);}catch{fail('Invalid project JSON configuration.');}
  let position=0;
  function whitespace():void{while(/\s/.test(source[position]??'')&&position<source.length)position++;}
  function string():string {const start=position++;while(position<source.length){if(source[position]==='\\'){position+=2;continue;}if(source[position++]==='"')break;}return JSON.parse(source.slice(start,position)) as string;}
  function value():JsonNode {
    whitespace();const start=position;
    if(source[position]==='{'){
      position++;whitespace();const properties=new Map<string,JsonNode>();
      while(source[position]!=='}'){
        const key=string();if(properties.has(key))fail('Duplicate project JSON keys are not supported.');whitespace();position++;const node=value();properties.set(key,node);whitespace();if(source[position]!==',')break;position++;whitespace();
      }
      position++;return {start,end:position,properties};
    }
    if(source[position]==='['){position++;whitespace();while(source[position]!==']'){value();whitespace();if(source[position]!==',')break;position++;}position++;}
    else if(source[position]==='"')string();else while(position<source.length&&!/[\s,\]}]/.test(source[position]!))position++;
    return {start,end:position};
  }
  const result=value();if(!result.properties)fail('Project JSON configuration must be an object.');return result;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
const fingerprint=(value:unknown):string=>createHash('sha256').update(canonical(value)).digest('hex');
interface Snapshot {path:string;text:string|undefined;identity:string|undefined;mode:number|undefined}
function snapshot(path:string):Snapshot {
  safe(path,'file');const current=stat(path);
  return {path,text:current?readFileSync(path,'utf8'):undefined,identity:current?[current.dev,current.ino,current.size,current.mtimeMs,current.ctimeMs,current.mode].join(':'):undefined,mode:current?current.mode&0o777:undefined};
}
function unchanged(before:Snapshot):void {
  const current=snapshot(before.path);if(current.identity!==before.identity||current.text!==before.text)fail('Concurrent HIVEMIND configuration change detected.');
}
function atomic(before:Snapshot,text:string,mode=0o600):Snapshot {
  unchanged(before);const temporary=join(dirname(before.path),'.hivemind-mcp-'+randomUUID()+'.tmp');let fd:number|undefined;
  try{fd=openSync(temporary,'wx',mode);writeFileSync(fd,text,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;unchanged(before);renameSync(temporary,before.path);return snapshot(before.path);}
  finally{if(fd!==undefined)closeSync(fd);rmSync(temporary,{force:true});}
}
function appendProperty(source:string,parent:JsonNode,key:string,value:string):string {
  const offset=parent.end-1;return source.slice(0,offset)+(parent.properties!.size?',':'')+'\n  '+JSON.stringify(key)+': '+value+'\n'+source.slice(offset);
}

export function configureHivemindClaude(options:HivemindClaudeConfigOptions):HivemindClaudeConfigResult {
  safe(resolve(options.projectRoot),'directory',true);const root=realpathSync(options.projectRoot);
  safe(join(root,'.git'),'either',true);if(realpathSync(git(root,['rev-parse','--show-toplevel']))!==root)fail('Run the installer at a Git project root.');
  const nodePath=options.nodePath??process.execPath;if(!isAbsolute(nodePath))fail('An absolute Node executable is required.');safe(nodePath,'file',true);
  const entryParts=['dist','apps','mcp-server','src','main.js'];children(root,entryParts,true,true);
  const rawUrl=options.apiUrl??'http://127.0.0.1:4310';let url:URL;
  try{url=new URL(rawUrl);}catch{fail('Invalid HIVEMIND API URL.');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(/\s/.test(rawUrl)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!loopback)||(!loopback&&!options.operatorTokenFile))fail('Invalid HIVEMIND API URL.');
  const tokenFile=options.operatorTokenFile?resolve(root,options.operatorTokenFile):undefined;if(tokenFile)safe(tokenFile,'file');
  const entry={command:nodePath,args:[join(root,...entryParts)],env:{HIVEMIND_API_URL:url.origin,...(tokenFile?{HIVEMIND_OPERATOR_TOKEN_FILE:tokenFile}:{})}};
  const configPath=join(root,'.mcp.json'),markerPath=join(root,markerName),transactionPath=join(root,transactionName);
  children(root,['.mcp.json']);children(root,markerName.split('/'));children(root,transactionName.split('/'),false);
  if(stat(transactionPath))fail('An interrupted HIVEMIND configuration transaction requires recovery.');
  for(const path of ['.mcp.json',markerName,transactionName])untracked(root,path);
  const common=resolve(root,git(root,['rev-parse','--path-format=absolute','--git-common-dir']));safe(common,'directory',true);children(common,['info','exclude']);
  const excludePath=join(common,'info','exclude');
  const beforeConfig=snapshot(configPath),beforeMarker=snapshot(markerPath),beforeExclude=snapshot(excludePath);
  const source=beforeConfig.text??'{}\n',document=inspectJson(source),servers=document.properties!.get('mcpServers');
  if(servers&&!servers.properties)fail('Project mcpServers configuration must be an object.');
  const existing=servers?.properties?.get('hivemind');
  if(beforeMarker.text!==undefined){
    inspectJson(beforeMarker.text);const marker=JSON.parse(beforeMarker.text) as {version?:unknown;entryHash?:unknown};
    if(marker.version!==1||typeof marker.entryHash!=='string'||!existing||fingerprint(JSON.parse(source.slice(existing.start,existing.end)))!==marker.entryHash)fail('Managed HIVEMIND MCP settings were changed outside the installer.');
  }else if(existing)fail('An unmanaged HIVEMIND MCP server already exists.');
  let nextConfig:string;
  if(existing)nextConfig=source.slice(0,existing.start)+JSON.stringify(entry,null,2)+source.slice(existing.end);
  else if(servers)nextConfig=appendProperty(source,servers,'hivemind',JSON.stringify(entry,null,2));
  else nextConfig=appendProperty(source,document,'mcpServers',JSON.stringify({hivemind:entry},null,2));
  // Preserve an existing equivalent managed entry byte-for-byte on idempotent runs.
  if(existing&&fingerprint(JSON.parse(source.slice(existing.start,existing.end)))===fingerprint(entry))nextConfig=source;
  const nextMarker=JSON.stringify({version:1,entryHash:fingerprint(entry)},null,2)+'\n';
  const rules=['/.mcp.json','/'+markerName,'/'+transactionName+'/'];let nextExclude=beforeExclude.text??'';
  for(const rule of rules)if(!nextExclude.split(/\r?\n/).includes(rule))nextExclude+=(nextExclude&&!nextExclude.endsWith('\n')?'\n':'')+rule+'\n';
  mkdirSync(join(root,'.claude'),{recursive:true,mode:0o700});mkdirSync(join(common,'info'),{recursive:true,mode:0o700});
  const directories=[root,join(root,'.claude'),common,join(common,'info')].map(path=>{safe(path,'directory',true);const value=lstatSync(path);return {path,dev:value.dev,ino:value.ino};});
  function parents():void{for(const saved of directories){safe(saved.path,'directory',true);const value=lstatSync(saved.path);if(value.dev!==saved.dev||value.ino!==saved.ino)fail('Concurrent HIVEMIND configuration path change detected.');}}
  const lock=join(common,'info','.hivemind-claude.lock');safe(lock,'file');let lockFd:number|undefined;
  const written:{before:Snapshot;after:Snapshot}[]=[];let transactionCreated=false;
  function write(before:Snapshot,text:string):Snapshot {
    parents();if(before.text===text&&before.mode===0o600)return before;
    const after=atomic(before,text);written.push({before,after});return after;
  }
  try {
    lockFd=openSync(lock,'wx',0o600);parents();
    for(const before of [beforeConfig,beforeMarker,beforeExclude])unchanged(before);
    children(root,transactionName.split('/'),false);if(stat(transactionPath))fail('An interrupted HIVEMIND configuration transaction requires recovery.');
    mkdirSync(transactionPath,{mode:0o700});transactionCreated=true;
    const plans=[{before:beforeExclude,next:nextExclude},{before:beforeConfig,next:nextConfig},{before:beforeMarker,next:nextMarker}];
    // Private backups make a process interruption recoverable without exposing unrelated settings in diagnostics.
    const manifest=plans.map(({before,next},index)=>{
      if(before.text!==undefined)writeFileSync(join(transactionPath,index+'.before'),before.text,{mode:0o600,flag:'wx'});
      writeFileSync(join(transactionPath,index+'.after'),next,{mode:0o600,flag:'wx'});
      return {path:before.path,existed:before.text!==undefined,mode:before.mode,beforeHash:before.text===undefined?null:createHash('sha256').update(before.text).digest('hex'),afterHash:createHash('sha256').update(next).digest('hex')};
    });
    writeFileSync(join(transactionPath,'manifest.json'),JSON.stringify({version:1,files:manifest},null,2)+'\n',{mode:0o600,flag:'wx'});
    const afterExclude=write(beforeExclude,nextExclude);
    for(const path of ['.mcp.json',markerName,transactionName+'/manifest.json']){
      try{git(root,['check-ignore','--quiet','--',path]);}catch{fail('Project ignore rules do not exclude machine-specific Claude configuration.');}
    }
    for(const path of ['.mcp.json',markerName])untracked(root,path);
    unchanged(afterExclude);
    const afterConfig=write(beforeConfig,nextConfig),afterMarker=write(beforeMarker,nextMarker);parents();
    for(const after of [afterExclude,afterConfig,afterMarker])unchanged(after);
    rmSync(transactionPath,{recursive:true});transactionCreated=false;
    return {configPath,changed:beforeConfig.text!==nextConfig||beforeConfig.mode!==0o600};
  }catch(error){
    let restored=true;
    for(const {before,after} of written.reverse()){
      try{parents();unchanged(after);if(before.text===undefined)rmSync(before.path);else atomic(after,before.text,before.mode);}catch{restored=false;}
    }
    if(transactionCreated&&restored){parents();rmSync(transactionPath,{recursive:true});transactionCreated=false;}
    if(!restored)fail('HIVEMIND configuration was interrupted; private transaction backups require recovery.');
    throw error;
  }finally{if(lockFd!==undefined){closeSync(lockFd);parents();rmSync(lock);}}
}
function cli():void {
  const options:HivemindClaudeConfigOptions={projectRoot:process.cwd()};
  const flags:Record<string,keyof HivemindClaudeConfigOptions>={'--project-root':'projectRoot','--node-path':'nodePath','--api-url':'apiUrl','--operator-token-file':'operatorTokenFile'};
  for(let i=2;i<process.argv.length;i++){const flag=process.argv[i]!,key=flags[flag],value=process.argv[++i];if(!key||!value||value.startsWith('--'))fail('Invalid HIVEMIND installer arguments.');options[key]=value;}
  configureHivemindClaude(options);process.stdout.write('HIVEMIND MCP configured for this project. Restart Claude Code if needed.\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{cli();}catch{process.stderr.write('HIVEMIND MCP configuration failed. Review local configuration conflicts or interrupted transaction backups.\n');process.exitCode=1;}}
