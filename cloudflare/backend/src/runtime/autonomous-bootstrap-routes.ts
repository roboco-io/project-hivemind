import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {mkdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {AUTONOMOUS_CLOUD_MAX_BYTES,validateAutonomousCloudInput,validateAutonomousCloudOutput} from '../autonomous-cloud-protocol.ts';
import {NATIVE_FILES,readNativePrivate,writeNativePrivate,nativeResultReady} from './autonomous-from-file.ts';
/** Returns false only for paths outside the exact native endpoint set. */
export async function handleAutonomousBootstrap(req:IncomingMessage,res:ServerResponse,runtimeDir:string):Promise<boolean>{
 const path=new URL(req.url??'/','http://runtime').pathname;
 if(!['/autonomous/prepare','/autonomous/state','/autonomous/result','/autonomous/cancel'].includes(path))return false;
 const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));return true;};
 const expected=process.env.HIVEMIND_NATIVE_GATE_TOKEN,actual=req.headers['x-hivemind-native'];
 if(!expected||typeof actual!=='string'||Buffer.byteLength(expected)!==Buffer.byteLength(actual)||!timingSafeEqual(Buffer.from(expected),Buffer.from(actual)))return send(403,{error:'Forbidden'});
 const file=(name:string)=>join(runtimeDir,name);
 const exists=async(name:string)=>{try{await readNativePrivate(file(name));return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
 try{
  if(req.method==='POST'&&path==='/autonomous/prepare'){
   let bytes=0;const chunks:Buffer[]=[];for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>AUTONOMOUS_CLOUD_MAX_BYTES)return send(413,{error:'Native input too large'});chunks.push(b);}
   let input;try{input=validateAutonomousCloudInput(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{return send(400,{error:'Invalid native input'});}
   await mkdir(runtimeDir,{recursive:true,mode:0o700});const dir=await lstat(runtimeDir);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o022))throw Error();
   try{await writeNativePrivate(file(NATIVE_FILES.input),input);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const equal=isDeepStrictEqual(await readNativePrivate(file(NATIVE_FILES.input)),input);return send(equal?200:409,{prepared:equal});}
   return send(201,{prepared:true});
  }
  if(req.method==='GET'&&path==='/autonomous/state')return send(200,{prepared:await exists(NATIVE_FILES.input),started:await exists(NATIVE_FILES.started),resultReady:await nativeResultReady(runtimeDir),cancelRequested:await exists(NATIVE_FILES.cancel)});
  if(req.method==='GET'&&path==='/autonomous/result'){
   if(!await nativeResultReady(runtimeDir))return send(404,{error:'Native result not ready'});
   try{return send(200,validateAutonomousCloudOutput(await readNativePrivate(file(NATIVE_FILES.result))));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return send(404,{error:'Native result not ready'});throw e;}
  }
  if(req.method==='POST'&&path==='/autonomous/cancel'){
   try{await writeNativePrivate(file(NATIVE_FILES.cancel),true);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await readNativePrivate(file(NATIVE_FILES.cancel));}return send(202,{cancelRequested:true});
  }
  return send(405,{error:'Method not allowed'});
 }catch{return send(500,{error:'Native storage unavailable'});}
}
