const unavailable=()=>new Error('AWS web identity unavailable');
function check(value:unknown):asserts value {if(!value)throw unavailable();}
/** Narrow XML parser: no DTD, custom entities, processing instructions or mixed content. */
export function parseXml(xml:string,rootName:string):Map<string,string>{
 check(!/<!/.test(xml)&&xml.length<=65536);xml=xml.replace(/^\uFEFF/,'').replace(/^<\?xml version=["']1\.0["'](?: encoding=["']UTF-8["'])?\s*\?>/i,'');
 const stack:string[]=[],seen=new Set<string>(),values=new Map<string,string>();let offset=0,root=false;
 for(const part of xml.matchAll(/<[^>]*>|[^<]+/g)){
  check(part.index===offset);const token=part[0];offset+=token.length;
  if(token.startsWith('<')){
   const close=/^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
   if(close){check(stack.pop()===close[1]);continue;}
   const open=/^<([A-Za-z][A-Za-z0-9]*)(?:\s+xmlns=["']https:\/\/sts\.amazonaws\.com\/doc\/2011-06-15\/["'])?\s*>$/.exec(token);check(open);
   if(stack.length===0){check(!root&&open[1]===rootName);root=true;}
   else check(!token.includes('xmlns='));
   stack.push(open[1]!);check(stack.length<=8);const path=stack.join('/');check(!seen.has(path));seen.add(path);check(seen.size<=64);values.set(path,'');
  }else if(stack.length){const path=stack.join('/');values.set(path,values.get(path)!+token);}
  else check(token.trim()==='');
 }
 check(offset===xml.length&&root&&stack.length===0);
 for(const [path,value] of values){
  if([...seen].some(p=>p.startsWith(path+'/'))){check(value.trim()==='');continue;}
  const decoded=value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,entity=>{
   const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(named[entity])return named[entity]!;
   const point=entity.startsWith('&#x')?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));check(point>=32&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff));return String.fromCodePoint(point);
  });check(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value));values.set(path,decoded.trim());
 }
 return values;
}
export async function responseBody(response:Response,signal:AbortSignal):Promise<string>{
 if(!response.ok){void response.body?.cancel().catch(()=>{});throw unavailable();}check(response.body);const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,result='';
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;check(size<=65536);result+=decoder.decode(value,{stream:true});}return result+decoder.decode();}
 finally{signal.removeEventListener('abort',cancel);cancel();}
}
export async function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();let abort:()=>void=()=>{};
 const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(unavailable());signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener('abort',abort);}
}
