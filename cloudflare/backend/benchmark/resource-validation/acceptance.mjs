import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {prepare,cleanup} from './fixture-runtime.mjs';
const target=process.argv[2];
if(!['articles','comments','all'].includes(target))throw Error('Expected articles, comments or all');
const prepared=await prepare();
const checks=[];
let app,prisma;
async function check(name,fn){try{await fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,message:error instanceof assert.AssertionError?'Assertion failed':String(error.message).slice(0,200)});}}
try{
 Object.assign(process.env,{DATABASE_URL:prepared.env.DATABASE_URL,NODE_ENV:'test'});
 ({prisma}=await import(pathToFileURL(join(prepared.app,'dist/lib/prisma.js')).href));
 const {buildApp}=await import(pathToFileURL(join(prepared.app,'dist/app.js')).href);
 app=await buildApp();await app.ready();
 const user=await prisma.user.create({data:{username:'fixture-author',email:'author@example.invalid',passwordHash:'unused'}});
 const reader=await prisma.user.create({data:{username:'fixture-reader',email:'reader@example.invalid',passwordHash:'unused'}});
 await prisma.follow.create({data:{followerId:reader.id,followingId:user.id}});
 const date=new Date('2025-01-01T00:00:00.000Z');
 const articles=[];
 for(let i=0;i<105;i++)articles.push(await prisma.article.create({data:{slug:'fixture-'+i,title:'Fixture '+i,description:'deterministic',body:'body',authorId:user.id,createdAt:date,updatedAt:date}}));
 const slug=articles[0].slug;
 const comments=[];
 for(let i=0;i<105;i++)comments.push(await prisma.comment.create({data:{articleId:articles[0].id,authorId:user.id,body:'comment-'+i,createdAt:date,updatedAt:date}}));
 const token=app.signUserToken(reader.id);
 const get=async(url,auth=false)=>app.inject({method:'GET',url,headers:auth?{authorization:'Token '+token}:{}});
 const invalid=['limit=0','limit=101','limit=-1','limit=1.5','limit=1e1','limit=0x10','limit=','offset=-1','offset=1.5','offset=1e1','offset=9007199254740992','sort=sideways'];
 if(target==='articles'||target==='all'){
  for(const [path,auth] of [['/api/articles',false],['/api/articles/feed',true]]){
   await check(path+' newest ties',async()=>{const r=await get(path+'?limit=2&offset=1',auth);assert.equal(r.statusCode,200);const b=r.json();assert.equal(b.articlesCount,105);assert.deepEqual(b.articles.map(a=>a.slug),[articles[103].slug,articles[102].slug]);});
   await check(path+' oldest ties',async()=>{const r=await get(path+'?limit=2&offset=1&sort=oldest',auth);assert.equal(r.statusCode,200);assert.deepEqual(r.json().articles.map(a=>a.slug),[articles[1].slug,articles[2].slug]);});
   await check(path+' boundary',async()=>{const r=await get(path+'?limit=100&offset=105',auth);assert.equal(r.statusCode,200);assert.deepEqual(r.json().articles,[]);assert.equal(r.json().articlesCount,105);});
   await check(path+' default',async()=>{assert.equal((await get(path,auth)).json().articles.length,20);});
   for(const query of invalid)await check(path+' rejects '+query,async()=>{assert.equal((await get(path+'?'+query,auth)).statusCode,422);});
  }
  await check('feed requires authentication',async()=>{assert.equal((await get('/api/articles/feed')).statusCode,401);});
  await check('author filter remains applied',async()=>{const r=await get('/api/articles?author=absent&sort=oldest');assert.equal(r.statusCode,200);assert.equal(r.json().articlesCount,0);});
 }
 if(target==='comments'||target==='all'){
  const path='/api/articles/'+slug+'/comments';
  await check('comments newest ties',async()=>{const r=await get(path+'?limit=2&offset=1');assert.equal(r.statusCode,200);assert.deepEqual(r.json().comments.map(c=>c.id),[comments[103].id,comments[102].id]);assert.equal(r.json().commentsCount,105);});
  await check('comments oldest ties',async()=>{const r=await get(path+'?limit=2&offset=1&sort=oldest');assert.equal(r.statusCode,200);assert.deepEqual(r.json().comments.map(c=>c.id),[comments[1].id,comments[2].id]);});
  await check('comments default',async()=>{const r=await get(path);assert.equal(r.json().comments.length,20);assert.equal(r.json().commentsCount,105);});
  await check('comments boundary',async()=>{const r=await get(path+'?limit=100&offset=105');assert.deepEqual(r.json().comments,[]);assert.equal(r.json().commentsCount,105);});
  for(const query of invalid)await check('comments rejects '+query,async()=>{assert.equal((await get(path+'?'+query)).statusCode,422);});
  await check('comments missing article',async()=>{assert.equal((await get('/api/articles/absent/comments')).statusCode,404);});
  await check('comments create requires auth',async()=>{const r=await app.inject({method:'POST',url:path,payload:{comment:{body:'new'}}});assert.equal(r.statusCode,401);});
  await check('comments owner protected',async()=>{const r=await app.inject({method:'DELETE',url:path+'/'+comments[0].id,headers:{authorization:'Token '+token}});assert.equal(r.statusCode,403);});
 }
 console.log(JSON.stringify({target,passed:checks.every(x=>x.passed),checks}));
 if(checks.some(x=>!x.passed))process.exitCode=1;
}finally{await app?.close();await prisma?.$disconnect();await cleanup(prepared);}
