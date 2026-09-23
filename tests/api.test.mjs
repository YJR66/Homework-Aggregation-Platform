import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplication, validateEntryUrl } from '../server/index.mjs';

test('本地 API、来源防护、凭据不回显、并发锁与同步存储',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'homework-api-'));
 const secrets={};
 const vault={get:id=>secrets[id]||{},configured:id=>Boolean(secrets[id]?.password),set:async(id,v)=>{secrets[id]=v;},redact:x=>String(x).replaceAll('test-secret','[已隐藏]')};
 let release;
  const app=await createApplication({dataDir:dir,vault,browserFactory:()=>({browserAvailable:true,isOpen:()=>false,getSession:async()=>({page:{goto:async()=>{}},context:{}}),openLogin:async()=>{},close:async()=>{}}),collector:async()=>{await new Promise(r=>{release=r;});return {authenticated:true,complete:true,assignments:[{externalId:'1',title:'真实样例结构测试',course:'测试',status:'submitted'}]};}});
 try {
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const req=(p,method='GET',body,headers={})=>fetch(url+p,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await req('/api/state')).status,200);
  assert.equal((await req('/api/state','GET',undefined,{origin:'https://evil.example'})).status,403);
  assert.equal((await req('/api/settings','PUT',{autoSync:true,syncIntervalMinutes:1})).status,400);
  assert.equal((await req('/api/platforms/pta/credentials','POST',{username:'test-user',password:'test-secret'})).status,200);
  const stateText=await (await req('/api/state')).text();
  assert.ok(!stateText.includes('test-secret')); assert.ok(!stateText.includes('test-user'));
  assert.equal((await req('/api/sync','POST',{platform:'pta'})).status,202);
  assert.equal((await req('/api/sync','POST',{platform:'pta'})).status,409);
  for(let n=0;!release&&n<20;n++)await new Promise(r=>setTimeout(r,10));
  assert.ok(release); release();
  let state;
  for(let n=0;n<50;n++){state=await (await req('/api/state')).json();if(!state.sync.running)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(state.assignments.length,1); assert.equal(state.platforms.find(p=>p.id==='pta').status,'connected');
  assert.equal((await req(`/api/assignments/${state.assignments[0].id}`,'PATCH',{completed:true})).status,200);
  assert.equal((await req('/data/credentials.dpapi.json')).status,404);
 }finally{release?.();await app.close();await rm(dir,{recursive:true,force:true});}
});
test('平台入口 URL 精确边界',()=>{
 assert.ok(validateEntryUrl('pta','https://pintia.cn/problem-sets'));
 for(const u of ['http://pintia.cn','https://pintia.cn.evil.test','https://user:pass@pintia.cn','https://127.0.0.1','file:///C:/']) assert.throws(()=>validateEntryUrl('pta',u));
 assert.throws(()=>validateEntryUrl('xiji','https://evil.vpn.neuq.edu.cn'));
});
