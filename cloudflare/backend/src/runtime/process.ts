import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {constants} from 'node:fs';
import {mkdir,open,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import type {ProcessResult} from '../contracts.ts';
export interface RunOptions {cwd:string;env:NodeJS.ProcessEnv;timeoutMs:number;signal?:AbortSignal;maxBytes?:number;input?:string;captureDirectory?:string}
export async function runProcess(argv:string[],options:RunOptions):Promise<ProcessResult> {
 if(!argv.length||argv.some(x=>typeof x!=='string'||!x||x.includes('\0'))||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1)throw new Error('Invalid execution command or deadline');
 const max=options.maxBytes??32768;if(!Number.isSafeInteger(max)||max<1)throw new Error('Invalid output limit');
 if(options.signal?.aborted)return {status:'error',exitCode:null,stdout:'',stderr:'Execution cancelled',durationMs:0,truncated:false};
 const files:FileHandle[]=[];
 try{
  if(options.captureDirectory){
   await mkdir(options.captureDirectory,{recursive:true,mode:0o700});
   for(const name of ['stdout.log','stderr.log'])files.push(await open(join(options.captureDirectory,name),constants.O_EXCL|constants.O_NOFOLLOW|constants.O_CREAT|constants.O_RDWR|constants.O_APPEND,0o600));
  }
  if(options.signal?.aborted)return {status:'error',exitCode:null,stdout:'',stderr:'Execution cancelled',durationMs:0,truncated:false};
 return await new Promise<ProcessResult>(resolve=>{
  let startedAt=Date.now();
  const child=spawn(argv[0]!,argv.slice(1),{cwd:options.cwd,env:options.env,shell:false,detached:process.platform!=='win32',stdio:files.length?['pipe',files[0]!.fd,files[1]!.fd]:['pipe','pipe','pipe']});
  child.once('spawn',()=>{startedAt=Date.now();});
  const out:Buffer[]=[],err:Buffer[]=[];let bytes=0,truncated=false,timedOut=false,spawnError=false,cancelled=false,captureError=false,stopping:Promise<void>|undefined,sizeCheck:Promise<void>|undefined;
  const alive=()=>{if(!child.pid)return false;try{process.kill(process.platform==='win32'?child.pid:-child.pid,0);return true;}catch{return false;}};
  const signal=(value:NodeJS.Signals)=>{if(child.pid)try{process.kill(process.platform==='win32'?child.pid:-child.pid,value);}catch{/* Process already stopped. */}};
  const stop=()=>stopping??=(async()=>{if(!alive())return;signal('SIGTERM');const until=Date.now()+1500;while(alive()&&Date.now()<until)await sleep(20);if(alive()){signal('SIGKILL');await sleep(25);}})();
  const abort=()=>{cancelled=true;void stop();};options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;void stop();},options.timeoutMs);
  const capture=(chunk:Buffer,dest:Buffer[])=>{const part=chunk.subarray(0,Math.max(0,max-bytes));bytes+=part.length;if(part.length)dest.push(part);if(part.length<chunk.length){truncated=true;void stop();}};
  const checkSizes=async()=>{try{const sizes=await Promise.all(files.map(file=>file.stat()));if(sizes.reduce((total,info)=>total+info.size,0)>max){truncated=true;void stop();}}catch{captureError=true;void stop();}};
  const poll=files.length?setInterval(()=>{if(!sizeCheck){const check=checkSizes();sizeCheck=check;void check.finally(()=>{if(sizeCheck===check)sizeCheck=undefined;});}},20):undefined;
  const readBounded=async(file:FileHandle,remaining:number)=>{const chunks:Buffer[]=[];let offset=0;while(offset<remaining){const buffer=Buffer.alloc(Math.min(16384,remaining-offset)),part=await file.read(buffer,0,buffer.length,offset);if(!part.bytesRead)break;chunks.push(buffer.subarray(0,part.bytesRead));offset+=part.bytesRead;}return Buffer.concat(chunks);};
  child.stdout?.on('data',(b:Buffer)=>capture(b,out));child.stderr?.on('data',(b:Buffer)=>capture(b,err));child.on('error',()=>{spawnError=true;});child.stdin!.on('error',()=>undefined);child.stdin!.end(options.input??'');
  child.on('close',(code,term)=>{const finishedAt=Date.now();clearTimeout(timer);if(poll)clearInterval(poll);void (async()=>{
   let stdout=Buffer.concat(out).toString('utf8'),stderr=Buffer.concat(err).toString('utf8');
   try{
    await stop();if(sizeCheck)await sizeCheck;
    if(files.length){await checkSizes();const first=await readBounded(files[0]!,max),second=await readBounded(files[1]!,max-first.length);stdout=first.toString('utf8');stderr=second.toString('utf8');}
   }catch{captureError=true;stdout='';stderr='Output capture is unavailable';}
   options.signal?.removeEventListener('abort',abort);
   const status=timedOut?'timed_out':spawnError||cancelled||term||truncated||captureError?'error':code===0?'passed':'failed';
   resolve({status,exitCode:code,stdout,stderr:stderr+(spawnError?'\nExecutable could not start':cancelled?'\nExecution cancelled':''),durationMs:finishedAt-startedAt,truncated,startedAt,finishedAt});
  })();});
 });
 }finally{const closed=await Promise.allSettled(files.map(file=>file.close()));if(closed.some(result=>result.status==='rejected'))throw new Error('Output capture could not be closed');}
}
