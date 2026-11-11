import test from 'node:test';import assert from 'node:assert/strict';
import {TextSignals} from '../text-signals.mjs';
test('text signals are bounded and expire; newer SDP replaces previous state',()=>{
 let now=0;const s=new TextSignals({now:()=>now,max:2});
 assert.ok(s.put('room','a','b',{id:'1',sdp:'v=0'}));assert.ok(s.put('room','a','b',{id:'2',sdp:'v=0\nupdated'}));assert.equal(s.get('room','b').length,1);assert.equal(s.get('room','b')[0].id,'2');assert.deepEqual(s.get('other','b'),[]);
 assert.ok(s.put('room','b','a',{id:'3'}));assert.equal(s.put('room','c','a',{id:'4'}),false);now=120001;assert.deepEqual(s.get('room','b'),[]);assert.ok(s.put('room','c','a',{id:'4'}));
});
