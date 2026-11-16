import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

interface CpuSample {usageUsec?:number;throttledUsec?:number;throttledPeriods?:number}
export interface BenchmarkResources extends CpuSample {
  peakMemoryBytes?:number;
  memorySource?:'cgroup-peak'|'cgroup-sampled'|'process-rss-sampled';
  memoryLimitBytes?:number;
}

const read=(path:string)=>readFile(path,'utf8').catch(()=>undefined);
function counter(raw:string|undefined):number|undefined {
  if(raw===undefined||!/^\d+$/.test(raw.trim()))return;
  const value=Number(raw.trim());
  return Number.isSafeInteger(value)?value:undefined;
}

async function controller(name:string,file:string):Promise<string|undefined> {
  const groups=await read('/proc/self/cgroup');
  const path=groups?.split('\n').find(line=>line.split(':')[1]?.split(',').includes(name))?.split(':')[2];
  const root=join('/sys/fs/cgroup',name);
  return path?.startsWith('/')&&!path.split('/').includes('..')?read(join(root,path,file)):undefined;
}
async function cpuSample():Promise<CpuSample> {
  const stats=await read('/sys/fs/cgroup/cpu.stat')??await controller('cpu','cpu.stat');
  const values=new Map(stats?.trim().split('\n').map(line=>line.trim().split(/\s+/,2) as [string,string]));
  const usageNs=counter(await controller('cpuacct','cpuacct.usage'));
  const throttledNs=counter(values.get('throttled_time'));
  return {
    usageUsec:counter(values.get('usage_usec'))??(usageNs===undefined?undefined:Math.round(usageNs/1000)),
    throttledUsec:counter(values.get('throttled_usec'))??(throttledNs===undefined?undefined:Math.round(throttledNs/1000)),
    throttledPeriods:counter(values.get('nr_throttled')),
  };
}
async function memorySample():Promise<{bytes:number;source:'cgroup-sampled'|'process-rss-sampled'}|undefined> {
  const bytes=counter(await read('/sys/fs/cgroup/memory.current')??await controller('memory','memory.usage_in_bytes'));
  if(bytes!==undefined)return {bytes,source:'cgroup-sampled'};
  const pids=(await readdir('/proc').catch(()=>[])).filter(name=>/^\d+$/.test(name));
  const values=await Promise.all(pids.map(async pid=>counter(/^VmRSS:\s*(\d+) kB/m.exec(await read('/proc/'+pid+'/status')??'')?.[1])));
  const rss=values.reduce<number>((sum,value)=>sum+(value??0),0);
  if(rss>0)return {bytes:rss*1024,source:'process-rss-sampled'};
}

export async function measureBenchmarkResources() {
  const cpu=await cpuSample();
  let peak=await memorySample();
  let sample:Promise<void>|undefined;
  const timer=setInterval(()=>{
    if(sample)return;
    sample=memorySample().then(value=>{
      if(value&&(!peak||value.source==='cgroup-sampled'&&peak.source!==value.source||
        value.source===peak.source&&value.bytes>peak.bytes))peak=value;
    }).finally(()=>{sample=undefined;});
  },500);
  timer.unref();
  return async ():Promise<BenchmarkResources>=>{
    clearInterval(timer);
    await sample;
    const end=await cpuSample();
    const exactPeak=counter(await read('/sys/fs/cgroup/memory.peak')??await controller('memory','memory.max_usage_in_bytes'));
    const limit=counter(await read('/sys/fs/cgroup/memory.max')??await controller('memory','memory.limit_in_bytes'));
    const delta=(key:keyof CpuSample)=>{
      const first=cpu[key],last=end[key];
      return first===undefined||last===undefined||last<first?undefined:last-first;
    };
    return {usageUsec:delta('usageUsec'),throttledUsec:delta('throttledUsec'),throttledPeriods:delta('throttledPeriods'),
      peakMemoryBytes:exactPeak??peak?.bytes,memorySource:exactPeak===undefined?peak?.source:'cgroup-peak',memoryLimitBytes:limit};
  };
}
