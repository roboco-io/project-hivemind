export interface DailySchedule {kind:'daily';timeZone:string;localTime:string}
const HOUR=3600000,DAY=24*HOUR,MAX_TIME=253370764799999;
function utc(year:number,month:number,day:number,hour=0,minute=0,second=0):number {
 const d=new Date(0);d.setUTCFullYear(year,month-1,day);d.setUTCHours(hour,minute,second,0);return d.getTime();
}
function dateKey(ms:number):string {return new Date(ms).toISOString().slice(0,10);}
/** Fixed work bound: eight local dates, 97 offset samples per date; no clock or I/O. */
export function nextDailyOccurrence(schedule:DailySchedule,afterMs:number,lastKey?:string):{wakeAt:number;key:string} {
 if(!schedule||typeof schedule!=='object'||Array.isArray(schedule)||Reflect.ownKeys(schedule).length!==3||!['kind','timeZone','localTime'].every(k=>Object.hasOwn(schedule,k))||schedule.kind!=='daily'||typeof schedule.localTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)||typeof schedule.timeZone!=='string'||schedule.timeZone.length>128||! /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(schedule.timeZone))throw new RangeError('Invalid daily schedule');
 if(!Number.isSafeInteger(afterMs)||afterMs<0||afterMs>MAX_TIME)throw new RangeError('Invalid schedule timestamp');
 if(lastKey!==undefined){
  if(typeof lastKey!=='string'||!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(lastKey))throw new RangeError('Invalid occurrence key');
  const [y,m,d]=lastKey.split('-').map(Number);
  if(dateKey(utc(y!,m!,d!))!==lastKey)throw new RangeError('Invalid occurrence key');
 }
 const formatter=new Intl.DateTimeFormat('en-US',{timeZone:schedule.timeZone,calendar:'gregory',numberingSystem:'latn',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 const parts=(ms:number)=>{
  const p=Object.fromEntries(formatter.formatToParts(ms).map(x=>[x.type,x.value]));
  return utc(Number(p.year),Number(p.month),Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
 };
 const local=parts(afterMs),[hour,minute]=schedule.localTime.split(':').map(Number);
 let day=Math.floor(local/DAY)*DAY;
 if(lastKey!==undefined&&dateKey(day)<=lastKey){const [y,m,d]=lastKey.split('-').map(Number);day=utc(y!,m!,d!)+DAY;}
 for(let index=0;index<8;index++,day+=DAY){
  if(day<utc(1,1,1)||day>=utc(10000,1,1))break;
  const target=day+hour!*HOUR+minute!*60000,offsets=new Set<number>();
  for(let h=-48;h<=48;h++){const sample=target+h*HOUR;offsets.add(parts(sample)-sample);}
  let earliest=Infinity;
  for(const offset of offsets){const candidate=target-offset;if(parts(candidate)===target)earliest=Math.min(earliest,candidate);}
  if(earliest>=afterMs&&earliest<=MAX_TIME)return {wakeAt:earliest,key:dateKey(day)};
 }
 throw new RangeError('No daily occurrence within supported range');
}
