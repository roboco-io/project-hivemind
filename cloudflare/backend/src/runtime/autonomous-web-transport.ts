import {isIP} from 'node:net';
import {validateWebHosts,type AutonomousWebTransport} from './autonomous-web.ts';
export interface AutonomousWebSocket {
 readable:ReadableStream<Uint8Array>;
 writable:WritableStream<Uint8Array>;
 opened:Promise<unknown>;
 closed:Promise<unknown>;
 startTls(options:{expectedServerHostname:string}):AutonomousWebSocket;
 close():Promise<void>;
}
export type AutonomousWebConnector=(address:{hostname:string;port:number},options:{secureTransport:'starttls';allowHalfOpen:false})=>AutonomousWebSocket|Promise<AutonomousWebSocket>;
const HEADERS=65536,BODY=1048576,DNS_BYTES=65536;
const denied=()=>new Error('Web transport refused');
const timeBounds=new WeakMap<AbortSignal,{at:number;expire:()=>void}>();
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function hostname(value:string):string {
 if(validateWebHosts([value],'https://transport-control.invalid')[0]!==value)throw denied();return value;
}
function dnsName(value:unknown):string {
 if(typeof value!=='string')throw denied();return hostname(value.replace(/\.$/,'').toLowerCase());
}
/** Conservative public-unicast subset, independent of the caller's prior validation. */
function publicIP(value:string):boolean {
 if(isIP(value)===4){const [a,b,c]=value.split('.').map(Number) as [number,number,number];
  return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===88&&c===99))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
 }
 return isIP(value)===6&&/^[23]/i.test(value)&&!/^(2001:|2002:|3fff:)/i.test(value);
}
function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
 const bound=timeBounds.get(signal);if(bound&&Date.now()>=bound.at)bound.expire();
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(denied());signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();
 });
}
function deadline(ms:number,parent?:AbortSignal){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms),relay=()=>controller.abort();
 timeBounds.set(controller.signal,{at:Date.now()+ms,expire:()=>controller.abort()});
 parent?.addEventListener('abort',relay,{once:true});if(parent?.aborted)controller.abort();
 return {signal:controller.signal,clear(){clearTimeout(timer);parent?.removeEventListener('abort',relay);}};
}
async function cleanup(operations:(()=>unknown)[]):Promise<void>{
 const pending=operations.map(async operation=>{try{await operation();}catch{/* Never expose socket errors. */}});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([Promise.all(pending),new Promise<void>(resolve=>{timer=setTimeout(resolve,250);})]);}finally{if(timer)clearTimeout(timer);}
}
/** Lazy import keeps pure Node tests independent of the Workers built-in module. */
async function productionConnector(address:{hostname:string;port:number},options:{secureTransport:'starttls';allowHalfOpen:false}):Promise<AutonomousWebSocket>{
 const {connect}=await import('cloudflare:sockets');return connect(address,options);
}
class Bytes {
 buffer=new Uint8Array(0);done=false;reads=0;total=0;
 private reader:ReadableStreamDefaultReader<Uint8Array>;private signal:AbortSignal;
 constructor(reader:ReadableStreamDefaultReader<Uint8Array>,signal:AbortSignal){this.reader=reader;this.signal=signal;}
 async more():Promise<boolean>{
  if(this.done)return false;if(++this.reads>10000)throw denied();
  const chunk=await bounded(this.reader.read(),this.signal);if(chunk.done){this.done=true;return false;}
  if(!(chunk.value instanceof Uint8Array)||!chunk.value.length)throw denied();
  this.total+=chunk.value.byteLength;if(this.total>BODY+2*HEADERS+16384)throw denied();
  const joined=new Uint8Array(this.buffer.length+chunk.value.length);joined.set(this.buffer);joined.set(chunk.value,this.buffer.length);this.buffer=joined;return true;
 }
 take(size:number):Uint8Array {const part=this.buffer.slice(0,size);this.buffer=this.buffer.slice(size);return part;}
 async exact(size:number):Promise<Uint8Array>{while(this.buffer.length<size)if(!await this.more())throw denied();return this.take(size);}
 async line(max:number):Promise<string>{
  let scanned=0;
  while(true){
   for(let i=scanned;i<this.buffer.length;i++){
    if(this.buffer[i]===10){if(i===0||this.buffer[i-1]!==13||i+1>max)throw denied();const bytes=this.take(i+1);return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,i-1));}
    if(this.buffer[i]===13&&i+1<this.buffer.length&&this.buffer[i+1]!==10)throw denied();
   }
   scanned=Math.max(0,this.buffer.length-1);if(this.buffer.length>=max||!await this.more())throw denied();
  }
 }
}
function header(line:string):[string,string]{
 const match=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):([\t\x20-\x7e]*)$/.exec(line);if(!match)throw denied();return [match[1]!.toLowerCase(),match[2]!.trim()];
}
function validAccept(key:'accept'|'accept-language',value:string):boolean {
 if(value.length>1024||!/^[\x20-\x7e]+$/.test(value))return false;
 const token=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,quality=/^q=(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/i;
 const ranges=value.split(',');if(ranges.length>32)return false;
 return ranges.every(range=>{
  const [name,...params]=range.trim().split(';').map(part=>part.trim());if(!name)return false;
  if(key==='accept-language')return /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(name)&&params.length<=1&&params.every(param=>quality.test(param));
  const media=name.split('/');if(media.length!==2||!media.every(part=>token.test(part))||media[0]==='*'&&media[1]!=='*')return false;
  const seen=new Set<string>();return params.every(param=>{const pieces=param.split('=');if(pieces.length!==2||!pieces.every(piece=>token.test(piece))||seen.has(pieces[0]!.toLowerCase()))return false;seen.add(pieces[0]!.toLowerCase());return pieces[0]!.toLowerCase()!=='q'||quality.test(param);});
 });
}
async function httpResponse(bytes:Bytes,method:string):Promise<Response>{
 const statusLine=await bytes.line(1024);const status=/^HTTP\/1\.[01] ([1-5][0-9]{2}) [\x20-\x7e]*$/.exec(statusLine);if(!status)throw denied();
 const code=Number(status[1]);if(code<200||code>=300&&code<400)throw denied();
 let size=statusLine.length+2;const entries:[string,string][]=[];
 while(true){const line=await bytes.line(HEADERS);size+=line.length+2;if(size>HEADERS)throw denied();if(!line)break;entries.push(header(line));}
 const values=(name:string)=>entries.filter(([key])=>key===name).map(([,value])=>value);
 const lengths=values('content-length'),encodings=values('transfer-encoding');
 if(lengths.length>1||encodings.length>1||lengths.length&&encodings.length)throw denied();
 let length:number|undefined;
 if(lengths.length){if(!/^(0|[1-9][0-9]*)$/.test(lengths[0]!))throw denied();length=Number(lengths[0]);if(!Number.isSafeInteger(length))throw denied();}
 if(encodings.length&&encodings[0]!.toLowerCase()!=='chunked')throw denied();
 if(values('content-encoding').some(v=>v.toLowerCase()!=='identity'))throw denied();
 const headers=new Headers();const stripped=new Set(['set-cookie','set-cookie2','authorization','proxy-authorization','www-authenticate','proxy-authenticate','connection','keep-alive','transfer-encoding','trailer','upgrade','proxy-connection']);
 // Connection-nominated headers are hop-by-hop as well.
 for(const value of values('connection'))for(const token of value.split(',')){const name=token.trim().toLowerCase();if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)||['content-length','transfer-encoding','host'].includes(name))throw denied();stripped.add(name);}
 for(const [key,value] of entries)if(!stripped.has(key))headers.append(key,value);
 if(method==='HEAD'||code===204){if(code===204&&(length!==undefined&&length!==0||encodings.length))throw denied();if(bytes.buffer.length)throw denied();return new Response(null,{status:code,headers});}
 const chunks:Uint8Array[]=[];let bodySize=0;
 const add=(part:Uint8Array)=>{bodySize+=part.length;if(bodySize>BODY)throw denied();chunks.push(part);};
 if(encodings.length){
  let count=0;
  while(true){
   if(++count>10000)throw denied();const line=await bytes.line(128);
   if(!/^[0-9a-fA-F]{1,16}(?:;[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:=[!#$%&'*+.^_`|~0-9A-Za-z-]+)?)*$/.test(line))throw denied();
   const chunkSize=Number.parseInt(line.split(';')[0]!,16);if(!Number.isSafeInteger(chunkSize)||chunkSize>BODY-bodySize)throw denied();
   if(chunkSize===0){let trailers=0;while(true){const trailer=await bytes.line(HEADERS);trailers+=trailer.length+2;if(trailers>HEADERS)throw denied();if(!trailer)break;const [key]=header(trailer);if(['content-length','transfer-encoding','host','connection','content-encoding'].includes(key))throw denied();}break;}
   add(await bytes.exact(chunkSize));const crlf=await bytes.exact(2);if(crlf[0]!==13||crlf[1]!==10)throw denied();
  }
  if(bytes.buffer.length)throw denied();headers.delete('content-length');
 }else if(length!==undefined){if(length>BODY)throw denied();add(await bytes.exact(length));if(bytes.buffer.length)throw denied();}
 else{while(true){if(bytes.buffer.length)add(bytes.take(bytes.buffer.length));if(!await bytes.more())break;}}
 const body=new Uint8Array(bodySize);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
 return new Response(body,{status:code,headers});
}
function dnsAnswer(value:unknown,host:string,type:1|28):{addresses:string[];aliases:string[]}{
 if(!object(value)||value.Status!==0||value.TC!==false||!Array.isArray(value.Question)||value.Question.length!==1)throw denied();
 const question=value.Question[0];if(!object(question)||dnsName(question.name)!==host||question.type!==type)throw denied();
 const answers=value.Answer??[];if(!Array.isArray(answers)||answers.length>32)throw denied();
 const aliases=new Map<string,string>(),addresses=new Map<string,string[]>();
 for(const answer of answers){
  if(!object(answer)||!Number.isSafeInteger(answer.TTL)||Number(answer.TTL)<0||Number(answer.TTL)>2147483647)throw denied();
  const name=dnsName(answer.name);
  if(answer.type===5){const target=dnsName(answer.data);if(aliases.has(name)&&aliases.get(name)!==target)throw denied();aliases.set(name,target);}
  else if(answer.type===type){if(typeof answer.data!=='string'||isIP(answer.data)!==(type===1?4:6)||!publicIP(answer.data))throw denied();addresses.set(name,[...(addresses.get(name)??[]),answer.data]);}
  else throw denied();
 }
 let current=host;const chain:string[]=[],seen=new Set<string>();
 while(aliases.has(current)){
  if(seen.has(current)||chain.length>=8||addresses.has(current))throw denied();seen.add(current);current=aliases.get(current)!;chain.push(current);
 }
 if(seen.has(current))throw denied();seen.add(current);
 if([...aliases.keys(),...addresses.keys()].some(name=>!seen.has(name))||[...addresses.keys()].some(name=>name!==current))throw denied();
 const result=addresses.get(current)??[];if(result.length>16)throw denied();return {addresses:result,aliases:chain};
}
/** Server-only factory. Never accept connector, resolver or timeout settings from model wire. */
export function createAutonomousWebTransport(options:{connector?:AutonomousWebConnector;fetchImpl?:typeof fetch;timeoutMs?:number}={}):AutonomousWebTransport {
 const timeout=options.timeoutMs??10000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw denied();
 const connector=options.connector??productionConnector,fetcher=options.fetchImpl??fetch;
 return {
 async resolve(name){
  const limit=deadline(timeout);const readers:ReadableStreamDefaultReader<Uint8Array>[]=[];const responses:Response[]=[];
  try{
   hostname(name);
   const query=async(type:1|28)=>{
    const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',name);url.searchParams.set('type',type===1?'A':'AAAA');url.searchParams.set('do','true');
    const pending=fetcher(url,{method:'GET',headers:{accept:'application/dns-json'},credentials:'omit',redirect:'error',cache:'no-store',signal:limit.signal});
    void pending.then(response=>{if(limit.signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    const response=await bounded(pending,limit.signal);responses.push(response);
    const contentLength=response.headers.get('content-length');if(contentLength!==null&&(!/^(0|[1-9][0-9]*)$/.test(contentLength)||Number(contentLength)>DNS_BYTES))throw denied();
    if(response.status!==200||response.redirected||!response.body||!/^application\/(?:dns-json|json)(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||Number(response.headers.get('content-length')??0)>DNS_BYTES)throw denied();
    const reader=response.body.getReader();readers.push(reader);const chunks:Uint8Array[]=[];let size=0,reads=0;
    while(true){if(++reads>10000)throw denied();const {value,done}=await bounded(reader.read(),limit.signal);if(done)break;size+=value.byteLength;if(size>DNS_BYTES)throw denied();chunks.push(value);}
    const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
    return dnsAnswer(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)),name,type);
   };
   // Sequential queries keep cleanup deterministic when either bounded response is invalid.
   const a=await query(1),aaaa=await query(28);
   if(JSON.stringify(a.aliases)!==JSON.stringify(aaaa.aliases))throw denied();
   const addresses=[...new Set([...a.addresses,...aaaa.addresses])];if(!addresses.length||addresses.length>16)throw denied();
   return {addresses,aliases:a.aliases};
  }catch{throw denied();}finally{
   limit.clear();await cleanup([...readers.map(reader=>()=>reader.cancel()),...responses.filter(r=>!r.body?.locked).map(r=>()=>r.body?.cancel())]);for(const reader of readers)try{reader.releaseLock();}catch{}
  }
 },
 async fetch(request,route){
  const limit=deadline(timeout,request.signal);let raw:AutonomousWebSocket|undefined,tls:AutonomousWebSocket|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,writer:WritableStreamDefaultWriter<Uint8Array>|undefined;
  try{
   limit.signal.throwIfAborted();const url=new URL(request.url);
   if(!['GET','HEAD'].includes(request.method)||url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.hostname!==route.hostname)throw denied();hostname(route.hostname);
   if(!Array.isArray(route.addresses)||!route.addresses.length||route.addresses.length>16||route.addresses.some(address=>typeof address!=='string'||!publicIP(address)))throw denied();
   const target=url.pathname+url.search;if(target.length>8192||!/^[\x21-\x7e]+$/.test(target))throw denied();
   let wire=request.method+' '+target+' HTTP/1.1\r\nHost: '+route.hostname+'\r\nConnection: close\r\nAccept-Encoding: identity\r\n';
   for(const [key,label] of [['accept','Accept'],['accept-language','Accept-Language']] as const){const value=request.headers.get(key);if(value!==null){if(!validAccept(key,value))throw denied();wire+=label+': '+value+'\r\n';}}
   // Exactly one literal-IP attempt. No hostname connect, redirect, fallback or second lookup.
   const pending=Promise.resolve(connector({hostname:route.addresses[0]!,port:443},{secureTransport:'starttls',allowHalfOpen:false}));
   // A delayed injected connector must not leak its socket after cancellation.
   void pending.then(socket=>{void Promise.resolve(socket.closed).catch(()=>{});if(limit.signal.aborted)void cleanup([()=>socket.close()]);},()=>{});
   raw=await bounded(pending,limit.signal);void raw.closed.catch(()=>{});await bounded(raw.opened,limit.signal);
   tls=raw.startTls({expectedServerHostname:route.hostname});if(tls===raw)throw denied();void tls.closed.catch(()=>{});await bounded(tls.opened,limit.signal);
   writer=tls.writable.getWriter();reader=tls.readable.getReader();await bounded(writer.write(new TextEncoder().encode(wire+'\r\n')),limit.signal);
   const response=await httpResponse(new Bytes(reader,limit.signal),request.method);limit.signal.throwIfAborted();return response;
  }catch{throw denied();}finally{
   limit.clear();await cleanup([...(reader?[()=>reader!.cancel()]:[]),...(writer?[()=>writer!.abort()]:[]),...(tls?[()=>tls!.close()]:[]),...(raw?[()=>raw!.close()]:[])]);
   try{reader?.releaseLock();}catch{}try{writer?.releaseLock();}catch{}
  }
 }
 };
}
