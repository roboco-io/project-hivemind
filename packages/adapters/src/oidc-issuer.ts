import type {OidcGrant,OidcPublicJwk,OidcSignerPort} from '../../contracts/src/oidc.js';
import {oidcSubject,validateOidcIssuer} from '../../core/src/oidc.js';
export interface OidcIssuerConfig {issuer:string;audience:string;activeKid:string;privateJwk:JsonWebKey;publicKeys:(JsonWebKey&{kid:string})[];now?:()=>number}
export interface OidcIssuer extends OidcSignerPort {fetch(request:Request):Promise<Response>}
function deny():never {throw new Error('OIDC signer denied');}
const base64url=(bytes:Uint8Array):string=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const encode=(v:unknown)=>base64url(new TextEncoder().encode(JSON.stringify(v)));
function publicKey(j:JsonWebKey&{kid:string}):OidcPublicJwk {if(j.kty!=='RSA'||!j.n||!j.e||!/^[A-Za-z0-9_-]{1,128}$/.test(j.kid)||!/^[-_A-Za-z0-9]+$/.test(j.n)||!/^[-_A-Za-z0-9]+$/.test(j.e)||(j.alg!==undefined&&j.alg!=='RS256')||(j.use!==undefined&&j.use!=='sig'))deny();return {kty:'RSA',n:j.n,e:j.e,kid:j.kid,alg:'RS256',use:'sig'};}
export async function createOidcIssuer(config:OidcIssuerConfig):Promise<OidcIssuer> {
 const c=structuredClone({...config,now:undefined});const now=config.now??Date.now;validateOidcIssuer(c.issuer);if(typeof c.audience!=='string'||!c.audience.length||c.audience.length>255||/[\x00-\x20\x7f]/.test(c.audience)||!Array.isArray(c.publicKeys)||!c.publicKeys.length||c.publicKeys.length>100)deny();
 const keys=c.publicKeys.map(publicKey);if(new Set(keys.map(k=>k.kid)).size!==keys.length)deny();
 for(const j of keys){const key=await crypto.subtle.importKey('jwk',j,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);if((key.algorithm as RsaKeyAlgorithm).modulusLength<2048)deny();}
 const active=keys.find(k=>k.kid===c.activeKid);const privatePublic=publicKey({...c.privateJwk,kid:c.activeKid});if(!active||active.n!==privatePublic.n||active.e!==privatePublic.e||!c.privateJwk.d)deny();
 const privateKey=await crypto.subtle.importKey('jwk',c.privateJwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);if((privateKey.algorithm as RsaKeyAlgorithm).modulusLength<2048)deny();
 const headers={'content-type':'application/json','cache-control':'public, max-age=60'};
 return {
  async sign(input:Readonly<OidcGrant>){const g=structuredClone(input),time=now();const seconds=Math.floor(time/1000);if(!Number.isSafeInteger(time)||g.issuer!==c.issuer||g.audience!==c.audience||g.subject!==oidcSubject(g.taskId,g.revision,g.profileHash,g.purpose)||g.subject.length>255||!Number.isSafeInteger(g.issuedAt)||!Number.isSafeInteger(g.expiresAt)||g.issuedAt>seconds||seconds-g.issuedAt>5||g.expiresAt<=seconds||g.expiresAt-g.issuedAt>300)deny();const h=encode({alg:'RS256',typ:'JWT',kid:c.activeKid});const p=encode({iss:c.issuer,aud:c.audience,sub:g.subject,iat:g.issuedAt,nbf:g.issuedAt,exp:g.expiresAt});const message=h+'.'+p;const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,new TextEncoder().encode(message));return {token:message+'.'+base64url(new Uint8Array(signature)),kid:c.activeKid};},
  async fetch(request:Request){if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers:{allow:'GET'}});if(request.url===c.issuer+'/.well-known/openid-configuration')return Response.json({issuer:c.issuer,jwks_uri:c.issuer+'/jwks.json',response_types_supported:['id_token'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],claims_supported:['iss','aud','sub','iat','nbf','exp']},{headers});if(request.url===c.issuer+'/jwks.json')return Response.json({keys},{headers});return new Response('Not found',{status:404});}
 };
}
export function createOidcSignerPort(binding:OidcSignerPort):OidcSignerPort {return {sign:(grant:Readonly<OidcGrant>)=>binding.sign(grant)};}
