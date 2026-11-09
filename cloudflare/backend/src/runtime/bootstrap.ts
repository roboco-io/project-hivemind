import {createServer} from 'node:http';
import {mkdir,open,readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateRuntimeInput} from './providers.ts';
import {validateSnapshot} from '../snapshot.ts';
export function createBootstrap(runtimeDir='/runtime') {
 return createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try {
   const path=new URL(req.url??'/','http://runtime').pathname;
   if(req.method==='GET'&&path==='/health')return send(200,{ok:true});
   if(req.method==='POST'&&path==='/prepare'){
    let bytes=0;const chunks:Buffer[]=[];
    for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>8*1024*1024)return send(413,{error:'Runtime input is too large'});chunks.push(b);}
    let input;try{input=validateRuntimeInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));input.snapshot=validateSnapshot(input.snapshot);}catch{return send(400,{error:'Invalid runtime input'});}
    await mkdir(runtimeDir,{recursive:true,mode:0o700});
    let file;try{file=await open(join(runtimeDir,'input.json'),'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const old=JSON.parse(await readFile(join(runtimeDir,'input.json'),'utf8'));return send(JSON.stringify(old)===JSON.stringify(input)?200:409,{prepared:true,jobId:old.jobId,attempt:old.attempt});}
    try{await file.writeFile(JSON.stringify(input));await file.sync();}finally{await file.close();}
    return send(201,{prepared:true,jobId:input.jobId,attempt:input.attempt});
   }
   if(req.method==='GET'&&path==='/state'){
    const exists=async(name:string)=>stat(join(runtimeDir,name)).then(()=>true,()=>false);
    const started=await readFile(join(runtimeDir,'started.json'),'utf8').then(s=>JSON.parse(s),()=>null);
    return send(200,{prepared:await exists('input.json'),started,resultReady:await exists('result.json'),cancelRequested:await exists('cancel')});
   }
   if(req.method==='GET'&&path==='/result'){
    const file=join(runtimeDir,'result.json');const info=await stat(file).catch(()=>null);if(!info)return send(404,{error:'Result is not ready'});
    if(info.size>8*1024*1024)return send(500,{error:'Runtime result is too large'});
    return send(200,JSON.parse(await readFile(file,'utf8')));
   }
   if(req.method==='POST'&&path==='/cancel'){
    await mkdir(runtimeDir,{recursive:true,mode:0o700});await writeFile(join(runtimeDir,'cancel'),'cancel',{mode:0o600});return send(202,{cancelRequested:true});
   }
   return send(404,{error:'Not found'});
  }catch{return send(500,{error:'Runtime storage is unavailable'});}
 });
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)createBootstrap().listen(3000,'0.0.0.0');
