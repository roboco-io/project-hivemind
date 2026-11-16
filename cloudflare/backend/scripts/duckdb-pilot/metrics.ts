export function parseVm(text:string){
 const page=/page size of (\d+) bytes/.exec(text),swap=/Swapouts:\s*(\d+)/.exec(text),compressed=/Pages occupied by compressor:\s*(\d+)/.exec(text);
 if(!page||!swap||!compressed)throw Error('VM counters unavailable');
 const pageSize=Number(page[1]);return {pageSize,swapOutBytes:Number(swap[1])*pageSize,compressedBytes:Number(compressed[1])*pageSize};
}
export interface GuardSample {at:number;pressure?:'normal'|'warning'|'critical'|'unknown';nodeMs?:number;diskFree?:number;swapOutBytes?:number}
export class Guard {
 private criticalSince?:number;private slowSince?:number;private swap?:{at:number;value:number};private highSwapIntervals=0;
 observe(s:GuardSample):string|null{
  if(s.diskFree!==undefined&&s.diskFree<3*1024**3)return 'disk-space';
  if(s.pressure==='critical')this.criticalSince??=s.at;else if(s.pressure==='normal'||s.pressure==='warning')this.criticalSince=undefined;
  if(s.nodeMs!==undefined){if(s.nodeMs>1000)this.slowSince??=s.at;else this.slowSince=undefined;}
  if(this.criticalSince!==undefined&&s.at-this.criticalSince>=15000)return 'critical-memory-pressure';
  if(this.slowSince!==undefined&&s.at-this.slowSince>=30000)return 'response-time';
  if(s.swapOutBytes!==undefined){
   if(!this.swap)this.swap={at:s.at,value:s.swapOutBytes};
   else if(s.at-this.swap.at>=60000){
    const perMinute=(s.swapOutBytes-this.swap.value)*60000/(s.at-this.swap.at);
    this.highSwapIntervals=perMinute>=1024**3?this.highSwapIntervals+1:0;this.swap={at:s.at,value:s.swapOutBytes};
    if(this.highSwapIntervals>=2)return 'swap-out-rate';
   }
  }
  return null;
 }
}
export function profile(name:string){
 const p:Record<string,{disableUnity:boolean;forceAssert:boolean}>={C1:{disableUnity:false,forceAssert:false},C2:{disableUnity:false,forceAssert:true},C3:{disableUnity:true,forceAssert:false},C4:{disableUnity:true,forceAssert:true}};
 if(!Object.hasOwn(p,name))throw Error('Unknown build profile');return p[name]!;
}
// 3 GiB is a P0 local tuning option; the planned main comparison remains 6/9 GiB.
export function validateMemoryOptions(sf:number,memoryGiB:number,threads:number){
 if(![1,3,10,30].includes(sf)||![3,6,9].includes(memoryGiB)||!Number.isSafeInteger(threads)||threads<1||threads>10)throw Error('Unsupported memory pilot settings');
 return {sf,memoryGiB,threads};
}
