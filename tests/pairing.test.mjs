import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pairing,identityHash,CODE_TTL} from '../pairing.mjs';
import {createApp} from '../server.mjs';
const key=()=>randomBytes(24).toString('hex');
const device=()=>({identity:identityHash(key()),id:key(),name:'Компьютер'});
const error=code=>e=>e.code===code;
function fixture(options={}){
  let now=1000000,n=0;const p=new Pairing({now:()=>now,chooseCode:()=>String(n++).padStart(4,'0'),...options}),a=device(),b=device(),c=device();
  const act=(who,v,ip=who.id)=>p.act(who,ip,v);
  const invite=()=>act(a,{action:'create'}).code.value;
  const request=()=>{act(b,{action:'lookup',code:invite()});return p.snapshot(a).requests.find(r=>r.state==='pending').id;};
  return {p,a,b,c,act,invite,request,tick:n=>{now+=n;}};
}

test('four digit code including 0000 lasts exactly two minutes; refresh never extends it',()=>{
  const f=fixture(),code=f.invite();assert.equal(code,'0000');const expires=f.p.snapshot(f.a).code.expires;
  f.tick(CODE_TTL-1);assert.equal(f.act(f.a,{action:'create'}).code.expires,expires);
  f.tick(1);assert.equal(f.p.snapshot(f.a).code,null);
  assert.throws(()=>f.act(f.b,{action:'lookup',code}),error('code_invalid'));
  assert.notEqual(f.invite(),code);
});

test('lookup is not consent, consumed code pins an immutable exact request, owner alone approves',()=>{
  const f=fixture(),code=f.invite();f.act(f.b,{action:'lookup',code});
  const req=f.p.snapshot(f.a).requests[0];assert.equal(f.p.linked(f.a.identity).length,0);
  assert.equal(f.p.snapshot(f.a).code,null);assert.equal(req.peer.id,f.b.id);
  assert.throws(()=>f.act(f.c,{action:'lookup',code}),error('code_invalid'));
  assert.throws(()=>f.act(f.b,{action:'accept',request:req.id}),error('request_expired'));
  assert.throws(()=>f.act(f.c,{action:'accept',request:req.id}),error('request_expired'));
  f.act(f.a,{action:'accept',request:req.id});assert.ok(f.p.relationship(f.a.identity,f.b.identity));
  const pair=f.p.relationship(f.a.identity,f.b.identity);
  assert.equal(f.p.snapshot(f.a).requests[0].pairingId,pair.id);assert.equal(f.p.snapshot(f.b).requests[0].pairingId,pair.id);
  assert.equal(f.p.snapshot(f.a).requests[0].peer.id,f.b.id);assert.equal(f.p.snapshot(f.b).requests[0].peer.id,f.a.id);
  assert.equal(f.p.relationship(f.a.identity,f.c.identity),undefined);
  assert.throws(()=>f.act(f.a,{action:'accept',request:req.id}),error('request_expired'));
  assert.throws(()=>f.act(f.b,{action:'lookup',code}),error('code_invalid'));
});

test('confirmation expires at original deadline; decline and cancellation never grant access',()=>{
  for(const mode of ['expire','decline','cancel']){
    const f=fixture();f.invite();f.tick(110000);const request=f.request();
    if(mode==='expire')f.tick(10000);
    else f.act(mode==='decline'?f.a:f.b,{action:mode,request});
    assert.throws(()=>f.act(f.a,{action:'accept',request}),error('request_expired'));
    assert.equal(f.p.linked(f.a.identity).length,0);
  }
});

test('self-pairing, duplicate pending requests and stale cancellation cannot change a new request',()=>{
  const f=fixture(),code=f.invite();assert.throws(()=>f.act({...f.a,id:key()},{action:'lookup',code}),error('code_self'));
  const request=f.request();assert.throws(()=>f.act(f.a,{action:'create'}),error('pair_pending'));
  f.act(f.b,{action:'cancel',request});const next=f.request();assert.notEqual(next,request);
  assert.throws(()=>f.act(f.b,{action:'cancel',request}),error('request_expired'));
  assert.equal(f.p.snapshot(f.a).requests.find(r=>r.id===next).state,'pending');
});

test('code collision is retried, live codes are unique, retired codes have a cooldown',()=>{
  const candidates=['1234','1234','1235','1234','1236'];
  const f=fixture({chooseCode:()=>candidates.shift()||'9999'});
  assert.equal(f.invite(),'1234');assert.equal(f.act(f.b,{action:'create'}).code.value,'1235');
  f.act(f.a,{action:'close'});assert.equal(f.act(f.c,{action:'create'}).code.value,'1236');
});

test('guess limits survive changing IP or browser identity, expire, and include global protection',()=>{
  const f=fixture();for(let i=0;i<5;i++)assert.throws(()=>f.act(f.b,{action:'lookup',code:'9999'},'ip-'+i),error('code_invalid'));
  assert.throws(()=>f.act(f.b,{action:'lookup',code:'9999'},'another-ip'),error('pair_rate_limited'));
  for(let i=0;i<20;i++)assert.throws(()=>f.act(device(),{action:'lookup',code:'9999'},'shared-ip'),error('code_invalid'));
  assert.throws(()=>f.act(device(),{action:'lookup',code:'9999'},'shared-ip'),error('pair_rate_limited'));
  const g=fixture();for(let i=0;i<120;i++)assert.throws(()=>g.act(device(),{action:'lookup',code:'9999'}),error('code_invalid'));
  assert.throws(()=>g.act(device(),{action:'lookup',code:'9999'}),error('pair_rate_limited'));
  f.tick(600001);assert.throws(()=>f.act(f.b,{action:'lookup',code:'9999'}),error('code_invalid'));
});

test('code creation is bounded and cannot bypass lookup limits or prolong active invitations',()=>{
  const f=fixture();for(let i=0;i<5;i++){f.invite();f.act(f.a,{action:'close'});}
  assert.throws(()=>f.invite(),error('pair_rate_limited'));
});

test('confirmed pairs survive restart and new endpoints, revoke on both sides, store no secrets or codes',t=>{
  const dir=mkdtempSync(join(tmpdir(),'isend-pairing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'pairs.json'),f=fixture({path});const request=f.request();f.act(f.a,{action:'accept',request});
  const raw=readFileSync(path,'utf8');assert.ok(!raw.includes('"code":')&&!raw.includes(request));
  const restarted=new Pairing({path});const a={...f.a,id:key()},b={...f.b,id:key()};
  assert.ok(restarted.relationship(a.identity,b.identity));assert.equal(restarted.snapshot(a).code,null);
  const id=restarted.snapshot(a).remembered[0].id;
  assert.throws(()=>restarted.act(f.c,'net',{action:'forget',pair:id}),error('pair_missing'));
  restarted.act(b,'new-vpn',{action:'forget',pair:id});assert.equal(restarted.linked(a.identity).length,0);
  assert.equal(new Pairing({path}).linked(b.identity).length,0);
});

test('persistent save errors fail closed and invalid database does not silently discard trust',t=>{
  const dir=mkdtempSync(join(tmpdir(),'isend-pairing-fail-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fixture();const request=f.request();const blocker=join(dir,'blocker');writeFileSync(blocker,'not a directory');f.p.path=join(blocker,'pairs.json');
  assert.throws(()=>f.act(f.a,{action:'accept',request}),error('pair_save_failed'));assert.equal(f.p.pairs.size,0);assert.equal(f.p.snapshot(f.a).requests[0].state,'pending');
  writeFileSync(join(dir,'corrupt'),'{broken');assert.throws(()=>new Pairing({path:join(dir,'corrupt')}));
});

test('identity secret validation rejects malformed headers and never treats public hashes as credentials',()=>{
  assert.equal(identityHash(undefined),null);assert.equal(identityHash(key()).length,64);
  for(const secret of ['',null,'1234','a'.repeat(64),['abc']])assert.throws(()=>identityHash(secret),error('identity_invalid'));
});

test('HTTP pairs across VPNs, rejects impersonation, survives server restart, revokes and hides secrets',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'isend-pair-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const env={TRUST_PROXY:'loopback',PAIRING_STORE:join(dir,'pairs.json')};let server,base;
  const start=async()=>{server=await createApp({env});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;};
  const stop=()=>new Promise(r=>{server.close(r);server.closeAllConnections();});t.after(stop);await start();
  const make=ip=>({room:key(),id:key(),token:key(),secret:key(),ip}),a=make('192.0.2.1'),b=make('198.51.100.2'),c=make('203.0.113.3');
  const call=(p,path,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${p.room}`,'X-Perebros-Device':p.token,'X-Isend-Identity':p.secret,'X-Forwarded-For':p.ip,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const register=async p=>{assert.equal((await call(p,'/api/peers','PUT',{id:p.id,name:'Компьютер',protocol:3,clipboard:1,warm:1})).status,200);assert.equal((await call(p,'/api/discovery?device='+p.id,'POST',{action:'presence'})).status,200);};
  const pair=(p,action,extra={})=>call(p,'/api/pairing?device='+p.id,'POST',{action,...extra});
  const peers=async p=>(await(await call(p,'/api/peers?device='+p.id)).json()).peers;
  for(const p of [a,b,c])await register(p);
  const code=(await(await pair(a,'create')).json()).code.value;
  const lookup=await(await pair(b,'lookup',{code})).json();assert.equal((await peers(b)).some(p=>p.id===a.id),false);
  const request=lookup.requests[0].id;
  const signal={id:key(),to:a.id,type:'offer',sdp:'v=0\r\na=ice-ufrag:test'};
  assert.equal((await call(b,'/api/text-signals?device='+b.id,'POST',signal)).status,403);
  for(const path of ['/api/peers?device='+a.id,'/api/text-signals?device='+a.id,'/api/ice?device='+a.id])assert.equal((await call({...a,secret:c.secret},path)).status,403);
  assert.equal((await call({...a,secret:c.secret},'/api/peers','PUT',{id:a.id})).status,403);
  assert.equal((await pair({...a,secret:c.secret},'accept',{request})).status,403);
  assert.equal((await pair(b,'accept',{request})).status,409);
  assert.equal((await pair(a,'accept',{request})).status,200);
  assert.equal((await peers(a)).find(p=>p.id===b.id).remembered,true);
  assert.equal((await call(b,'/api/text-signals?device='+b.id,'POST',signal)).status,200);
  const response=JSON.stringify(await peers(a));for(const hidden of [a.secret,b.secret,a.ip,b.ip,b.room,identityHash(a.secret),identityHash(b.secret)])assert.ok(!response.includes(hidden));
  // Other tabs of the same browser are not listed as separate devices.
  const sibling={...a,id:key(),token:key()};await register(sibling);
  assert.equal((await peers(a)).some(p=>p.id===sibling.id),false);
  // A visitor with the same room URL gets no inherited browser pairing.
  const interloper={...c,room:a.room};await register(interloper);assert.equal((await peers(interloper)).some(p=>p.id===b.id),false);
  const persisted=readFileSync(env.PAIRING_STORE,'utf8');for(const secret of [a.secret,b.secret,a.room,b.room])assert.ok(!persisted.includes(secret));
  await stop();await start();
  for(const p of [a,b]){p.id=key();p.room=key();p.ip=p===a?'203.0.113.11':'192.0.2.22';await register(p);}
  assert.equal((await peers(a)).find(p=>p.id===b.id).remembered,true);
  const saved=await(await pair(a,'status')).json();assert.equal(saved.remembered[0].online,true);
  assert.equal((await pair(a,'forget',{pair:saved.remembered[0].id})).status,200);
  assert.equal((await peers(b)).some(p=>p.id===a.id),false);
  assert.equal((await call(b,'/api/text-signals?device='+b.id,'POST',{...signal,to:a.id})).status,403);
});

test('entering another code retires own invitation and prevents competing pairings',()=>{
  const f=fixture(),aCode=f.invite(),bCode=f.act(f.b,{action:'create'}).code.value;
  f.act(f.b,{action:'lookup',code:aCode});assert.equal(f.p.snapshot(f.b).code,null);
  assert.throws(()=>f.act(f.c,{action:'lookup',code:bCode}),error('code_invalid'));
  assert.throws(()=>f.act(f.b,{action:'create'}),error('pair_pending'));
  assert.equal(f.p.snapshot(f.a).requests.filter(r=>r.state==='pending').length,1);
});
