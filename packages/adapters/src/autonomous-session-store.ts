import type {AutonomousCheckpoint} from '../../contracts/src/autonomous.js';
import type {PrivateSession, PrivateSessionStore} from './autonomous-runner.js';
export const MAX_PRIVATE_BLOB_BYTES = 12 * 1024 * 1024;
export interface PrivateBlobStore {readonly durable: true; get(key: string): Promise<Uint8Array | undefined>; put(key: string, bytes: Uint8Array): Promise<void>}
const rejected = () => new Error('Private session rejected');
export function validatePrivateBlobKey(key: string): void {if (!/^private\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) throw rejected();}
/** Validate before serialization: reject accessors, cycles, custom prototypes and unbounded trees. */
function encode(value: unknown): Uint8Array<ArrayBuffer> {
 const encoder = new TextEncoder(), chunks: string[] = [], seen = new Set<object>();
 let bytes = 0, nodes = 0;
 const append = (chunk: string) => {
  bytes += encoder.encode(chunk).length;
  if (bytes > MAX_PRIVATE_BLOB_BYTES - 29) throw rejected();
  chunks.push(chunk);
 };
 const quoted = (text: string) => {
  if (text.length > MAX_PRIVATE_BLOB_BYTES) throw rejected();
  append(JSON.stringify(text));
 };
 const visit = (item: unknown, depth: number): void => {
  if (++nodes > 100000 || depth > 64) throw rejected();
  if (typeof item === 'string') {quoted(item);return;}
  if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {append(JSON.stringify(item));return;}
  if (typeof item !== 'object' || seen.has(item)) throw rejected();
  const array = Array.isArray(item);
  if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw rejected();
  if (array && item.length > 100000) throw rejected();
  seen.add(item);
  const descriptors = Object.getOwnPropertyDescriptors(item);
  if (Object.getOwnPropertySymbols(item).length) throw rejected();
  const names = Object.keys(descriptors).filter(name => !(array && name === 'length'));
  if (array && (names.length !== item.length || names.some((name,i) => name !== String(i)))) throw rejected();
  append(array ? '[' : '{');
  for (let i=0;i<names.length;i++) {
   const name=names[i]!, property=descriptors[name]!;
   if (!('value' in property) || !property.enumerable || name === 'toJSON') throw rejected();
   if (i) append(',');
   if (!array) {quoted(name);append(':');}
   visit(property.value,depth+1);
  }
  append(array ? ']' : '}');seen.delete(item);
 };
 visit(value,0);return encoder.encode(chunks.join(''));
}
function identity(taskId: string, session: Pick<PrivateSession,'sessionId'|'model'|'sequence'>): void {
 if (typeof taskId !== 'string' || !taskId.length || taskId.length > 512 || typeof session.sessionId !== 'string' || !session.sessionId.length || session.sessionId.length > 512 || typeof session.model !== 'string' || !session.model.length || session.model.length > 256 || !Number.isSafeInteger(session.sequence) || session.sequence < 0) throw rejected();
}
function aad(taskId: string, cp: AutonomousCheckpoint): Uint8Array<ArrayBuffer> {return new TextEncoder().encode(JSON.stringify([1,taskId,cp.sessionId,cp.model,cp.sequence,cp.objectKey]));}
export class EncryptedSessionStore implements PrivateSessionStore {
 readonly durable = true;
 private readonly blobs: PrivateBlobStore;
 private readonly key: Uint8Array<ArrayBuffer>;
 constructor(options: {key: Uint8Array; blobs: PrivateBlobStore}) {
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32 || options.blobs?.durable !== true) throw rejected();
  this.key = new Uint8Array(options.key);this.blobs = options.blobs;
 }
 async save(taskId: string, session: PrivateSession): Promise<AutonomousCheckpoint> {
  try {
   identity(taskId,session);
   const cp = {sessionId:session.sessionId,model:session.model,sequence:session.sequence,objectKey:`private/${crypto.randomUUID()}`};
   const plain = encode({sessionId:session.sessionId,model:session.model,sequence:session.sequence,data:session.data});
   const iv = crypto.getRandomValues(new Uint8Array(12));
   const key = await crypto.subtle.importKey('raw',this.key,{name:'AES-GCM'},false,['encrypt']);
   const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(taskId,cp)},key,plain));
   const bytes = new Uint8Array(13 + encrypted.length);bytes[0] = 1;bytes.set(iv,1);bytes.set(encrypted,13);
   await this.blobs.put(cp.objectKey,bytes);return cp;
  } catch {throw rejected();}
 }
 async load(taskId: string, checkpoint: AutonomousCheckpoint): Promise<PrivateSession | undefined> {
  try {
   identity(taskId,checkpoint);validatePrivateBlobKey(checkpoint.objectKey);
   const stored = await this.blobs.get(checkpoint.objectKey);if (!stored) return undefined;
   if (stored.length < 29 || stored.length > MAX_PRIVATE_BLOB_BYTES || stored[0] !== 1) throw rejected();
   const bytes = new Uint8Array(stored);
   const key = await crypto.subtle.importKey('raw',this.key,{name:'AES-GCM'},false,['decrypt']);
   const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(1,13),additionalData:aad(taskId,checkpoint)},key,bytes.slice(13));
   const session = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)) as PrivateSession;
   identity(taskId,session);
   if (session.sessionId !== checkpoint.sessionId || session.model !== checkpoint.model || session.sequence !== checkpoint.sequence || !Object.hasOwn(session,'data')) throw rejected();
   return session;
  } catch {throw rejected();}
 }
}
