import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,extname} from 'node:path';
export interface RuntimeBuildManifest {version:1;digest:string;files:Record<string,string>}
export const RUNTIME_FIXED_INPUTS=[
 '.dockerignore','backend/Dockerfile','backend/config/claude-managed-settings.json','backend/package.json','backend/package-lock.json','backend/scripts/runtime-build.ts','scripts/phase0/Dockerfile','scripts/phase0/auth-envelope.ts','scripts/phase0/claude-agent-hook.ts','scripts/phase0/claude-receipts.ts','scripts/phase0/native-thread-receipts.ts','scripts/phase0/rollout-receipts.ts','scripts/phase0/mcp-server.ts','docs/bubblewrap-compatibility.md',
] as const;
export const defaultRoot=fileURLToPath(new URL('../../',import.meta.url));
const manifestPath='backend/runtime-build.json',maxFileBytes=2*1024*1024,maxTotalBytes=32*1024*1024;
const trees=[{path:'backend/src',extensions:new Set(['.ts'])},{path:'backend/native',extensions:new Set(['.c','.patch','.sh','.md'])}];
const excludedDirectories=new Set(['node_modules','work','scratch','tmp','dist','coverage']);
const invalid=()=>new Error('Invalid runtime build input');
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function checkedPath(root:string,path:string,directory=false){
 let absolute=root;const parts=path.split('/');let info;
 for(let i=0;i<parts.length;i++){if(!parts[i]||parts[i]==='.'||parts[i]==='..')throw invalid();absolute=join(absolute,parts[i]!);info=await lstat(absolute);if(info.isSymbolicLink()||(i<parts.length-1&&!info.isDirectory()))throw invalid();}
 if(!info||(directory?!info.isDirectory():!info.isFile()))throw invalid();return info;
}
export async function buildRuntimeManifest(root=defaultRoot):Promise<RuntimeBuildManifest>{
 const paths=new Set<string>(RUNTIME_FIXED_INPUTS);let visited=0;
 async function walk(path:string,extensions:Set<string>,depth=0){
  if(depth>8)throw invalid();await checkedPath(root,path,true);
  for(const entry of await readdir(join(root,path),{withFileTypes:true})){
   if(++visited>2048)throw invalid();if(entry.name.startsWith('.')||excludedDirectories.has(entry.name))continue;
   if(entry.isSymbolicLink())throw invalid();const child=path+'/'+entry.name;
   if(entry.isDirectory())await walk(child,extensions,depth+1);else if(entry.isFile()&&extensions.has(extname(entry.name)))paths.add(child);
  }
 }
 for(const tree of trees)await walk(tree.path,tree.extensions);
 if(paths.size>512)throw invalid();const files:Record<string,string>={};let total=0;
 for(const path of [...paths].sort()){
  if(path===manifestPath||path.length>512)throw invalid();const info=await checkedPath(root,path);if(info.size>maxFileBytes)throw invalid();const bytes=await readFile(join(root,path));total+=bytes.length;if(bytes.length>maxFileBytes||total>maxTotalBytes)throw invalid();files[path]=hash(bytes);
 }
 return {version:1,digest:hash(JSON.stringify({version:1,files})),files};
}
export async function writeRuntimeManifest(root=defaultRoot):Promise<RuntimeBuildManifest>{
 const value=await buildRuntimeManifest(root);await checkedPath(root,'backend',true);
 const file=await open(join(root,manifestPath),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o644);
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');}finally{await file.close();}return value;
}
export async function checkRuntimeManifest(root=defaultRoot):Promise<boolean>{
 const expected=await buildRuntimeManifest(root);try{const info=await checkedPath(root,manifestPath);if(info.size>maxFileBytes)return false;const stored=JSON.parse(await readFile(join(root,manifestPath),'utf8'));return JSON.stringify(stored)===JSON.stringify(expected);}catch{return false;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  const mode=process.argv[2];if(process.argv.length!==3||(mode!=='--write'&&mode!=='--check'))throw new Error('Invalid mode');
  if(mode==='--write'){const manifest=await writeRuntimeManifest();process.stdout.write(`runtime-build: ${manifest.digest}\n`);}
  else if(!await checkRuntimeManifest()){process.stderr.write('Runtime build manifest is missing or stale; run npm run runtime:stamp\n');process.exitCode=1;}
  else process.stdout.write('runtime-build: current\n');
 }catch{process.stderr.write('Runtime build inputs or command are invalid\n');process.exitCode=1;}
}
