import {isAbsolute,join,basename} from 'node:path';
import {lstat,realpath,readFile,stat} from 'node:fs/promises';
import {platform} from 'node:os';
import {createHash} from 'node:crypto';
export interface MacSdk {selection:'explicit';path:string;version:string;canonicalName:string;settingsSha256:string}
export async function selectMacSdk(value:string|undefined,host=platform()):Promise<MacSdk|undefined>{
 if(value===undefined)return undefined;
 if(host!=='darwin'||!isAbsolute(value)||!value.endsWith('.sdk')||/[\r\n\0]/.test(value))throw Error('Invalid macOS SDK selection');
 const path=await realpath(value);if(!(await stat(path)).isDirectory()||!path.endsWith('.sdk'))throw Error('Invalid SDK directory');
 const settings=join(path,'SDKSettings.json'),info=await lstat(settings);if(!info.isFile()||info.size>1024*1024)throw Error('Invalid SDK metadata file');
 const bytes=await readFile(settings);let metadata:any;try{metadata=JSON.parse(bytes.toString('utf8'));}catch{throw Error('Invalid SDK metadata');}
 const version=metadata?.Version,canonicalName=metadata?.CanonicalName;
 if(typeof version!=='string'||!/^\d+\.\d+(?:\.\d+)?$/.test(version)||canonicalName!=='macosx'+version)throw Error('SDK is not a versioned macOS SDK');
 const named=/^MacOSX(\d+\.\d+(?:\.\d+)?)\.sdk$/.exec(basename(value));if(named&&named[1]!==version)throw Error('SDK name and version differ');
 return {selection:'explicit',path,version,canonicalName,settingsSha256:createHash('sha256').update(bytes).digest('hex')};
}
