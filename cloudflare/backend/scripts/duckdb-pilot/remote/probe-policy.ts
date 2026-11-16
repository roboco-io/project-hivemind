export type ProbeOperation='mutation'|'private-read';
const knownCodes=new Set(['EACCES','EPERM','EROFS','ENOENT','ENOSPC','ENOMEM','EIO','EMFILE','ENFILE','ETIMEDOUT','ENOTDIR','EISDIR']);
export function classifyBoundaryError(operation:ProbeOperation,rawCode:unknown){
 const code=typeof rawCode==='string'&&knownCodes.has(rawCode)?rawCode:'UNCLASSIFIED';
 if(code==='EACCES'||code==='EPERM'||operation==='mutation'&&code==='EROFS')return {blocked:true,code,classification:'permission-denied' as const};
 if(operation==='private-read'&&code==='ENOENT')return {blocked:true,code,classification:'namespace-hidden' as const};
 return {blocked:false,code,classification:'unexpected-error' as const};
}
export function validBoundaryCheck(value:unknown):boolean {
 const v=value as Record<string,unknown>;
 if(!v||typeof v!=='object'||v.blocked!==true||typeof v.name!=='string')return false;
 const mutations=['source-write','source-delete','data-write','data-delete'],reads=['runtime-input-read','proc-root-runtime-input-read'];
 const operation:ProbeOperation|undefined=mutations.includes(v.name)?'mutation':reads.includes(v.name)?'private-read':undefined;
 if(!operation)return false;
 const expected=classifyBoundaryError(operation,v.code);
 return expected.blocked&&v.classification===expected.classification;
}
export function validDataPostcondition(value:unknown,ref:{sha256:string;sizeBytes:number}):boolean {
 const v=value as Record<string,unknown>;
 return !!v&&typeof v==='object'&&v.sha256===ref.sha256&&v.afterSha256===ref.sha256&&v.bytes===ref.sizeBytes&&v.afterBytes===ref.sizeBytes&&v.unchanged===true;
}
