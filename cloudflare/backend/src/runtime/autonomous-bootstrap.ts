import {pathToFileURL} from 'node:url';
import {createServer,type Server} from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import type {NativeClaudeRequest,NativeClaudeResponse} from '../../../../packages/contracts/src/autonomous-native.ts';
import {executeAutonomousClaude} from './autonomous-claude.ts';
export interface AutonomousBootstrapOptions {token:string;execute?:(request:NativeClaudeRequest,signal:AbortSignal,runtimeId:string)=>Promise<NativeClaudeResponse>}
/** Caller listens on loopback (recommended: server.listen(0,'127.0.0.1')). No import-time listener. */
export function createAutonomousBootstrap(options:AutonomousBootstrapOptions):Server{
 if(typeof options.token!=='string'||options.token.length<16||options.token.length>4096||/[\r\n\0]/.test(options.token))throw Error('Private transport token required');
 const runtimeId=randomUUID();let active=false;
 const server=createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
  const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+options.token);
  if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){send(401,{error:'Unauthorized'});return;}
  if(req.method!=='POST'||req.url!=='/iteration'){send(404,{error:'Not found'});return;}
  if(active){send(409,{error:'Iteration active'});return;}active=true;
  const controller=new AbortController();req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableFinished)controller.abort();});
  const timeout=setTimeout(()=>controller.abort(),3600000);timeout.unref();
  try{
   if(Number(req.headers['content-length'])>16*1024*1024){send(413,{error:'Body limit'});return;}
   const chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>16*1024*1024){send(413,{error:'Body limit'});return;}chunks.push(b);}
   let input:NativeClaudeRequest;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{send(400,{error:'Invalid request'});return;}
   const result=await(options.execute??((r,s,id)=>executeAutonomousClaude(r,{signal:s,runtimeId:id})))(input,controller.signal,runtimeId);controller.signal.throwIfAborted();send(200,result);
  }catch{send(400,{error:'Iteration refused or failed'});}finally{clearTimeout(timeout);active=false;}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;
 // Bind loopback when callers omit host; explicit host is a trusted deployment decision.
 const listen=server.listen.bind(server);server.listen=((...args:unknown[])=>{if(args[0]&&typeof args[0]==='object'&&!('path' in args[0])&&!('host' in args[0]))args[0]={...args[0],host:'127.0.0.1'};if(typeof args[0]==='number'&&(args.length===1||typeof args[1]==='function'))args.splice(1,0,'127.0.0.1');return (listen as (...v:unknown[])=>Server)(...args);}) as Server['listen'];
 return server;
}

// Explicit container command override; importing this module never opens a listener.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  const token=process.env.HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN,rawPort=process.env.HIVEMIND_AUTONOMOUS_RUNTIME_PORT??'3100',host=process.env.HIVEMIND_AUTONOMOUS_RUNTIME_HOST??'127.0.0.1';
  if(!token||!/^\d{1,5}$/.test(rawPort)||Number(rawPort)<1||Number(rawPort)>65535||!host||/[\s\0]/.test(host))throw Error('Invalid startup configuration');
  const server=createAutonomousBootstrap({token});server.once('error',()=>{process.stderr.write('Autonomous runtime could not start\n');process.exitCode=1;});server.listen(Number(rawPort),host);
 }catch{process.stderr.write('Autonomous runtime could not start\n');process.exitCode=1;}
}
