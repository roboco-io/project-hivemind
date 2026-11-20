import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutonomousWebTransport,type AutonomousWebSocket,type AutonomousWebConnector} from '../src/runtime/autonomous-web-transport.ts';
const host='docs.example.com',ip='93.184.216.34';
const encode=(s:string)=>new TextEncoder().encode(s);
function fixture(response='HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello',options:{stall?:boolean;opened?:Promise<unknown>;tlsFail?:boolean;chunks?:Uint8Array[]}={}){
 const addresses:unknown[]=[],sni:string[]=[],writes:Uint8Array[]=[];let rawClosed=0,tlsClosed=0,cancelled=0,aborted=0;
 const tls:AutonomousWebSocket={opened:options.opened??Promise.resolve({}),closed:Promise.resolve(),readable:new ReadableStream<Uint8Array>({start(c){if(options.stall)return;for(const chunk of options.chunks??[encode(response)])c.enqueue(chunk);c.close();},cancel(){cancelled++;}}),writable:new WritableStream<Uint8Array>({write(b){writes.push(b);},abort(){aborted++;}}),startTls(){throw Error('unexpected');},async close(){tlsClosed++;}};
 const raw:AutonomousWebSocket={...tls,opened:Promise.resolve({}),startTls({expectedServerHostname}){sni.push(expectedServerHostname);if(options.tlsFail)throw Error('synthetic private TLS detail');return tls;},async close(){rawClosed++;}};
 const connector:AutonomousWebConnector=(address,settings)=>{addresses.push({address,settings});return raw;};
 const transport=createAutonomousWebTransport({connector,timeoutMs:100});
 const fetch=(request=new Request('https://'+host+'/path?q=1'))=>transport.fetch(request,{hostname:host,addresses:[ip]});
 return {transport,connector,fetch,addresses,sni,wire:()=>new TextDecoder().decode(Buffer.concat(writes)),cleanup:()=>({rawClosed,tlsClosed,cancelled,aborted})};
}
test('synthetic TLS socket pins validated literal IP and original certificate hostname without credential headers',async()=>{
 const f=fixture();const response=await f.fetch(new Request('https://'+host+'/path?q=1',{headers:{authorization:'Bearer SYNTHETIC',cookie:'SYNTHETIC=1',accept:'text/plain','accept-language':'ko','x-private':'SYNTHETIC'}}));
 assert.equal(await response.text(),'hello');assert.deepEqual(f.addresses,[{address:{hostname:ip,port:443},settings:{secureTransport:'starttls',allowHalfOpen:false}}]);assert.deepEqual(f.sni,[host]);
 assert.equal(f.wire(),'GET /path?q=1 HTTP/1.1\r\nHost: '+host+'\r\nConnection: close\r\nAccept-Encoding: identity\r\nAccept: text/plain\r\nAccept-Language: ko\r\n\r\n');assert.equal(f.wire().includes('SYNTHETIC'),false);assert.equal(f.cleanup().rawClosed,1);assert.equal(f.cleanup().tlsClosed,1);
});
test('synthetic bounded HTTP chunked, content-length and EOF framing preserve bytes',async()=>{
 for(const wire of ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nSet-Cookie: SYNTHETIC=1\r\nWWW-Authenticate: SYNTHETIC\r\n\r\n2\r\nhe\r\n3;foo=bar\r\nllo\r\n0\r\nX-Trailer: ignored\r\n\r\n','HTTP/1.0 200 OK\r\n\r\nhello']){
  const f=fixture(wire,{chunks:[...encode(wire)].map(b=>Uint8Array.of(b))});const response=await f.fetch();assert.equal(await response.text(),'hello');assert.equal(response.headers.has('set-cookie'),false);assert.equal(response.headers.has('www-authenticate'),false);assert.equal(response.headers.has('transfer-encoding'),false);
 }
});
test('HEAD and 204 are bodyless without waiting for EOF',async()=>{
 for(const [method,wire] of [['HEAD','HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n'],['GET','HTTP/1.1 204 No Content\r\n\r\n']]){
  const f=fixture(wire!);const response=await f.fetch(new Request('https://'+host,{method}));assert.equal(response.body,null);assert.ok(f.wire().startsWith(method!+' / HTTP/1.1'));
 }
});
test('malformed, truncated and ambiguous HTTP framing fail closed and close both sockets',async()=>{
 const invalid=['HTTP/1.1 302 Found\r\nLocation: https://other.example.com\r\n\r\n','HTTP/1.1 100 Continue\r\n\r\n','HTTP/2 200 OK\r\n\r\n','HTTP/1.1 200 OK\n\nhello','HTTP/1.1 200 OK\r\n Folded: invalid\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nhello','HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello','HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\nhello','HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 9007199254740992\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhello','HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nhello','HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhell','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nContent-Length: 1\r\n\r\n','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX0\r\n\r\n','HTTP/1.1 204 No Content\r\nContent-Length: 1\r\n\r\n'];
 for(const wire of invalid){const f=fixture(wire);await assert.rejects(f.fetch(),{message:'Web transport refused'});assert.equal(f.cleanup().rawClosed,1);assert.equal(f.cleanup().tlsClosed,1);assert.equal(f.addresses.length,1);}
});
test('header, body, chunk and EOF limits reject oversized input',async()=>{
 for(const wire of ['HTTP/1.1 200 OK\r\nX-Huge: '+'a'.repeat(65536)+'\r\n\r\n','HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n','HTTP/1.1 200 OK\r\n\r\n'+'a'.repeat(1048577),'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n100001\r\n'])await assert.rejects(fixture(wire).fetch());
 const response=await fixture('HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\n\r\n'+'a'.repeat(1048576)).fetch();assert.equal((await response.arrayBuffer()).byteLength,1048576);
});
test('private routes, URL mismatch and unsafe accept values never connect',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.0.2.1','198.51.100.1','::1','::ffff:93.184.216.34','2001:db8::1','2002:1234::1','localhost']){
  const f=fixture();await assert.rejects(f.transport.fetch(new Request('https://'+host),{hostname:host,addresses:[ip,address]}));assert.equal(f.addresses.length,0);
 }
 for(const request of [new Request('http://'+host),new Request('https://'+host+':444'),new Request('https://other.example.com'),new Request('https://'+host,{method:'POST'}),new Request('https://'+host,{headers:{accept:'a'.repeat(1025)}})]){const f=fixture();await assert.rejects(f.fetch(request));assert.equal(f.addresses.length,0);}
});
test('TLS failure does not retry or fall back and does not expose socket diagnostics',async()=>{
 const f=fixture('',{tlsFail:true});await assert.rejects(f.fetch(),{message:'Web transport refused'});assert.equal(f.addresses.length,1);assert.equal(f.cleanup().rawClosed,1);assert.equal(f.wire(),'');
});
test('abort, read timeout and TLS-open timeout cancel and close resources',async()=>{
 const controller=new AbortController(),f=fixture('',{stall:true});const pending=f.fetch(new Request('https://'+host,{signal:controller.signal}));await new Promise<void>(r=>setImmediate(r));controller.abort();await assert.rejects(pending);assert.equal(f.cleanup().cancelled,1);assert.equal(f.cleanup().aborted,1);assert.equal(f.cleanup().tlsClosed,1);assert.equal(f.cleanup().rawClosed,1);
 const stalled=fixture('',{stall:true});await assert.rejects(stalled.fetch());assert.equal(stalled.cleanup().cancelled,1);
 const opening=fixture('',{opened:new Promise(()=>{})});await assert.rejects(opening.fetch());assert.equal(opening.cleanup().tlsClosed,1);assert.equal(opening.cleanup().rawClosed,1);
 const cancelled=new AbortController();cancelled.abort();const early=fixture();await assert.rejects(early.fetch(new Request('https://'+host,{signal:cancelled.signal})));assert.equal(early.addresses.length,0);
});
const rr=(name:string,type:number,data:string)=>({name:name+'.',type,TTL:300,data});
function dnsFixture(change?:(answer:any,type:1|28)=>unknown){
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const transport=createAutonomousWebTransport({connector:()=>{throw Error('DNS must not connect sockets');},timeoutMs:100,fetchImpl:async(input,init)=>{
  const url=new URL(String(input));calls.push({url:url.href,init});const type=url.searchParams.get('type')==='A'?1:28;
  const answer={Status:0,TC:false,Question:[{name:host+'.',type}],Answer:[rr(host,5,'cdn.example.com.'),rr('cdn.example.com',type,type===1?ip:'2606:4700:4700::1111')]};return Response.json(change?change(answer,type):answer);
 }});return {transport,calls};
}
test('fixed DoH resolves A/AAAA with validated CNAME chain and never inherits request credentials',async()=>{
 const f=dnsFixture();assert.deepEqual(await f.transport.resolve(host),{addresses:[ip,'2606:4700:4700::1111'],aliases:['cdn.example.com']});assert.equal(f.calls.length,2);
 for(const [index,call] of f.calls.entries()){const url=new URL(call.url);assert.equal(url.origin,'https://cloudflare-dns.com');assert.equal(url.pathname,'/dns-query');assert.equal(url.searchParams.get('name'),host);assert.equal(url.searchParams.get('type'),index?'AAAA':'A');assert.equal(url.searchParams.get('do'),'true');assert.deepEqual(call.init?.headers,{accept:'application/dns-json'});assert.equal(call.init?.credentials,'omit');assert.equal(call.init?.redirect,'error');}
});
test('malformed DNS, private answers and CNAME loops or unrelated chains fail closed',async()=>{
 for(const change of [(v:any)=>({...v,Status:3}),(v:any)=>({...v,TC:true}),(v:any)=>({...v,Question:[{name:'other.example.com',type:1}]}),(v:any)=>({...v,Answer:[rr(host,1,'127.0.0.1')]}),(v:any)=>({...v,Answer:[rr(host,5,'api.anthropic.com.')] }),(v:any)=>({...v,Answer:[rr(host,5,'cdn.example.com.'),rr('cdn.example.com',5,host+'.')]}),(v:any)=>({...v,Answer:[...v.Answer,rr('unrelated.example.com',1,ip)]}),(v:any)=>({...v,Answer:[rr(host,5,'a.example.com.'),rr(host,5,'b.example.com.')]}),(v:any)=>({...v,Answer:[rr(host,1,ip),rr(host,5,'cdn.example.com.')]}),(v:any)=>({...v,Answer:[]})])await assert.rejects(dnsFixture(change).transport.resolve(host));
 await assert.rejects(dnsFixture((v,type)=>type===28?{...v,Answer:[]}:v).transport.resolve(host));
 const f=dnsFixture();await assert.rejects(f.transport.resolve('localhost'));assert.equal(f.calls.length,0);
});
test('DNS bounds bytes, timeout and redirects without following alternate resolver URLs',async()=>{
 for(const fetchImpl of [async()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),async()=>new Response('bad',{status:302,headers:{location:'http://127.0.0.1'}}),async()=>Response.json({Status:0}),async()=>new Response('not json',{headers:{'content-type':'application/json'}}),async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})]){
  const transport=createAutonomousWebTransport({fetchImpl,timeoutMs:10});await assert.rejects(transport.resolve(host),{message:'Web transport refused'});
 }
});
import {dispatchAutonomousWeb} from '../src/runtime/autonomous-web.ts';
test('actual dispatch checks every CNAME grant before any pinned socket connection',async()=>{
 for(const approved of [false,true]){
  const f=fixture();let queries=0;
  const transport=createAutonomousWebTransport({connector:f.connector,fetchImpl:async input=>{queries++;const type=new URL(String(input)).searchParams.get('type')==='A'?1:28;return Response.json({Status:0,TC:false,Question:[{name:host,type}],Answer:[rr(host,5,'cdn.example.com.'),...(type===1?[rr('cdn.example.com',1,ip)]:[])]});}});
  const response=await dispatchAutonomousWeb(new Request('https://'+host),{allowedHosts:approved?[host,'cdn.example.com']:[host]},'https://control.example.com',transport);
  assert.equal(response.status,approved?200:403);assert.equal(f.addresses.length,approved?1:0);assert.equal(queries,2);
 }
});
test('literal IPv6 route keeps original SNI and never asks connector to resolve a hostname',async()=>{
 const f=fixture();await f.transport.fetch(new Request('https://'+host),{hostname:host,addresses:['2606:4700:4700::1111']});assert.deepEqual(f.addresses[0],{address:{hostname:'2606:4700:4700::1111',port:443},settings:{secureTransport:'starttls',allowHalfOpen:false}});assert.deepEqual(f.sni,[host]);
});
test('late connector resolution after abort closes the unused raw socket',async()=>{
 let release!:(socket:AutonomousWebSocket)=>void,closed=0;const pendingSocket=new Promise<AutonomousWebSocket>(r=>{release=r;});const controller=new AbortController();
 const transport=createAutonomousWebTransport({connector:()=>pendingSocket,timeoutMs:100});const pending=transport.fetch(new Request('https://'+host,{signal:controller.signal}),{hostname:host,addresses:[ip]});controller.abort();await assert.rejects(pending);
 release({async close(){closed++;}} as AutonomousWebSocket);await new Promise<void>(r=>setImmediate(r));assert.equal(closed,1);
});
test('accept headers use conservative MIME and language syntax before connecting',async()=>{
 for(const headers of [{accept:'text/html, application/json;q=0.9'},{'accept-language':'ko-KR, en;q=0.5'}] as Record<string,string>[])assert.equal((await fixture().fetch(new Request('https://'+host,{headers}))).status,200);
 for(const headers of [{accept:'not-a-media-type'},{accept:'text/plain;q=2'},{'accept-language':'en;q=2'},{'accept-language':'../../internal'}] as Record<string,string>[]){const f=fixture();await assert.rejects(f.fetch(new Request('https://'+host,{headers})));assert.equal(f.addresses.length,0);}
});
test('late DoH response after deadline is cancelled and never used',async()=>{
 let release!:(response:Response)=>void,cancelled=0;const late=new Promise<Response>(r=>{release=r;});const transport=createAutonomousWebTransport({fetchImpl:()=>late,timeoutMs:5});await assert.rejects(transport.resolve(host));
 release(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));await new Promise<void>(r=>setImmediate(r));assert.equal(cancelled,1);
});
