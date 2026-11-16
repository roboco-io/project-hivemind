import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {mkdir,readFile,rename,chmod,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export interface Credential {access:string;refresh:string;expires:number;accountId:string}
export interface Store {get():Promise<string|null>;set(value:string):Promise<void>;delete():Promise<void>}
interface OAuth {
 refresh(credential:Credential,signal:AbortSignal):Promise<Credential>;
 login(interaction:unknown):Promise<Credential>;
}
export function validateCredential(value:unknown):Credential {
 const x=value as Credential;
 if(!x||typeof x.access!=='string'||typeof x.refresh!=='string'||typeof x.accountId!=='string'||
   !x.access||!x.refresh||!x.accountId||!Number.isSafeInteger(x.expires)||x.expires<=0)
  throw Error('Invalid Pi OAuth credential');
 return {access:x.access,refresh:x.refresh,expires:x.expires,accountId:x.accountId};
}
export async function resolveCredential(store:Store,oauth:OAuth,minimumValidityMs=1500000):Promise<Credential> {
 const raw=await store.get();
 if(!raw)throw Error('HIVEMIND_PI_LOGIN_REQUIRED');
 const saved=JSON.parse(raw);
 if(saved.state!=='ready')throw Error('HIVEMIND_PI_LOGIN_REQUIRED');
 let credential=validateCredential(saved.credential);
 if(credential.expires-Date.now()>=minimumValidityMs)return credential;
 // A process crash after token rotation requires login instead of replaying a retired token.
 await store.set(JSON.stringify({state:'refreshing'}));
 try{
  credential=validateCredential(await oauth.refresh(credential,AbortSignal.timeout(30000)));
  await store.set(JSON.stringify({state:'ready',credential}));
 }catch{throw Error('HIVEMIND_PI_LOGIN_REQUIRED');}
 if(credential.expires-Date.now()<minimumValidityMs)throw Error('HIVEMIND_PI_TOKEN_VALIDITY_TOO_SHORT');
 return credential;
}
async function helperPath() {
 if(process.platform!=='darwin')throw Error('macOS Keychain is required');
 const root=join(homedir(),'Library/Application Support/HIVEMIND');
 await mkdir(root,{recursive:true,mode:0o700});
 const source=fileURLToPath(new URL('./keychain.swift',import.meta.url));
 const hash=createHash('sha256').update(await readFile(source)).digest('hex');
 const binary=join(root,'pi-keychain');
 if(await readFile(binary+'.sha256','utf8').catch(()=>'')!==hash){
  const temp=binary+'.'+process.pid;
  execFileSync('/usr/bin/swiftc',[source,'-o',temp],{stdio:['ignore','pipe','pipe']});
  await chmod(temp,0o700);await rename(temp,binary);
  await writeFile(binary+'.sha256',hash,{mode:0o600});
 }
 return binary;
}
export async function withKeychain<T>(fn:(store:Store)=>Promise<T>):Promise<T>{
 const helper=spawn(await helperPath(),[],{stdio:['pipe','pipe','pipe']});
 helper.stderr.resume();
 helper.on('error',()=>helper.stdout.destroy());
 const lines=createInterface({input:helper.stdout})[Symbol.asyncIterator]();
 const timeout=setTimeout(()=>helper.kill(),600000);
 const receive=async()=>{
  const line=await lines.next();
  if(line.done)throw Error('Keychain helper unavailable or access denied');
  const value=JSON.parse(line.value);
  if(value.error)throw Error(String(value.error));
  return value;
 };
 try{
  if(!(await receive()).ready)throw Error('Keychain lock unavailable');
  const send=async(command:string,value?:string)=>{
   helper.stdin.write(JSON.stringify({command,value})+'\n');return receive();
  };
  return await fn({get:async()=> (await send('get')).value,
   set:async value=>{await send('set',value);},delete:async()=>{await send('delete');}});
 }finally{clearTimeout(timeout);helper.stdin.end();helper.kill();await lines.return?.();}
}
async function provider():Promise<OAuth>{
 const packageRoot=process.env.HIVEMIND_PI_PACKAGE_ROOT??join(dirname(process.execPath),'../lib/node_modules/@earendil-works/pi-coding-agent');
 const file=join(resolve(packageRoot),'node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js');
 return (await import(pathToFileURL(file).href)).openaiCodexOAuth;
}
export async function getPiAccess(minimumValidityMs=1500000){
 return withKeychain(async store=>{
  const {access,accountId,expires}=await resolveCredential(store,await provider(),minimumValidityMs);
  return {access,accountId,expires};
 });
}
async function main(){
 const [command,destination]=process.argv.slice(2);
 if(command==='status'){
  await withKeychain(async store=>{
   const raw=await store.get(),v=raw?JSON.parse(raw):null;
   console.log({stored:!!v,ready:v?.state==='ready',accessValid:v?.state==='ready'&&v.credential.expires>Date.now()});
  });
 }else if(command==='forget'){
  await withKeychain(store=>store.delete());console.log('HIVEMIND Pi authentication removed');
 }else if(command==='login'){
  const port=createServer();
  await new Promise<void>((resolve,reject)=>{
   port.once('error',()=>reject(Error('Keychain login callback port 1455 is occupied')));
   port.listen(1455,'127.0.0.1',()=>port.close(()=>resolve()));
  });
  await withKeychain(async store=>{
   const oauth=await provider();
   const abort=new AbortController();
   const timer=setTimeout(()=>abort.abort(),240000);
   try{
    const credential=validateCredential(await oauth.login({
     signal:abort.signal,
     prompt:async(p:{type:string;signal?:AbortSignal})=>{
      if(p.type==='select')return 'browser';
      return new Promise((_,reject)=>{
       const signal=p.signal??abort.signal;
       if(signal.aborted)reject(Error('Login cancelled'));
       else signal.addEventListener('abort',()=>reject(Error('Login cancelled')),{once:true});
      });
     },
     notify:(event:{type:string;url?:string})=>{
      if(event.type==='auth_url'&&event.url){
       execFileSync('/usr/bin/open',[event.url],{stdio:'ignore'});
       console.log('Opened HIVEMIND Pi login');
      }
     },
    }));
    await store.set(JSON.stringify({state:'ready',credential}));
    console.log('HIVEMIND Pi authentication saved in Keychain');
   }finally{clearTimeout(timer);}
  });
 }else if(command==='export'&&destination){
  const auth=await getPiAccess();
  await mkdir(dirname(resolve(destination)),{recursive:true,mode:0o700});
  await writeFile(destination,JSON.stringify(auth),{mode:0o600,flag:'wx'});
  console.log('Temporary Pi access file created');
 }else throw Error('Use pi-oauth.ts status|login|forget|export PATH');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(error=>{
  const message=error instanceof Error?error.message:'';
  console.error(/^(HIVEMIND_PI_|Keychain |macOS |Set HIVEMIND_|Use pi-oauth)/.test(message)?message:'Pi authentication operation failed');
  process.exitCode=1;
 });
}
