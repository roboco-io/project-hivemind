import {WorkerEntrypoint} from 'cloudflare:workers';
import {createOidcIssuer,type OidcIssuer} from '../../../packages/adapters/src/oidc-issuer.ts';
import type {OidcGrant} from '../../../packages/contracts/src/oidc.ts';
export interface Env {OIDC_ISSUER:string;OIDC_AUDIENCE:string;OIDC_ACTIVE_KID:string;OIDC_PRIVATE_JWK:string;OIDC_PUBLIC_JWKS:string}
/** RPC is reachable only through an explicitly configured private service binding. */
export class OidcSigner extends WorkerEntrypoint<Env> {
 private issuerPromise?:Promise<OidcIssuer>;
 private issuer():Promise<OidcIssuer> {return this.issuerPromise??=createOidcIssuer({issuer:this.env.OIDC_ISSUER,audience:this.env.OIDC_AUDIENCE,activeKid:this.env.OIDC_ACTIVE_KID,privateJwk:JSON.parse(this.env.OIDC_PRIVATE_JWK),publicKeys:JSON.parse(this.env.OIDC_PUBLIC_JWKS).keys});}
 async sign(grant:Readonly<OidcGrant>):Promise<{token:string;kid:string}> {try{return await (await this.issuer()).sign(grant);}catch{throw new Error('OIDC signing denied');}}
 async fetch(request:Request):Promise<Response> {try{return await (await this.issuer()).fetch(request);}catch{return new Response('Issuer unavailable',{status:503,headers:{'cache-control':'no-store'}});}}
}
export default OidcSigner;
