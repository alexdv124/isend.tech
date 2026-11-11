import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
async function module(path){const {code}=await transform(await readFile(new URL(path,import.meta.url),'utf8'),{loader:'ts',format:'esm'});return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
const {sendQueue}=await module('../lib/send-queue.ts');
const {NetworkDiagnostics}=await module('../lib/connection-diagnostics.ts');
const path=(local='host',remote='host',protocol='udp')=>({local,remote,protocol,localAddress:'hidden',remoteAddress:'hidden'});
test('only the measured UDP host-to-host path receives the larger browser budget',()=>{
 assert.deepEqual(sendQueue(path()),{high:262144,low:65536});
 for(const value of [undefined,path('relay'),path('host','relay'),path('srflx'),path('host','prflx'),path('host','host','tcp')]){
  assert.deepEqual(sendQueue(value),{high:65536,low:16384});
 }
});
function stats(at,drops,id='pair'){
 return new Map([['transport',{type:'transport',selectedCandidatePairId:id}],
 [id,{id,type:'candidate-pair',timestamp:at,bytesSent:at*100,bytesReceived:at*200,packetsDiscardedOnSend:drops,localCandidateId:'l',remoteCandidateId:'r'}],
 ['l',{candidateType:'host',protocol:'udp'}],['r',{candidateType:'host'}]]);
}
test('a reused PeerConnection does not charge previous files socket drops',()=>{
 const d=new NetworkDiagnostics();
 assert.equal(d.sample(stats(1,591),'send').socketDrops,0);
 assert.equal(d.sample(stats(2,595),'send').socketDrops,4);
 assert.equal(d.sample(stats(3,595),'send').socketDrops,4);
});
test('route changes, stale statistics and reset counters do not invent packet losses',()=>{
 const d=new NetworkDiagnostics();
 d.sample(stats(1,591),'send');
 assert.equal(d.sample(stats(3,596),'send').socketDrops,5);
 assert.equal(d.sample(stats(2,593),'send').socketDrops,5);
 assert.equal(d.sample(stats(4,598),'send').socketDrops,7);
 assert.equal(d.sample(stats(5,80,'new-pair'),'send').socketDrops,7);
 assert.equal(d.sample(stats(6,83,'new-pair'),'send').socketDrops,10);
 assert.equal(d.sample(stats(7,0,'new-pair'),'send').socketDrops,10);
 assert.equal(d.sample(stats(8,2,'new-pair'),'send').socketDrops,12);
});
