import {execFile} from 'node:child_process';
import {cpus,totalmem,freemem,platform} from 'node:os';
import {performance} from 'node:perf_hooks';

const command=(file:string,args:string[])=>new Promise<string>((resolve,reject)=>{
 execFile(file,args,{timeout:4000,maxBuffer:2*1024*1024},(error,stdout)=>error?reject(error):resolve(stdout));
});
const cpuTicks=()=>cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
const byteValue=(n:string,unit:string)=>Number(n)*({K:1024,M:1024**2,G:1024**3,T:1024**4}[unit]??1);
export interface HostSample {
 timestamp:string;cpuBusyPercent?:number;freeMemoryBytes:number;totalMemoryBytes:number;
 swapUsedBytes?:number;swapOutPages?:number;memoryFreePercent?:number;
 network?:{interface:string;receivedBytes:number;sentBytes:number};
 controllerRssBytes?:number;workloadRssBytes?:number;workloadCpuPercent?:number;workloadProcesses?:number;
 nodeProbeMs?:number;gitProbeMs?:number;unavailable:string[];
}
interface Process {pid:number;parent:number;cpu:number;rss:number}
function processRows(text:string):Process[]{
 return text.split('\n').flatMap(line=>{
  const match=/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
  return match?[{pid:Number(match[1]),parent:Number(match[2]),cpu:Number(match[3]),rss:Number(match[4])*1024}]:[];
 });
}
function descendants(rows:Process[],roots:number[]){
 const ids=new Set(roots);
 for(let changed=true;changed;){changed=false;for(const row of rows)if(ids.has(row.parent)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
 return rows.filter(row=>ids.has(row.pid));
}
async function probe(file:string,args:string[]){const start=performance.now();await command(file,args);return performance.now()-start;}
export function createHostSampler(workloadRoots:()=>number[],repo:string){
 let prior=cpuTicks();
 return async ():Promise<HostSample>=>{
  const current=cpuTicks(),delta=current.total-prior.total;
  const sample:HostSample={timestamp:new Date().toISOString(),freeMemoryBytes:freemem(),totalMemoryBytes:totalmem(),unavailable:[]};
  if(delta>0)sample.cpuBusyPercent=100*(1-(current.idle-prior.idle)/delta);
  prior=current;
  const operations=[
   ['processes',async()=>{
    const rows=processRows(await command('/bin/ps',['-axo','pid=,ppid=,%cpu=,rss=']));
    sample.controllerRssBytes=rows.find(row=>row.pid===process.pid)?.rss;
    const workers=descendants(rows,workloadRoots());
    sample.workloadRssBytes=workers.reduce((sum,row)=>sum+row.rss,0);
    sample.workloadCpuPercent=workers.reduce((sum,row)=>sum+row.cpu,0);
    sample.workloadProcesses=workers.length;
   }],
   ['nodeProbe',async()=>{sample.nodeProbeMs=await probe(process.execPath,['-e','Math.sqrt(2)']);}],
   ['gitProbe',async()=>{sample.gitProbeMs=await probe('git',['-C',repo,'status','--porcelain','--untracked-files=no']);}],
  ] as const;
  const mac=platform()==='darwin'?[
   ['swap',async()=>{const text=await command('/usr/sbin/sysctl',['-n','vm.swapusage']);const m=/used\s*=\s*([\d.]+)([KMGT])/.exec(text);if(!m)throw Error('Swap parse failed');sample.swapUsedBytes=byteValue(m[1]!,m[2]!);}],
   ['vm',async()=>{const text=await command('/usr/bin/vm_stat',[]);const m=/Swapouts:\s*(\d+)/.exec(text);if(m)sample.swapOutPages=Number(m[1]);else throw Error('VM parse failed');}],
   ['pressure',async()=>{const text=await command('/usr/bin/memory_pressure',['-Q']);const m=/System-wide memory free percentage:\s*(\d+)%/.exec(text);if(!m)throw Error('Pressure parse failed');sample.memoryFreePercent=Number(m[1]);}],
   ['network',async()=>{
    const route=await command('/sbin/route',['-n','get','default']);const iface=/interface:\s*([A-Za-z0-9]+)/.exec(route)?.[1];if(!iface)throw Error('Default interface missing');
    const lines=(await command('/usr/sbin/netstat',['-ibn','-I',iface])).trim().split('\n').map(line=>line.trim().split(/\s+/));
    const head=lines[0]!,row=lines.slice(1).find(parts=>parts[0]===iface&&parts.some(part=>part.startsWith('<Link#')));
    const input=head.indexOf('Ibytes'),output=head.indexOf('Obytes');
    if(!row||input<0||output<0||!/^\d+$/.test(row[input]??'')||!/^\d+$/.test(row[output]??''))throw Error('Network parse failed');
    sample.network={interface:iface,receivedBytes:Number(row[input]),sentBytes:Number(row[output])};
   }],
  ] as const:[];
  await Promise.all([...operations,...mac].map(async([name,run])=>{try{await run();}catch{sample.unavailable.push(name);}}));
  return sample;
 };
}
export function summarizeHost(samples:HostSample[]){
 const percentile=(values:number[],p:number)=>{if(!values.length)return null;const sorted=values.slice().sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]!;};
 const numbers=(key:keyof HostSample)=>samples.map(s=>s[key]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
 const peak=(key:keyof HostSample)=>{const values=numbers(key);return values.length?Math.max(...values):null;};
 const first=samples[0],last=samples.at(-1);
 const sameNetwork=first?.network&&last?.network&&samples.every(s=>s.network?.interface===first.network?.interface);
 return {samples:samples.length,nodeProbe:{p50Ms:percentile(numbers('nodeProbeMs'),.5),p95Ms:percentile(numbers('nodeProbeMs'),.95)},
  gitProbe:{p50Ms:percentile(numbers('gitProbeMs'),.5),p95Ms:percentile(numbers('gitProbeMs'),.95)},
  cpuBusyPercentP95:percentile(numbers('cpuBusyPercent'),.95),controllerRssPeakBytes:peak('controllerRssBytes'),workloadRssSampledPeakBytes:peak('workloadRssBytes'),
  workloadCpuPercentSampledPeak:peak('workloadCpuPercent'),swapUsedPeakBytes:peak('swapUsedBytes'),
  swapUsedDeltaBytes:first?.swapUsedBytes!==undefined&&last?.swapUsedBytes!==undefined?last.swapUsedBytes-first.swapUsedBytes:null,
  memoryFreePercentMin:numbers('memoryFreePercent').length?Math.min(...numbers('memoryFreePercent')):null,
  network:sameNetwork?{interface:first.network!.interface,receivedBytes:last!.network!.receivedBytes-first.network!.receivedBytes,sentBytes:last!.network!.sentBytes-first.network!.sentBytes}:null,
  limitations:['Process-tree RSS is sampled and can double-count shared pages.','Network bytes cover the default host interface, including unrelated activity.','CPU percent is sampled; it does not replace exact process CPU-time accounting.','memory_pressure -Q reports available-memory percentage, not the OS warning/critical pressure state.'],
  unavailable:[...new Set(samples.flatMap(s=>s.unavailable))]};
}
