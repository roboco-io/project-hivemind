import {createHash,createHmac} from 'node:crypto';
import type {WorkloadDescriptor} from '../../../packages/contracts/src/delegated.ts';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const encode=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
/** Metadata operations only. No body, arbitrary host, list, or cross-prefix request. */
export function signDelegatedS3Request(request:Request,descriptor:WorkloadDescriptor,credentials:{accessKeyId:string;secretAccessKey:string;sessionToken?:string},now:number):Request{
 const url=new URL(request.url),host=`${descriptor.s3.bucket}.s3.${descriptor.region}.amazonaws.com`,key=decodeURIComponent(url.pathname.slice(1));
 const allowed=['versionId',...(request.method==='GET'?['acl']:[])];
 if(url.protocol!=='https:'||url.host!==host||url.username||url.password||url.hash||!['HEAD','GET','DELETE'].includes(request.method)||request.body||!key.startsWith(descriptor.s3.prefix)||key.includes('..')||![...url.searchParams.keys()].every(k=>allowed.includes(k)&&url.searchParams.getAll(k).length===1)||!url.searchParams.get('versionId')||request.method==='GET'&&!url.searchParams.has('acl')||request.headers.get('x-amz-expected-bucket-owner')!==descriptor.accountId)throw Error('Delegated metadata scope unavailable');
 const stamp=new Date(now).toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8),headers=new Headers(request.headers);
 for(const key of ['authorization','host','x-amz-date','x-amz-security-token','x-amz-content-sha256'])if(headers.has(key))throw Error('Delegated metadata scope unavailable');
 headers.set('x-amz-date',stamp);headers.set('x-amz-content-sha256',hash(''));if(credentials.sessionToken)headers.set('x-amz-security-token',credentials.sessionToken);
 const values:[string,string][]=[];headers.forEach((v,k)=>values.push([k,v]));const entries=[...values,['host',host]].sort(([a],[b])=>a!<b!?-1:a!>b!?1:0),names=entries.map(([k])=>k).join(';');
 const query=[...url.searchParams].map(([k,v])=>[encode(k),encode(v)]).sort(([a,b],[c,d])=>a!<c!?-1:a!>c!?1:b!<d!?-1:b!>d!?1:0).map(([k,v])=>k+'='+v).join('&');
 const path='/'+key.split('/').map(encode).join('/'),canonical=[request.method,path,query,entries.map(([k,v])=>k+':'+v!.trim().replace(/\s+/g,' ')+'\n').join(''),names,hash('')].join('\n');
 const scope=`${day}/${descriptor.region}/s3/aws4_request`,hmac=(key:string|Uint8Array,v:string)=>createHmac('sha256',key).update(v).digest();let signing=hmac('AWS4'+credentials.secretAccessKey,day);for(const v of [descriptor.region,'s3','aws4_request'])signing=hmac(signing,v);
 const signature=createHmac('sha256',signing).update(['AWS4-HMAC-SHA256',stamp,scope,hash(canonical)].join('\n')).digest('hex');headers.set('authorization',`AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`);
 return new Request(request,{headers,redirect:'manual'});
}
