/** Server configuration only. No endpoint discovery or region fallback. */
export function assertAwsRegion(region:string,allowedRegions:readonly string[]=['ap-northeast-2']):void {
 const valid=(v:unknown)=>typeof v==='string'&&/^[a-z]{2}-[a-z]+-\d+$/.test(v)&&v.length<=32;
 if(!Array.isArray(allowedRegions)||!allowedRegions.length||allowedRegions.length>32||new Set(allowedRegions).size!==allowedRegions.length||!allowedRegions.every(valid)||!valid(region)||!allowedRegions.includes(region))throw Error('AWS region unavailable');
}
function zoneId(region:string,id:string):void {
 // These physical-zone prefixes are explicit, never inferred from zone names.
 const prefixes:Record<string,string>={'ap-northeast-2':'apne2','us-east-2':'use2'};
 if(!prefixes[region]||typeof id!=='string'||!new RegExp(`^${prefixes[region]}-az[1-9][0-9]*$`).test(id))throw Error('AWS placement unavailable');
}
export function awsPlacement(region:string,availabilityZoneId?:string):Record<string,string>{
 assertAwsRegion(region,[region]);if(availabilityZoneId===undefined)return {};
 zoneId(region,availabilityZoneId);return {AvailabilityZoneId:availabilityZoneId};
}
export function assertAwsPlacement(region:string,placement:{availabilityZone?:string;availabilityZoneId?:string},expectedZoneId?:string):void {
 assertAwsRegion(region,[region]);
 if(typeof placement?.availabilityZone!=='string'||!new RegExp(`^${region}[a-z]$`).test(placement.availabilityZone))throw Error('AWS placement unavailable');
 if(expectedZoneId!==undefined){zoneId(region,expectedZoneId);if(placement.availabilityZoneId!==expectedZoneId)throw Error('AWS placement unavailable');}
 if(placement.availabilityZoneId!==undefined)zoneId(region,placement.availabilityZoneId);
}
