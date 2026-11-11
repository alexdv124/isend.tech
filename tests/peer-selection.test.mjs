import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeerSelection} from '../lib/peer-selection.ts';
const now=100000,peer=(id,pairingId,seenAt=now)=>({id,name:'Компьютер',seenAt,signal:null,...(pairingId?{remembered:true,pairingId}:{})});
const remembered=(id,endpoint,online=true)=>({id,peer:{id:endpoint,name:'Компьютер'},online});
const state=(remembered=[],requests=[])=>({now,code:null,remembered,requests});
const accepted=(pairingId,id,direction='incoming')=>({id:'request-'+pairingId,pairingId,state:'accepted',expires:now+120000,direction,peer:{id,name:'Компьютер'}});
test('confirmation selects the exact new pair on both sides despite an earlier alphabetical neighbour',()=>{
 for(const direction of ['incoming','outgoing']){
  const saved=[],s=new PeerSelection('',v=>saved.push(v));s.pairing(state());
  assert.equal(s.choose([peer('a')],'',false,now),'a');
  s.pairing(state([remembered('pair','z')],[accepted('pair','z',direction)]));
  assert.equal(s.choose([peer('a'),peer('z','pair')],'a',false,now),'z');assert.deepEqual(saved,['pair']);
 }
});
test('one-time confirmation waits for presence and never steals a later manual choice',()=>{
 const s=new PeerSelection();s.pairing(state());s.pairing(state([remembered('p','z')]));
 assert.equal(s.choose([peer('a')],'a',false,now),'a');
 assert.equal(s.choose([peer('a'),peer('z','p')],'a',false,now),'z');
 s.manual(peer('a'));s.pairing(state([remembered('p','z')],[accepted('p','z')]));
 assert.equal(s.choose([peer('a'),peer('z','p')],'a',false,now),'a');
});
test('busy file or text keeps its receiver and adopts the pair after finishing',()=>{
 const s=new PeerSelection();s.pairing(state());s.pairing(state([remembered('p','z')]));
 const peers=[peer('a'),peer('z','p')];assert.equal(s.choose(peers,'a',true,now),'a');assert.equal(s.choose(peers,'a',false,now),'z');
});
test('manual selection cancels pending automatic switch, including before first status',()=>{
 const s=new PeerSelection();s.pairing(state());s.pairing(state([remembered('p','z')]));s.manual(peer('a'));
 assert.equal(s.choose([peer('a'),peer('z','p')],'a',false,now),'a');
 const first=new PeerSelection('p');first.manual(peer('a'));first.pairing(state([remembered('p','z')]));assert.equal(first.choose([peer('a'),peer('z','p')],'a',false,now),'a');
});
test('reload restores pair by stable ID even when its live endpoint changed',()=>{
 const s=new PeerSelection('p');s.pairing(state([remembered('p','old'),remembered('other','b')]));
 assert.equal(s.choose([peer('a'),peer('b','other'),peer('new','p')],'a',false,now),'new');
});
test('new pair overrides an older saved pair; repeated status does not override manual selection',()=>{
 const saved=[],s=new PeerSelection('old',v=>saved.push(v));s.pairing(state([remembered('old','b')]));s.choose([peer('b','old')],'',false,now);
 s.pairing(state([remembered('old','b'),remembered('new','z')]));const peers=[peer('b','old'),peer('z','new')];assert.equal(s.choose(peers,'b',false,now),'z');
 s.manual(peers[0]);s.pairing(state([remembered('old','b'),remembered('new','z')]));assert.equal(s.choose(peers,'b',false,now),'b');assert.deepEqual(saved,['new','old']);
});
test('pending, declined and expired requests cannot select an unconfirmed device; forgetting clears preference',()=>{
 const saved=[],s=new PeerSelection('',v=>saved.push(v));s.pairing(state());
 for(const status of ['pending','declined','cancelled'])s.pairing(state([],[{...accepted('p','z'),state:status}]));
 assert.equal(s.choose([peer('a'),peer('z')],'a',false,now),'a');assert.deepEqual(saved,[]);
 s.pairing(state([remembered('p','z')]));s.pairing(state());assert.equal(s.choose([peer('a'),peer('z')],'a',false,now),'a');assert.deepEqual(saved,['p','']);
});
test('confirmation selects original paired tab, not a second tab with the same identity',()=>{
 const s=new PeerSelection();s.pairing(state());s.pairing(state([remembered('p','other-tab')],[accepted('p','paired-tab')]));
 assert.equal(s.choose([peer('other-tab','p'),peer('paired-tab','p')],'',false,now),'paired-tab');
});
test('offline remembered peer is not warmed until it is online; unpaired fallback remains alphabetical',()=>{
 const s=new PeerSelection('p');s.pairing(state([remembered('p','z',false)]));
 assert.equal(s.choose([peer('a'),peer('z','p',0)],'',false,now),'a');
 assert.equal(s.choose([peer('a'),peer('z','p')],'a',false,now),'z');
 const empty=new PeerSelection();empty.pairing(state());assert.equal(empty.choose([peer('a'),peer('b')],'',false,now),'a');
});
test('reopened paired endpoint replaces its stale tab while retained for the file picker',()=>{
 const s=new PeerSelection('p');s.pairing(state([remembered('p','old')]));s.choose([peer('old','p')],'',false,now);
 assert.equal(s.choose([peer('old','p',0),peer('new','p')],'old',false,now),'new');
});
