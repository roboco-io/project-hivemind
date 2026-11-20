import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Transform} from 'node:stream';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ListToolsRequestSchema,RequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {CallToolResult,JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {AutonomousLease} from '../../../../packages/contracts/src/autonomous.ts';
import type {ExternalActionRequest} from '../../../../packages/contracts/src/autonomous-external.ts';
import {createLargePost,uploadWorkspaceFiles} from './autonomous-large-upload.ts';

export const ACTION_MCP_SERVER_NAME='hivemind';
export const ACTION_MCP_TOOL_NAME='action';
export const ACTION_MODEL_TOOL_NAME='mcp__hivemind__action';
export const ACTION_MAX_BYTES=65536;
export const ACTION_ARTIFACT_MAX_BYTES=1572864;
export const ACTION_TRANSPORT_MAX_BYTES=2*1024*1024;
export const ACTION_ERROR='External action unavailable or rejected.';
function fail():never {throw Error(ACTION_ERROR);}
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
const taskId=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const token=z.string().min(1).max(4096).regex(/^[^\s\p{Cc}]+$/u);
const identity={profileId:id,requestId:id};
const artifactSchema=z.strictObject({files:z.array(z.strictObject({path:z.string().min(1).max(1024),contentBase64:z.string().max(349528)})).min(1).max(32)});
const digestSchema=z.string().regex(/^[a-f0-9]{64}$/);
const commitMessage=z.string().min(1).max(200).regex(/^[^\p{Cc}]+$/u);
// Same suffix rule as the server: no "..", "//", "/./", leading or trailing separators. The server validates again.
const keySuffix=z.string().regex(/^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.\/)(?!.*\/\.?$)[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$/);
/** Workspace files for a large Hugging Face commit. Paths are relative; the uploader checks them against /workspace. */
const largeArtifactSchema=z.strictObject({paths:z.array(z.string().min(1).max(1024)).min(1).max(32)});
const actionSchema=z.discriminatedUnion('operation',[
  z.strictObject({...identity,operation:z.literal('aws.spot.start'),parameters:z.strictObject({lifetimeMs:integer.min(1)})}),
  z.strictObject({...identity,operation:z.literal('aws.spot.inspect'),parameters:z.strictObject({startActionId:id})}),
  z.strictObject({...identity,operation:z.literal('hf.model.commit'),artifact:artifactSchema.optional(),parameters:z.strictObject({artifactDigest:z.string().regex(/^[a-f0-9]{64}$/),message:z.string().min(1).max(200).regex(/^[^\p{Cc}]+$/u)})}),
  z.strictObject({...identity,operation:z.literal('hf.model.lfs_commit'),largeArtifact:largeArtifactSchema.optional(),parameters:z.strictObject({message:commitMessage,manifestDigest:digestSchema.optional()})}),
  z.strictObject({...identity,operation:z.literal('aws.s3.put'),artifact:artifactSchema.optional(),parameters:z.strictObject({keySuffix,artifactDigest:digestSchema})}),
  z.strictObject({...identity,operation:z.literal('aws.s3.inspect'),parameters:z.strictObject({putActionId:id})}),
  z.strictObject({...identity,operation:z.literal('github.branch.push'),artifact:artifactSchema.optional(),parameters:z.strictObject({artifactDigest:z.string().regex(/^[a-f0-9]{64}$/),expectedHead:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)})}),
]);
export type ActionModelRequest = ExternalActionRequest extends infer R ? R extends ExternalActionRequest ? Omit<R,'taskId'|'revision'> : never : never;
export interface ActionPrivateInput {
  version:1;runtimeId:string;
  /** Immutable nativeStart approval deadline, supplied only by trusted bootstrap.
   * Parent heartbeat may renew the central lease without rewriting its identity. */
  executionDeadline?:number;
  request:{taskId:string;executionLease:AutonomousLease;maxRunMs:number;externalProfiles?:string[]};
  control:{origin:string;workerToken:string};
}
const privateSchema=z.strictObject({
  version:z.literal(1),runtimeId:z.string().uuid(),executionDeadline:integer.optional(),
  request:z.strictObject({taskId,executionLease:z.strictObject({taskId,runId:taskId,workerId:taskId,token,expiresAt:integer}),maxRunMs:integer.min(1).max(120000),externalProfiles:z.array(id).max(32).optional()}),
  control:z.strictObject({origin:z.string().min(1).max(4096),workerToken:token}),
});
/** Trusted runtime options only. Timeout defaults to 55s (below SDK's 60s),
 * may be raised to 120s, and is always clipped to the approved absolute deadline. */
/** workspaceRoot is a trusted runtime option (default /workspace), never model input. */
export interface ActionToolOptions {fetchImpl?:typeof fetch;now?:()=>number;timeoutMs?:number;signal?:AbortSignal;workspaceRoot?:string}
export type ActionTool=(input:unknown,signal?:AbortSignal)=>Promise<CallToolResult>;
function errorResult():CallToolResult {return {isError:true,content:[{type:'text',text:ACTION_ERROR}]};}
/** Reject accessors/cycles before serialization; never call untrusted toJSON. */
function boundedPlainJson(value:unknown,limit=ACTION_MAX_BYTES):string {
  let nodes=0,bytes=0;const seen=new Set<object>();
  const count=(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>limit)fail();return text;};
  const walk=(v:unknown,depth:number):string=>{
    if(++nodes>4096||depth>16)fail();
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return count(JSON.stringify(v));
    if(typeof v==='string'){if(v.length>limit||Buffer.byteLength(v)>limit)fail();return count(JSON.stringify(v));}
    if(!v||typeof v!=='object'||seen.has(v)||Object.getOwnPropertySymbols(v).length)fail();
    const array=Array.isArray(v);if(!array&&Object.getPrototypeOf(v)!==Object.prototype)fail();
    if(array&&v.length>4096)fail();
    const descriptors=Object.getOwnPropertyDescriptors(v),keys=Object.keys(descriptors).filter(k=>!(array&&k==='length'));
    if(array&&(keys.length!==v.length||keys.some((k,i)=>k!==String(i))))fail();
    seen.add(v);const entries=keys.map(k=>{const d=descriptors[k]!;if(!('value'in d)||!d.enumerable||k==='toJSON'||k==='__proto__')fail();return (array?'':count(JSON.stringify(k)+':'))+walk(d.value,depth+1);});seen.delete(v);
    return count(array?'[':'{')+entries.join(count(','))+count(array?']':'}');
  };
  const serialized=walk(value,0);if(Buffer.byteLength(serialized)>limit)fail();return serialized;
}
function parsePrivate(value:unknown):ActionPrivateInput {
  try {
    const p=privateSchema.parse(JSON.parse(boundedPlainJson(value)));
    if(p.request.executionLease.taskId!==p.request.taskId||p.control.workerToken===p.request.executionLease.token)fail();
    if(new Set(p.request.externalProfiles??[]).size!==(p.request.externalProfiles??[]).length)fail();
    const origin=new URL(p.control.origin);
    if(p.control.origin!==p.control.origin.trim()||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!['https:','http:'].includes(origin.protocol)||origin.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||![origin.origin,origin.origin+'/'].includes(p.control.origin))fail();
    p.control.origin=origin.origin;return p;
  }catch {return fail();}
}

/** Independent private reader, deliberately not importing autonomous-from-file. */
export async function readActionPrivateInput(path:string):Promise<ActionPrivateInput> {
  let directory:FileHandle|undefined,file:FileHandle|undefined;
  try {
    if(!isAbsolute(path)||path.includes('\0'))fail();
    const parent=dirname(path);directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const parentInfo=await directory.stat({bigint:true}),uid=process.getuid?.();
    if(uid===undefined||!parentInfo.isDirectory()||parentInfo.uid!==BigInt(uid)||(parentInfo.mode&0o022n))fail();
    const checkParent=async()=>{const current=await lstat(parent,{bigint:true});if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==parentInfo.dev||current.ino!==parentInfo.ino||current.uid!==parentInfo.uid||(current.mode&0o022n))fail();};
    await checkParent();const root=process.platform==='linux'?`/proc/self/fd/${directory.fd}`:await realpath(parent),anchored=join(root,basename(path));
    file=await open(anchored,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await file.stat({bigint:true});
    if(!before.isFile()||before.uid!==BigInt(uid)||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size<1n||before.size>BigInt(ACTION_MAX_BYTES))fail();
    const bytes=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<bytes.length){const result=await file.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)fail();offset+=result.bytesRead;}
    if((await file.read(Buffer.alloc(1),0,1,offset)).bytesRead)fail();
    const after=await file.stat({bigint:true}),named=await lstat(anchored,{bigint:true});
    if((['dev','ino','size','mode','uid','nlink','mtimeNs','ctimeNs'] as const).some(k=>before[k]!==after[k])||!named.isFile()||named.dev!==after.dev||named.ino!==after.ino)fail();
    await checkParent();return parsePrivate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }catch {return fail();}
  finally {await file?.close();await directory?.close();}
}

async function abortable<T>(operation:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error(ACTION_ERROR));signal.addEventListener('abort',abort,{once:true});});
  try {return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),cancelled]);}
  finally {signal.removeEventListener('abort',abort);}
}
async function responseJson(response:Response,signal:AbortSignal):Promise<unknown> {
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>ACTION_MAX_BYTES)){void response.body?.cancel().catch(()=>{});fail();}
  if(!response.body)fail();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,done=false;
  try {
    for(;;){const part=await abortable(()=>reader.read(),signal);if(part.done){done=true;break;}bytes+=part.value.byteLength;if(bytes>ACTION_MAX_BYTES)fail();chunks.push(part.value);}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }finally {if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
const providerResultSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('github_commit'),oid:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}),
  z.strictObject({kind:z.literal('hf_commit'),oid:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}),
  z.strictObject({kind:z.literal('aws_instance'),id:z.string().regex(/^i-[a-f0-9]{8,32}$/)}),
]);
const publicActionSchema=z.object({
  requestId:id,phase:z.enum(['intent','reserved','broker','settled','cleaned']),actionId:id.optional(),
  status:z.enum(['intent','dispatching','ambiguous','succeeded','failed','cancelled']).optional(),
  operation:z.enum(['aws.spot.start','aws.spot.inspect','hf.model.commit','hf.model.lfs_commit','aws.s3.put','aws.s3.inspect','github.branch.push']).optional(),
  effect:z.enum(['none','retained','resource','unknown']).optional(),cleanupStatus:z.enum(['none','pending','deleting','cleaned']).optional(),
  upperBoundMicros:integer.optional(),reservedMicros:integer.optional(),verifiedCostMicros:integer.nullable().optional(),billingFinal:z.boolean().optional(),
  providerResult:providerResultSchema.optional(),
});
function project(value:unknown,secrets:string[],request:ActionModelRequest):Record<string,unknown> {
  const p=publicActionSchema.parse(value);
  if(p.requestId!==request.requestId||p.operation!==undefined&&p.operation!==request.operation)fail();
  if(p.providerResult!==undefined){
    if(p.operation!==request.operation||p.status!=='succeeded'||!p.actionId||!['broker','settled','cleaned'].includes(p.phase))fail();
    const result=p.providerResult;
    // S3 results never carry a provider result: the bucket and key are server-owned and not shown to the model.
    const matches=request.operation==='github.branch.push'?result.kind==='github_commit'&&p.effect==='retained':
      request.operation==='hf.model.commit'||request.operation==='hf.model.lfs_commit'?result.kind==='hf_commit'&&p.effect==='retained':
      request.operation==='aws.s3.put'||request.operation==='aws.s3.inspect'?false:
      result.kind==='aws_instance'&&p.effect===(request.operation==='aws.spot.start'?'resource':'none');
    if(!matches)fail();
  }
  if(p.billingFinal===true&&p.verifiedCostMicros==null)fail();
  if(p.upperBoundMicros!==undefined&&p.reservedMicros!==undefined){
    if(p.reservedMicros>p.upperBoundMicros)fail();
    if(p.verifiedCostMicros!=null){const exposure=p.verifiedCostMicros+p.reservedMicros;if(!Number.isSafeInteger(exposure)||exposure>p.upperBoundMicros&&!(p.verifiedCostMicros>p.upperBoundMicros&&p.reservedMicros===0))fail();}
  }
  if(['settled','cleaned'].includes(p.phase)&&(p.billingFinal===false||p.reservedMicros!==undefined&&p.reservedMicros!==0))fail();
  // Exact producer allowlist: no raw broker id/evidence/ownership/auth/parameters.
  // Optional unmeasured fields remain absent; verified null remains unknown.
  const serialized=JSON.stringify(p);if(secrets.some(secret=>serialized.includes(secret)))fail();return p;
}

/** Pure factory: no file reads, process launch, environment access or I/O until call. */
export function createActionTool(privateInput:ActionPrivateInput,options:ActionToolOptions={}):ActionTool {
  const p=parsePrivate(privateInput),now=options.now??Date.now,start=now(),timeout=options.timeoutMs??55000;
  const maximum=start+p.request.maxRunMs;
  const deadline=p.executionDeadline??Math.min(p.request.executionLease.expiresAt,maximum);
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(maximum)||!Number.isSafeInteger(timeout)||timeout<1||timeout>120000||deadline<=start||deadline>maximum)fail();
  // Do not renew or trust caller lease expiry. Central nativeStart must authorize
  // the actual current lease and cancellation state on EVERY external action.
  const fetcher=options.fetchImpl??fetch;
  const endpoint=`${p.control.origin}/v1/autonomous-tasks/${encodeURIComponent(p.request.taskId)}/external-action`;
  const secrets=[p.control.workerToken,p.request.executionLease.token,p.runtimeId];
  return async(value,callerSignal)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const raw=boundedPlainJson(value,ACTION_ARTIFACT_MAX_BYTES);
      if(secrets.some(secret=>raw.includes(secret)))fail();
      const parsed=actionSchema.parse(JSON.parse(raw));
      const {artifact,largeArtifact,...input}={artifact:undefined,largeArtifact:undefined,...parsed} as typeof parsed&{artifact?:z.infer<typeof artifactSchema>;largeArtifact?:z.infer<typeof largeArtifactSchema>};
      if(!artifact&&Buffer.byteLength(raw)>ACTION_MAX_BYTES)fail();
      if(artifact){
        let total=0;const paths=new Set<string>();
        for(const file of artifact.files){
          if(paths.has(file.path))fail();paths.add(file.path);
          const encoded=file.contentBase64;
          if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))fail();
          const decoded=Buffer.from(encoded,'base64');total+=decoded.length;
          if(decoded.length>262144||total>1048576||decoded.toString('base64')!==encoded||secrets.some(secret=>decoded.includes(Buffer.from(secret))))fail();
        }
      }
      if(!p.request.externalProfiles?.includes(input.profileId))fail();
      // A large commit names its files or an already uploaded manifest digest, never both and never neither.
      const hasDigest=input.operation==='hf.model.lfs_commit'&&input.parameters.manifestDigest!==undefined;
      if(input.operation==='hf.model.lfs_commit'?!!largeArtifact===hasDigest:!!largeArtifact)fail();
      const current=now(),remaining=Math.min(timeout,deadline-current);if(!Number.isSafeInteger(current)||current<start||remaining<=0)fail();
      const controller=new AbortController();timer=setTimeout(()=>controller.abort(),remaining);
      const signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[]),...(callerSignal?[callerSignal]:[])]);
      const post=async(target:string,body:string)=>{
        signal.throwIfAborted();const at=now();if(!Number.isSafeInteger(at)||at<current||at>=deadline)fail();
        const response=await abortable(()=>fetcher(target,{method:'POST',headers:{authorization:'Bearer '+p.control.workerToken,'content-type':'application/json',accept:'application/json'},body,redirect:'error',signal}),signal);
        if(!response.ok||response.redirected||response.url&&response.url!==target||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>{});fail();}
        return responseJson(response,signal);
      };
      if(artifact){
        const uploaded=z.strictObject({artifactDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(await post(endpoint.replace(/external-action$/,'external-artifact'),boundedPlainJson({lease:p.request.executionLease,runtimeId:p.runtimeId,profileId:input.profileId,artifact},ACTION_ARTIFACT_MAX_BYTES+16384)));
        if(!('artifactDigest'in input.parameters)||uploaded.artifactDigest!==input.parameters.artifactDigest)fail();
      }
      let request:typeof input=input;
      if(largeArtifact&&input.operation==='hf.model.lfs_commit'){
        // Authority comes from the private input: approved lease, runtime and the profile already checked above.
        const large=createLargePost({origin:p.control.origin,workerToken:p.control.workerToken,taskId:p.request.taskId,lease:p.request.executionLease,runtimeId:p.runtimeId,profileId:input.profileId,fetchImpl:fetcher,now,deadline});
        const uploaded=await uploadWorkspaceFiles({root:options.workspaceRoot??'/workspace',paths:largeArtifact.paths,post:large,signal});
        request={...input,parameters:{message:input.parameters.message,manifestDigest:uploaded.manifestDigest}};
      }
      const body=boundedPlainJson({lease:p.request.executionLease,runtimeId:p.runtimeId,request});
      const data=project(await post(endpoint,body),secrets,request as ActionModelRequest);signal.throwIfAborted();
      const completedAt=now();if(!Number.isSafeInteger(completedAt)||completedAt<current||completedAt>=deadline)fail();
      return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
    }catch {return errorResult();}finally {if(timer)clearTimeout(timer);}
  };
}

/** SDK errors may include rejected input/property names. Sanitize every error. */
class PrivateActionServer extends Server {
  private readonly privateValues:string[];
  constructor(privateValues:string[]){super({name:ACTION_MCP_SERVER_NAME,version:'0.1.0'},{capabilities:{tools:{}}});this.privateValues=privateValues;}
  override async connect(transport:Transport):Promise<void> {
    const wrapped:Transport={start:()=>transport.start(),close:()=>transport.close(),send:(message,options)=>{
      let outgoing:JSONRPCMessage=message;
      if('error'in message)outgoing={jsonrpc:'2.0',id:message.id,error:{code:message.error.code,message:ACTION_ERROR}};
      else if('result'in message&&message.result.isError===true)outgoing={...message,result:errorResult()};
      if(this.privateValues.some(secret=>JSON.stringify(outgoing).includes(secret)))return transport.close();
      return transport.send(outgoing,options);
    },get sessionId(){return transport.sessionId;},setProtocolVersion:v=>transport.setProtocolVersion?.(v)};
    transport.onmessage=(message,extra)=>wrapped.onmessage?.(message,extra);transport.onerror=()=>wrapped.onerror?.(Error(ACTION_ERROR));transport.onclose=()=>wrapped.onclose?.();
    await super.connect(wrapped);
  }
}
export function createActionMcpServer(privateInput:ActionPrivateInput,options:ActionToolOptions={}):Server {
  const p=parsePrivate(privateInput),tool=createActionTool(p,options),server=new PrivateActionServer([p.control.workerToken,p.request.executionLease.token,p.runtimeId]);
  const branches=(z.toJSONSchema(actionSchema) as {oneOf?:unknown[]}).oneOf;
  const inputSchema={type:'object' as const,additionalProperties:false,required:['profileId','requestId','operation','parameters'],properties:{profileId:{type:'string'},requestId:{type:'string'},operation:{enum:['aws.spot.start','aws.spot.inspect','hf.model.commit','hf.model.lfs_commit','aws.s3.put','aws.s3.inspect','github.branch.push']},parameters:{type:'object'},artifact:z.toJSONSchema(artifactSchema),largeArtifact:z.toJSONSchema(largeArtifactSchema)},oneOf:branches};
  server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:ACTION_MCP_TOOL_NAME,description:'Submit one action within the approved external profile. Reuse requestId to query an uncertain action; never blindly retry with a new ID.',inputSchema,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}}]}));
  // Preserve params for our strict validation; the SDK still validates MCP envelopes.
  server.setRequestHandler(RequestSchema.extend({method:z.literal('tools/call')}),async(request,extra)=>{
    try {
      const params=z.strictObject({name:z.literal(ACTION_MCP_TOOL_NAME),arguments:z.unknown(),_meta:z.record(z.string(),z.unknown()).optional()}).parse(request.params);
      return await tool(params.arguments,extra.signal);
    }catch {return errorResult();}
  });
  return server;
}
export interface ActionMcpConfigOptions {command:string;args:readonly string[];privateInputPath:string}
/** Trusted bootstrap config only; never invokes command or shell. */
export function createAutonomousActionMcpConfig(options:ActionMcpConfigOptions):{mcpServers:{hivemind:{command:string;args:string[]}}} {
  if(!isAbsolute(options.command)||!isAbsolute(options.privateInputPath)||!Array.isArray(options.args)||options.args.length<1||options.args.length>16||[options.command,options.privateInputPath,...options.args].some(v=>typeof v!=='string'||!v||v.length>4096||/[\p{Cc}]/u.test(v))||options.args.includes('--private-input'))fail();
  return {mcpServers:{hivemind:{command:options.command,args:[...options.args,'--private-input',options.privateInputPath]}}};
}
export async function startActionMcpStdio(options:ActionToolOptions&{privateInputPath:string}):Promise<Server> {
  const privateInput=await readActionPrivateInput(options.privateInputPath),server=createActionMcpServer(privateInput,options);
  const decoder=new TextDecoder('utf-8',{fatal:true}),checked=new Transform({transform(chunk,_encoding,callback){try{decoder.decode(chunk,{stream:true});callback(null,chunk);}catch{callback(Error(ACTION_ERROR));}},flush(callback){try{decoder.decode();callback();}catch{callback(Error(ACTION_ERROR));}}});
  const transport=new StdioServerTransport(checked,process.stdout,{maxBufferSize:ACTION_TRANSPORT_MAX_BYTES});
  const close=()=>{process.stdin.unpipe(checked);process.stdin.pause();checked.destroy();};
  server.onclose=close;server.onerror=()=>{void server.close();};checked.on('error',()=>{void server.close();});checked.on('end',()=>{void server.close();});
  await server.connect(transport);process.stdin.pipe(checked);return server;
}
export async function main(argv:readonly string[]=process.argv.slice(2)):Promise<void> {
  if(argv.length!==2||argv[0]!=='--private-input'||!argv[1])fail();
  await startActionMcpStdio({privateInputPath:argv[1]});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(()=>{process.exitCode=1;});
