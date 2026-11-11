import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {request} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp,Registry} from '../server.mjs';

const key=()=>randomBytes(24).toString('hex');
test('starts when systemd uses a release symlink',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'perebros-entry-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await symlink(fileURLToPath(new URL('../server.mjs',import.meta.url)),join(dir,'server.mjs'));
  const probe=await createApp({env:{}});
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Server did not start')),5000);
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Early exit '+code));});
    child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
});
async function fixture(t,env={}){
  const server=await createApp({env});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,room,method='GET',value)=>fetch(base+path,{method,headers:room?{Authorization:`Bearer ${room}`,'Content-Type':'application/json'}:{},...(value!==undefined?{body:JSON.stringify(value)}:{})});
  return {base,call};
}
test('isolated authenticated rooms, SDP exchange, sleeping phone retained',async t=>{
  const {call}=await fixture(t);const a=key(),b=key(),device=key(),to=key();
  assert.equal((await call('/api/peers')).status,401);
  const signal={id:key(),to,type:'offer',sdp:'v=0\r\na=ice-ufrag:test'};
  assert.equal((await call('/api/peers',a,'PUT',{id:device,name:'Телефон',protocol:3,signal})).status,200);
  const peers=(await (await call('/api/peers',a)).json()).peers;
  assert.equal(peers.length,1);assert.deepEqual(peers[0].signal,signal);assert.equal(peers[0].protocol,3);
  assert.deepEqual(await (await call('/api/peers',b)).json(),{peers:[]});
  assert.equal((await call('/api/peers',a,'PUT',{id:device,signal:{...signal,sdp:'bad'}})).status,400);
  assert.equal((await call('/api/peers',a,'PUT',null)).status,400);
  assert.equal((await call('/api/peers',a,'PUT',{id:device,signal:{...signal,sdp:'v=0'+'a'.repeat(18000)}})).status,400);
});
test('bounded presence, no eviction of active transfers, picker retention expires',()=>{
  let now=1000000;const r=new Registry({now:()=>now});const ids=Array.from({length:8},key);
  for(const id of ids)r.put('a',{id});
  assert.throws(()=>r.put('a',{id:key()}),e=>e.status===429);
  r.put('a',{id:ids[0],signal:null});
  now+=180000;r.put('a',{id:key()});assert.equal(r.get('a').length,9);
  for(let i=0;i<70;i++){now+=180000;r.put('a',{id:key()});}
  assert.equal(r.get('a').length,64);assert.equal(r.count,64);
  now+=6*60*60*1000+1;r.sweep();assert.equal(r.count,0);assert.equal(r.rooms.size,0);
  const bounded=new Registry({maxPeers:1,maxRooms:1});const id=key();bounded.put('a',{id});
  assert.throws(()=>bounded.put('b',{id:key()}),e=>e.status===503);
  bounded.put('a',{id});assert.equal(bounded.get('a')[0].id,id);
});
test('rejects file uploads and oversized metadata including chunked body',async t=>{
  const {base,call}=await fixture(t);const room=key();
  assert.deepEqual(await (await call('/api/files',room)).json(),{files:[]});
  assert.equal((await call('/api/files',room,'PUT',{file:'not accepted'})).status,410);
  assert.equal((await call('/api/peers',room,'PUT',{id:key(),padding:'x'.repeat(25000)})).status,413);
  const status=await new Promise((resolve,reject)=>{
    const req=request(base+'/api/peers',{method:'PUT',headers:{Authorization:`Bearer ${room}`,'Transfer-Encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.write('x'.repeat(13000));req.end('x'.repeat(13000));
  });assert.equal(status,413);
});
test('STUN default, short-lived TURN credentials and safe incomplete-config fallback',async t=>{
  const room=key(),device=key();const direct=await fixture(t);
  assert.equal((await (await direct.call('/api/ice?device='+device,room)).json()).relayAvailable,false);
  const secret='unit-test-only-secret';const relay=await fixture(t,{TURN_AUTH_SECRET:secret,TURN_URLS:'turn:example.invalid:3478'});
  assert.equal((await relay.call('/api/ice?device='+device,room)).status,403);
  await relay.call('/api/peers',room,'PUT',{id:device});
  const response=await (await relay.call('/api/ice?device='+device,room)).json();
  assert.equal(response.relayAvailable,true);const credentials=response.iceServers.at(-1);
  assert.equal(credentials.credential,createHmac('sha1',secret).update(credentials.username).digest('base64'));
  assert.equal(JSON.stringify(response).includes(secret),false);
  const broken=await fixture(t,{TURN_AUTH_SECRET:secret});await broken.call('/api/peers',room,'PUT',{id:device});
  assert.equal((await (await broken.call('/api/ice?device='+device,room)).json()).relayUnavailable,true);
});
test('production assets, origin restrictions and no arbitrary file reads',async t=>{
  const {base}=await fixture(t,{PUBLIC_ORIGIN:'https://example.invalid'});
  const page=await fetch(base);const html=await page.text();assert.match(html,/isend.tech/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  for(const path of ['/server.mjs','/.env','/package.json','/%2e%2e/server.mjs'])assert.equal((await fetch(base+path)).status,404);
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m=>m[1]);
  assert.equal(assets.length,2);
  for(const asset of assets){const response=await fetch(base+asset);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/immutable/);}
  assert.match((await fetch(base+'/storage-worker.js')).headers.get('content-type'),/javascript/);
  const foreign=await fetch(base+'/api/peers',{headers:{Authorization:`Bearer ${key()}`,Origin:'https://other.invalid'}});assert.equal(foreign.status,403);
});

test('clipboard signaling is isolated, registered and SDP-only',async t=>{
 const {call}=await fixture(t);const room=key(),other=key(),a=key(),b=key();
 assert.equal((await call('/api/text-signals?device='+a,room)).status,403);
 for(const id of [a,b])await call('/api/peers',room,'PUT',{id,protocol:3,clipboard:1});
 const signal={id:key(),to:b,type:'offer',sdp:'v=0\r\na=ice-ufrag:test',text:'never retain this'};
 assert.equal((await call('/api/text-signals?device='+a,room,'POST',signal)).status,200);
 const response=await (await call('/api/text-signals?device='+b,room)).json();assert.equal(response.signals[0].from,a);assert.equal(response.signals[0].sdp,signal.sdp);assert.equal(JSON.stringify(response).includes('never retain'),false);
 assert.deepEqual(await(await call('/api/text-signals?device='+a,room)).json(),{signals:[]});
 assert.equal((await call('/api/text-signals?device='+b,other)).status,403);
 assert.equal((await call('/api/text-signals?device='+a,room,'POST',{...signal,sdp:'plain text'})).status,400);
 assert.equal((await call('/api/text-signals?device='+a,room,'POST',{...signal,to:key()})).status,403);
});
