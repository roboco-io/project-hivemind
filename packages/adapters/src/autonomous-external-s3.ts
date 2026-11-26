import {createHash,createHmac} from 'node:crypto';
import type {ExternalInvocation,ExternalProviderReceipt} from '../../contracts/src/autonomous-external.js';
import type {ExternalS3Target} from '../../contracts/src/autonomous-external-s3.js';
import {EXTERNAL_S3_MAX_OBJECT_BYTES,externalS3Mark,externalS3ObjectKey,externalS3PutOf,validateExternalS3Target} from '../../core/src/autonomous-external-s3.ts';
import {externalParametersHash,type ExternalDispatchAuthority} from '../../core/src/autonomous-external.ts';
import {externalArtifactDigest,validateExternalArtifact,type ExternalArtifact,type ExternalProviderCredential} from './autonomous-external.ts';

const TIMEOUT_MS=5000;
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const hmac=(key:string|Uint8Array,value:string)=>createHmac('sha256',key).update(value).digest();
function fail():never {throw new Error('S3 transport unavailable');}
function need(condition:unknown):asserts condition {if(!condition)fail();}
export interface ExternalS3SignInput {
  method:'PUT'|'HEAD'; target:Pick<ExternalS3Target,'region'|'bucket'>; key:string;
  headers:Record<string,string>; payloadSha256:string;
  credential:{accessKeyId:string;secretAccessKey:string;sessionToken?:string}; now:number;
}
/** SigV4 for virtual-hosted S3. Every header in the result except `host` is signed; fetch sets `host` itself. */
export function signExternalS3Request(input:ExternalS3SignInput):{url:string;method:'PUT'|'HEAD';headers:Record<string,string>} {
  const {region,bucket}=input.target;
  need(/^[a-z]{2}-[a-z]+-\d$/.test(region)&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)&&/^[a-f0-9]{64}$/.test(input.payloadSha256));
  need(/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,1023}$/.test(input.key)&&Number.isSafeInteger(input.now));
  const host=`${bucket}.s3.${region}.amazonaws.com`,date=new Date(input.now).toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8);
  const h:Record<string,string>={};
  for(const [k,v] of Object.entries(input.headers)){const name=k.toLowerCase();need(!(name in h)&&typeof v==='string'&&!/[\r\n]/.test(v));h[name]=v.trim();}
  need(!['host','x-amz-date','x-amz-content-sha256','x-amz-security-token','authorization'].some(k=>k in h));
  h['x-amz-date']=date;h['x-amz-content-sha256']=input.payloadSha256;
  if(input.credential.sessionToken)h['x-amz-security-token']=input.credential.sessionToken;
  const signedMap:Record<string,string>={...h,host},names=Object.keys(signedMap).sort(),signed=names.join(';');
  const path='/'+input.key.split('/').map(encodeURIComponent).join('/');
  const canonical=names.map(k=>`${k}:${signedMap[k]}\n`).join(''),request=`${input.method}\n${path}\n\n${canonical}\n${signed}\n${input.payloadSha256}`;
  const scope=`${day}/${region}/s3/aws4_request`,key=hmac(hmac(hmac(hmac('AWS4'+input.credential.secretAccessKey,day),region),'s3'),'aws4_request');
  h.authorization=`AWS4-HMAC-SHA256 Credential=${input.credential.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${createHmac('sha256',key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(request)}`).digest('hex')}`;
  return {url:`https://${host}${path}`,method:input.method,headers:h};
}
export interface ExternalS3TransportOptions {
  enabled?:boolean; target:ExternalS3Target;
  loadFiles:(i:ExternalInvocation)=>Promise<ExternalArtifact['files']>;
  fetch?:typeof fetch; now?:()=>number;
}
export interface ExternalS3Transport {
  execute(i:ExternalInvocation,c:ExternalProviderCredential,authority?:ExternalDispatchAuthority):Promise<ExternalProviderReceipt>;
  inspect(i:ExternalInvocation,c:ExternalProviderCredential):Promise<ExternalProviderReceipt|null>;
}
type Verdict='match'|'other'|'conflict';
export function createExternalS3Transport(options:ExternalS3TransportOptions):ExternalS3Transport {
  const target=validateExternalS3Target(options.target),fetcher=options.fetch??fetch,now=options.now??Date.now;
  function gate(i:ExternalInvocation,c:ExternalProviderCredential,execute:boolean){
    need(options.enabled===true&&i.profile.enabled===true&&i.profile.provider==='s3'&&c.provider==='aws');
    need(JSON.stringify(validateExternalS3Target(i.profile.target))===JSON.stringify(target));
    need((i.profile.operations as readonly string[]).includes(i.operation)&&(execute?i.operation==='aws.s3.put':i.operation==='aws.s3.put'||i.operation==='aws.s3.inspect'));
    for(const v of [i.ownershipToken,i.idempotencyKey,i.actionId])need(typeof v==='string'&&v.length>0&&v.length<=256);
    need(/^[a-f0-9]{64}$/.test(i.parametersHash)&&externalParametersHash(i.profile,i.operation,i.parameters)===i.parametersHash);
    externalS3PutOf(i);
    need(Number.isSafeInteger(i.expiresAt)&&(!execute||now()<i.expiresAt));
    need(typeof c.accessKeyId==='string'&&c.accessKeyId.length>0&&c.accessKeyId.length<=128&&typeof c.secretAccessKey==='string'&&c.secretAccessKey.length>0&&c.secretAccessKey.length<=4096);
    need(c.sessionToken===undefined||(typeof c.sessionToken==='string'&&c.sessionToken.length<=8192));
  }
  /** Same canonical JSON the artifact publisher stores, so the S3 checksum is the artifact digest bytes in base64. */
  async function prepare(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{provider:'aws'}>,authority?:ExternalDispatchAuthority){
    const files=await options.loadFiles(i);authority?.assertActive();
    const secrets=[c.accessKeyId,c.secretAccessKey,c.sessionToken??''].filter(v=>Buffer.byteLength(v)>=8);
    const artifact=validateExternalArtifact({files},secrets);
    // The put decides key, digest and mark. An inspect only reads the object of its owned put.
    const put=externalS3PutOf(i);
    need(externalArtifactDigest(artifact)===put.parameters.artifactDigest);
    const body=Buffer.from(JSON.stringify(artifact));
    need(body.length<=Math.min(target.maxObjectBytes,EXTERNAL_S3_MAX_OBJECT_BYTES));
    return {body,key:externalS3ObjectKey(target,put.parameters.keySuffix),checksum:Buffer.from(put.parameters.artifactDigest,'hex').toString('base64'),mark:externalS3Mark(put)};
  }
  async function send(method:'PUT'|'HEAD',key:string,headers:Record<string,string>,body:Uint8Array|undefined,c:Extract<ExternalProviderCredential,{provider:'aws'}>,authority?:ExternalDispatchAuthority,expiresAt?:number):Promise<Response> {
    authority?.assertActive();
    const signed=signExternalS3Request({method,target,key,headers,payloadSha256:sha256(body??''),credential:c,now:now()});
    const controller=new AbortController(),signal=authority?AbortSignal.any([controller.signal,authority.signal]):controller.signal;
    let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
    try{
      const response=await Promise.race([
        fetcher(signed.url,{method,headers:signed.headers,body:body as BodyInit|undefined,redirect:'error',signal}),
        new Promise<never>((_,reject)=>{abort=()=>reject(new Error('S3 transport unavailable'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
          timer=setTimeout(()=>controller.abort(),Math.min(TIMEOUT_MS,expiresAt===undefined?TIMEOUT_MS:Math.max(1,expiresAt-now())));}),
      ]);
      need(!response.redirected);authority?.assertActive();
      try{await response.body?.cancel();}catch{/* body is never used */}
      return response;
    }finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
  }
  function verdict(response:Response,p:{body:Buffer;checksum:string;mark:string}):Verdict {
    const h=response.headers,mark=h.get('x-amz-meta-hivemind-mark');
    // The mark is always the owning put's mark, for put and inspect alike, so neither can adopt a foreign object.
    if(mark!==p.mark)return 'other';
    const length=h.get('content-length'),sse=h.get('x-amz-server-side-encryption'),kms=h.get('x-amz-server-side-encryption-aws-kms-key-id');
    const kmsOk=target.kmsKeyId===undefined||(sse==='aws:kms'&&kms!==null&&(kms===target.kmsKeyId||(/^[A-Za-z0-9-]+$/.test(target.kmsKeyId)&&kms.endsWith(':key/'+target.kmsKeyId))));
    return h.get('x-amz-checksum-sha256')===p.checksum&&length===String(p.body.length)&&kmsOk?'match':'conflict';
  }
  function receipt(i:ExternalInvocation,key:string,v:Verdict):ExternalProviderReceipt {
    const evidenceId='s3:'+sha256(`${target.bucket}/${key}`).slice(0,32),base={ownershipToken:i.ownershipToken,idempotencyKey:i.idempotencyKey,evidenceId,billing:{verifiedCostMicros:null,final:false}};
    if(v==='match')return {...base,outcome:'succeeded',effect:i.operation==='aws.s3.put'?'retained':'none'};
    // A different mark means another writer owns the key; If-None-Match guarantees this action did not overwrite it.
    return v==='other'||(v==='conflict'&&i.operation==='aws.s3.inspect')?{...base,outcome:'failed',effect:'none'}:{...base,outcome:'unknown',effect:'unknown'};
  }
  async function head(i:ExternalInvocation,p:Awaited<ReturnType<typeof prepare>>,c:Extract<ExternalProviderCredential,{provider:'aws'}>,authority?:ExternalDispatchAuthority){
    return send('HEAD',p.key,{'x-amz-checksum-mode':'ENABLED','x-amz-expected-bucket-owner':target.accountId},undefined,c,authority,authority?i.expiresAt:undefined);
  }
  return {
    async execute(i,c,authority){
      gate(i,c,true);need(c.provider==='aws');const p=await prepare(i,c,authority);
      const headers:Record<string,string>={'content-type':'application/json','if-none-match':'*','x-amz-checksum-sha256':p.checksum,'x-amz-expected-bucket-owner':target.accountId,'x-amz-meta-hivemind-mark':p.mark};
      if(target.kmsKeyId){headers['x-amz-server-side-encryption']='aws:kms';headers['x-amz-server-side-encryption-aws-kms-key-id']=target.kmsKeyId;}
      need(now()<i.expiresAt);
      const response=await send('PUT',p.key,headers,p.body,c,authority,i.expiresAt);
      if(response.status===200){const echoed=response.headers.get('x-amz-checksum-sha256');need(echoed===null||echoed===p.checksum);return receipt(i,p.key,'match');}
      if(response.status===412){const found=await head(i,p,c,authority);need(found.status===200);return receipt(i,p.key,verdict(found,p));}
      return fail();
    },
    async inspect(i,c){
      gate(i,c,false);need(c.provider==='aws');const p=await prepare(i,c);
      // Network failure, 404 and denied reads are unresolved. None of them proves the object is absent.
      let found:Response;try{found=await head(i,p,c);}catch{return null;}
      return found.status===200?receipt(i,p.key,verdict(found,p)):null;
    },
  };
}
