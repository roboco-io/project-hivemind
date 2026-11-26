/** Large artifact manifest types. Type-only: no runtime values, so container runtime code may mirror it. */
export interface ExternalLargeFile {path:string;size:number;sha256:string;storageRef:string}
export interface ExternalLargeManifest {version:1;taskId:string;revision:number;profileId:string;files:ExternalLargeFile[]}
export interface ExternalLargeLimits {maxFileBytes:number;maxTotalBytes:number;maxFiles:number}
