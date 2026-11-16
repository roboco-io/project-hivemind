/** Compute has no model credentials; the outer backend still controls destinations. */
export function computeSandboxArgs(options?:{readOnly:string[];deny:string[]}):string[] {
 let fs='';
 if(options){
  const entries=[...options.deny.map(path=>[path,'deny']),...options.readOnly.map(path=>[path,'read'])];
  if(entries.some(([path])=>!path||!path.startsWith('/')||path.includes('\0')||path.split('/').includes('..'))||new Set(entries.map(([path])=>path)).size!==entries.length)throw Error('Invalid compute filesystem boundary');
  fs=',filesystem={'+entries.map(([path,access])=>JSON.stringify(path)+'='+JSON.stringify(access)).join(',')+'}';
 }
 return ['codex','sandbox','-c','permissions.checks={extends=":workspace",network={enabled=true}'+fs+'}','-P','checks','--'];
}
