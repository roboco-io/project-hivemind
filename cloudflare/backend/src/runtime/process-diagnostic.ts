import {createHash} from 'node:crypto';
import type {ProcessResult} from '../contracts.ts';

const patterns:[RegExp,string][]=[
 [/\bEACCES\b|permission denied/i,'EACCES: filesystem access denied'],
 [/\bEPERM\b|operation not permitted/i,'EPERM: process or filesystem operation denied'],
 [/\bENOENT\b|no such file or directory/i,'ENOENT: required file or executable missing'],
 [/\bENOSPC\b|no space left on device/i,'ENOSPC: storage space exhausted'],
 [/\bEMFILE\b|too many open files/i,'EMFILE: open-file limit exceeded'],
 [/\bEPIPE\b|broken pipe/i,'EPIPE: output pipe closed'],
 [/heap out of memory|allocation failed|\bENOMEM\b/i,'ENOMEM: memory allocation failed'],
 [/Cannot read properties of (?:undefined|null)/,'TypeError: accessed a property on an absent value'],
 [/is not a function/,'TypeError: attempted to call a non-function value'],
 [/Unexpected token|Unexpected end of JSON|SyntaxError/,'SyntaxError: parsing failed'],
 [/session.*(?:lock|locked)|lock.*session/i,'Session storage lock failed'],
 [/JSON.*(?:serializ|circular)|circular.*JSON/i,'JSON serialization failed'],
 [/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i,'Network request failed'],
 [/invalid_grant|token.*expired|authentication.*failed/i,'Authentication failed'],
 [/certificate.*(?:failed|invalid)|self.signed/i,'TLS certificate validation failed'],
 [/rate.limit|quota|usage limit/i,'Provider usage or rate limit reached'],
 [/Extension error/i,'Pi extension reported an error'],
 [/Command aborted|Execution cancelled/i,'Execution cancelled'],
 [/output.*(?:truncat|capture.*unavailable)/i,'Process output capture failed'],
];
export function sanitizeProcessStderr(stderr:string){
 const messages=new Set<string>();
 let omittedLines=0;
 for(const raw of stderr.split(/\r?\n/)){
  if(!raw.trim()||raw.startsWith('HIVEMIND_PI_'))continue;
  const line=raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const matches=patterns.filter(([pattern])=>pattern.test(line));
  if(matches.length)for(const [,message] of matches)messages.add(message);
  else omittedLines++;
 }
 return {messages:[...messages].slice(0,16),omittedLines,bytes:Buffer.byteLength(stderr),
  sha256:createHash('sha256').update(stderr).digest('hex')};
}
export function processDiagnostic(result:ProcessResult){
 return {status:result.status,exitCode:result.exitCode,signal:result.signal??null,
  terminationReason:result.terminationReason??'unknown',truncated:result.truncated,
  stderr:sanitizeProcessStderr(result.stderr)};
}
