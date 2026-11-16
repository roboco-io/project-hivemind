import {cp,mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const children=new Set();
function stopGroup(pid,signal='SIGKILL') {
 if(pid)try{process.kill(-pid,signal)}catch{}
}
for(const [signal,code] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',129]]) {
 process.once(signal,()=>{for(const pid of children)stopGroup(pid);process.exit(code)});
}
process.once('exit',()=>{for(const pid of children)stopGroup(pid)});
export const fixtureRoot=dirname(fileURLToPath(import.meta.url));
export async function command(argv,cwd,env,timeoutMs=180000){
 const started=performance.now();
 return new Promise((resolve,reject)=>{
  const p=spawn(argv[0],argv.slice(1),{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
  if(p.pid)children.add(p.pid);
  let out='',err='';const limit=65536;
  p.stdout.on('data',c=>{out=(out+c).slice(-limit)});p.stderr.on('data',c=>{err=(err+c).slice(-limit)});
  const timer=setTimeout(()=>stopGroup(p.pid),timeoutMs);
  p.once('error',e=>{clearTimeout(timer);stopGroup(p.pid);children.delete(p.pid);reject(e)});
  p.once('close',(code,signal)=>{clearTimeout(timer);stopGroup(p.pid);children.delete(p.pid);resolve({code,signal,ms:Math.round(performance.now()-started),out,err})});
 });
}
export async function prepare(){
 const root=await mkdtemp(join(tmpdir(),'hivemind-resource-'));
 const app=join(root,'app'),home=join(root,'home');
 await mkdir(home);await cp(join(fixtureRoot,'app'),app,{recursive:true});
 const env={PATH:process.env.PATH,HOME:home,TMPDIR:root,CI:'1',NODE_ENV:'test',
  DATABASE_URL:'file:'+join(root,'database.db'),npm_config_cache:join(root,'npm-cache'),
  SSL_CERT_FILE:process.env.SSL_CERT_FILE,NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,
  npm_config_update_notifier:'false',GIT_SSL_CAINFO:process.env.SSL_CERT_FILE};
 const phases=[];
 try{
  for(const [name,args] of [['install',['npm','ci','--ignore-scripts','--no-audit','--no-fund']],['generate',['npm','run','db:generate']],['build',['npm','run','build','--','--types','node']],['database',['npm','run','db:migrate']]]){
   const result=await command(args,app,env);
   phases.push({name,ms:result.ms,exitCode:result.code});
   if(result.code!==0)throw Error('Fixture phase failed: '+name+' '+result.err.slice(-1000)+result.out.slice(-1000));
  }
  return {root,app,env,phases};
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const value=s.address().port;await new Promise(r=>s.close(r));return value;}
export async function serve(prepared){
 const listenPort=await port();
 const p=spawn(process.execPath,['dist/server.js'],{cwd:prepared.app,env:{...prepared.env,PORT:String(listenPort),BIND_HOST:'127.0.0.1'},detached:true,stdio:'ignore'});
 if(p.pid)children.add(p.pid);
 const stop=async()=>{stopGroup(p.pid,'SIGTERM');await sleep(100);stopGroup(p.pid);children.delete(p.pid)};
 p.on('error',()=>{});
 for(let i=0;i<120;i++){
  const ready=await new Promise(resolve=>{const c=createConnection({host:'127.0.0.1',port:listenPort});c.setTimeout(150);const done=ok=>{c.destroy();resolve(ok)};c.on('connect',()=>done(true));c.on('error',()=>done(false));c.on('timeout',()=>done(false));});
  if(ready)return {url:'http://127.0.0.1:'+listenPort,stop};
  if(p.exitCode!==null)break;await sleep(100);
 }
 await stop();throw Error('Fixture server failed readiness');
}
export async function cleanup(prepared){await rm(prepared.root,{recursive:true,force:true});}
export async function readJson(name){return JSON.parse(await readFile(join(fixtureRoot,name),'utf8'));}
