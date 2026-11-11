import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Discovery,clientNetwork} from '../discovery.mjs';
import {createApp} from '../server.mjs';
const key=()=>randomBytes(24).toString('hex');

test('proxy address cannot be spoofed; IPv4 and IPv6 LAN grouping',()=>{
  const request=(ip,forwarded)=>({socket:{remoteAddress:ip},headers:{'x-forwarded-for':forwarded}});
  assert.equal(clientNetwork(request('203.0.113.10','1.2.3.4'),true),'v4:203.0.113.10');
  assert.equal(clientNetwork(request('127.0.0.1','1.2.3.4'),false),'v4:127.0.0.1');
  assert.equal(clientNetwork(request('127.0.0.1','1.2.3.4'),true),'v4:1.2.3.4');
  assert.equal(clientNetwork(request('127.0.0.1','1.2.3.4, 8.8.8.8'),true),'v4:127.0.0.1');
  assert.equal(clientNetwork(request('::ffff:192.0.2.10')),'v4:192.0.2.10');
  assert.equal(clientNetwork(request('2001:db8:0123:0045::a')),clientNetwork(request('2001:db8:123:45:aa:bb:cc:dd')));
  assert.notEqual(clientNetwork(request('2001:db8:123:45::a')),clientNetwork(request('2001:db8:123:46::a')));
  assert.equal(clientNetwork(request('::1')),'v6:0:0:0:0');
});

test('discovery needs consent, has no transitive trust, and hides identifiers',()=>{
  const d=new Discovery(),a=key(),b=key(),c=key(),ta=key(),tb=key(),tc=key();
  d.presence('room-a',a,ta,'network','Компьютер');
  const list=d.presence('room-b',b,tb,'network','Телефон');
  assert.deepEqual(Object.keys(list.nearby[0]).sort(),['id','name','seenAt']);
  assert.ok(!JSON.stringify(list).includes('room-a')&&!JSON.stringify(list).includes(ta));
  assert.deepEqual(d.allowed('room-a',a),[]);
  assert.throws(()=>d.presence('attacker',a,key(),'network','Компьютер'),e=>e.status===403);
  d.action('room-a',a,ta,'request',b);
  assert.throws(()=>d.action('room-a',a,ta,'accept',b),e=>e.status===409);
  assert.throws(()=>d.action('room-b',b,key(),'accept',a),e=>e.status===403);
  d.action('room-b',b,tb,'accept',a);
  assert.deepEqual(d.allowed('room-a',a),[{id:b,room:'room-b'}]);
  d.presence('room-c',c,tc,'network','Компьютер');
  d.action('room-c',c,tc,'request',b);d.action('room-b',b,tb,'accept',c);
  assert.equal(d.allowed('room-a',a).some(v=>v.id===c),false);
  d.presence('room-b',b,tb,'different-network','Телефон');
  assert.doesNotThrow(()=>d.action('room-a',a,ta,'request',b)); // Prior consent survives a network change.
  assert.deepEqual(d.allowed('room-a',a),[{id:b,room:'room-b'}]);
  // Moving to a QR room with the same endpoint credential preserves pairing.
  d.presence('room-new',b,tb,'different-network','Телефон');
  assert.deepEqual(d.allowed('room-a',a),[{id:b,room:'room-new'}]);
});

test('expiry, different networks, decline/cancel, simultaneous requests and bounds',()=>{
  let now=0;const d=new Discovery({now:()=>now,max:3}),a=key(),b=key(),c=key(),ta=key(),tb=key(),tc=key();
  d.presence('a',a,ta,'home','Компьютер');d.presence('b',b,tb,'mobile','Телефон');
  assert.deepEqual(d.snapshot(a).nearby,[]);assert.throws(()=>d.action('a',a,ta,'request',b),e=>e.status===409);
  d.presence('b',b,tb,'home','Телефон');d.action('a',a,ta,'request',b);d.action('b',b,tb,'request',a);
  assert.equal(d.snapshot(b).requests[0].direction,'incoming');
  d.action('b',b,tb,'decline',a);assert.equal(d.snapshot(a).requests[0].state,'declined');
  assert.throws(()=>d.action('a',a,ta,'request',b),e=>e.status===429);
  now=60001;d.presence('a',a,ta,'home','Компьютер');d.presence('b',b,tb,'home','Телефон');
  d.action('a',a,ta,'request',b);d.action('a',a,ta,'cancel',b);
  assert.equal(d.snapshot(b).requests.length,0);assert.throws(()=>d.action('b',b,tb,'accept',a),e=>e.status===409);
  d.presence('c',c,tc,'home','Компьютер');assert.throws(()=>d.presence('d',key(),key(),'home','Компьютер'),e=>e.status===503);
  now+=30001;assert.deepEqual(d.snapshot(a).nearby,[]);
  now+=6*60*60*1000;d.sweep();assert.equal(d.devices.size,0);assert.equal(d.invites.size,0);
});

test('HTTP cross-room files and clipboard become reachable only after exact-device consent',async t=>{
  const server=await createApp({env:{TRUST_PROXY:'loopback'}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const make=()=>({room:key(),id:key(),token:key(),ip:'192.0.2.20'}),a=make(),b=make(),c=make();c.ip='198.51.100.10';
  const call=(p,path,method='GET',value)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${p.room}`,'X-Perebros-Device':p.token,'X-Forwarded-For':p.ip,'Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});
  const find=(p,action='presence',to)=>call(p,'/api/discovery?device='+p.id,'POST',{action,to});
  const peers=p=>call(p,'/api/peers?device='+p.id).then(r=>r.json());
  for(const p of [a,b,c]){await call(p,'/api/peers','PUT',{id:p.id,name:'Компьютер',clipboard:1,protocol:3});assert.equal((await find(p)).status,200);}
  const discovered=await(await find(a)).json();assert.equal(discovered.nearby.length,1);assert.equal(discovered.nearby[0].id,b.id);
  assert.equal(JSON.stringify(discovered).includes(b.room),false);assert.equal(JSON.stringify(discovered).includes(a.ip),false);
  assert.equal((await peers(a)).peers.length,1);
  const signal={id:key(),to:b.id,type:'offer',sdp:'v=0\r\na=ice-ufrag:test'};
  assert.equal((await call(a,'/api/text-signals?device='+a.id,'POST',signal)).status,403);
  assert.equal((await find(a,'request',c.id)).status,409);
  assert.equal((await find(a,'request',b.id)).status,200);
  assert.equal((await find(a,'accept',b.id)).status,409);
  assert.equal((await peers(b)).peers.length,1);
  assert.equal((await find(b,'accept',a.id)).status,200);
  await call(a,'/api/peers','PUT',{id:a.id,clipboard:1,protocol:3,signal});
  assert.deepEqual((await peers(b)).peers.find(p=>p.id===a.id).signal,signal);assert.equal((await peers(b)).peers.find(p=>p.id===a.id).paired,true);
  assert.equal((await peers(c)).peers.length,1);
  assert.equal((await call(a,'/api/text-signals?device='+a.id,'POST',signal)).status,200);
  assert.equal((await(await call(b,'/api/text-signals?device='+b.id)).json()).signals[0].from,a.id);
  const answer={...signal,to:a.id,type:'answer'};
  assert.equal((await call(b,'/api/text-signals?device='+b.id,'POST',answer)).status,200);
  assert.equal((await(await call(a,'/api/text-signals?device='+a.id)).json()).signals[0].from,b.id);
  const cBefore=await peers(c);c.ip=a.ip;await find(c);
  assert.deepEqual(await peers(c),cBefore); // Same public IP is not authorization.
  // Another device in the receiver's room cannot inherit a device-specific grant.
  const b2={...b,id:key(),token:key()};await call(b2,'/api/peers','PUT',{id:b2.id,clipboard:1});await find(b2);
  assert.equal((await peers(b2)).peers.some(p=>p.id===a.id),false);
  assert.equal((await call(b2,'/api/text-signals?device='+b2.id,'POST',answer)).status,403);
});


test('warm neighbours preconnect across rooms without leaking secrets or legacy file offers',async t=>{
  const server=await createApp({env:{TRUST_PROXY:'loopback'}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const make=(ip='192.0.2.20',warm=1)=>({room:key(),id:key(),token:key(),ip,warm}),a=make(),b=make(),c=make('198.51.100.10'),legacy=make('192.0.2.20',undefined);
  legacy.warm=undefined;
  const call=(p,path,method='GET',value)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${p.room}`,'X-Perebros-Device':p.token,'X-Forwarded-For':p.ip,'Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});
  const signal={id:key(),to:b.id,type:'offer',sdp:'v=0\r\na=ice-ufrag:test'};
  for(const p of [a,b,c,legacy]){assert.equal((await call(p,'/api/peers','PUT',{id:p.id,protocol:3,clipboard:1,warm:p.warm,preferred:b.id,signal:p===a?signal:null})).status,200);await call(p,'/api/discovery?device='+p.id,'POST',{action:'presence'});}
  const response=await(await call(b,'/api/peers?device='+b.id)).json();
  const other=response.peers.find(p=>p.id===a.id);assert.equal(other.sameRoom,false);assert.equal(other.paired,false);assert.equal(other.signal,null);assert.equal(other.preferred,b.id);
  assert.ok(!JSON.stringify(response).includes(a.room));assert.ok(!JSON.stringify(response).includes(a.token));
  assert.equal(response.peers.some(p=>p.id===c.id||p.id===legacy.id),false);
  assert.equal((await call(a,'/api/text-signals?device='+a.id,'POST',signal)).status,200);
  assert.equal((await(await call(b,'/api/text-signals?device='+b.id)).json()).signals[0].from,a.id);
  assert.equal((await call(c,'/api/text-signals?device='+c.id,'POST',signal)).status,403);
  assert.equal((await call(legacy,'/api/text-signals?device='+legacy.id,'POST',signal)).status,403);
});
