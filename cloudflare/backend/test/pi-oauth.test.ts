import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCredential} from '../scripts/auth/pi-oauth.ts';

const initial={access:'access',refresh:'refresh',accountId:'account',expires:Date.now()+3600000};
function fixture(value:unknown){
 let stored=JSON.stringify(value);
 const writes:string[]=[];
 return {store:{get:async()=>stored,set:async(v:string)=>{writes.push(v);stored=v;},delete:async()=>{stored='null';}},writes};
}
test('valid Pi authentication is reused without a refresh',async()=>{
 const {store,writes}=fixture({state:'ready',credential:initial});
 let called=false;
 const got=await resolveCredential(store,{login:async()=>initial,refresh:async()=>{called=true;return initial;}});
 assert.equal(got.access,initial.access);assert.equal(called,false);assert.equal(writes.length,0);
});
test('refresh rotates and persists credentials before returning access',async()=>{
 const {store,writes}=fixture({state:'ready',credential:{...initial,expires:1}});
 const next={...initial,access:'new-access',refresh:'new-refresh'};
 const got=await resolveCredential(store,{login:async()=>initial,refresh:async(old)=>{
  assert.equal(JSON.parse((await store.get())!).state,'refreshing');
  assert.equal(old.refresh,initial.refresh);return next;
 }});
 assert.deepEqual(got,next);
 assert.equal(JSON.parse(writes[1]!).credential.refresh,'new-refresh');
});
test('interrupted or rejected refresh requires login and never retries the retired token',async()=>{
 const {store}=fixture({state:'ready',credential:{...initial,expires:1}});
 let calls=0;
 const oauth={login:async()=>initial,refresh:async()=>{calls++;throw Error('private detail');}};
 await assert.rejects(resolveCredential(store,oauth),/HIVEMIND_PI_LOGIN_REQUIRED/);
 await assert.rejects(resolveCredential(store,oauth),/HIVEMIND_PI_LOGIN_REQUIRED/);
 assert.equal(calls,1);
});
