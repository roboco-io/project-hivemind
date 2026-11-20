import {MAX_PRIVATE_BLOB_BYTES, validatePrivateBlobKey} from '../../../packages/adapters/src/autonomous-session-store.ts';
import type {PrivateBlobStore} from '../../../packages/adapters/src/autonomous-session-store.ts';
/** Pass the CREDENTIALS/private bucket explicitly. This port has no ARTIFACTS or URL access. */
export interface PrivateR2Bucket {
 get(key: string): Promise<{size: number; arrayBuffer(): Promise<ArrayBuffer>} | null>;
 put(key: string, value: Uint8Array<ArrayBuffer>, options: {onlyIf: {etagDoesNotMatch: string}}): Promise<unknown | null>;
}
const rejected=()=>new Error('Private session rejected');
export class R2PrivateBlobStore implements PrivateBlobStore {
 readonly durable=true;
 private readonly bucket: PrivateR2Bucket;
 constructor(options: {bucket: PrivateR2Bucket}) {if(!options.bucket)throw rejected();this.bucket=options.bucket;}
 async get(key: string): Promise<Uint8Array | undefined> {
  try {
   validatePrivateBlobKey(key);const object=await this.bucket.get(`autonomous-sessions/${key}`);if(!object)return undefined;
   if(!Number.isSafeInteger(object.size)||object.size<0||object.size>MAX_PRIVATE_BLOB_BYTES)throw rejected();
   const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==object.size||bytes.length>MAX_PRIVATE_BLOB_BYTES)throw rejected();return bytes;
  }catch{throw rejected();}
 }
 async put(key: string,bytes: Uint8Array): Promise<void> {
  try {
   validatePrivateBlobKey(key);if(!(bytes instanceof Uint8Array)||bytes.length>MAX_PRIVATE_BLOB_BYTES)throw rejected();
   const saved=await this.bucket.put(`autonomous-sessions/${key}`,new Uint8Array(bytes),{onlyIf:{etagDoesNotMatch:'*'}});
   if(!saved)throw rejected();
  }catch{throw rejected();}
 }
}
