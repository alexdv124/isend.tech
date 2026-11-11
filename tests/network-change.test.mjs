import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const {code}=await transform(await readFile(new URL('../lib/network-change.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {watchNetworkChanges}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function fixture(type='cellular'){
  const events=new EventTarget(),info=new EventTarget(),pending=new Map();let sequence=0,calls=0;
  info.type=type;
  const stop=watchNetworkChanges(events,info,()=>calls++,{set:fn=>{pending.set(++sequence,fn);return sequence;},clear:id=>pending.delete(id)});
  const flush=()=>{for(const [id,fn]of pending){pending.delete(id);fn();}};
  const change=type=>{info.type=type;info.dispatchEvent(new Event('change'));};
  return {events,info,stop,flush,change,count:()=>calls};
}
test('cellular-to-wifi and wifi-to-cellular trigger a single debounced restart',()=>{
  const f=fixture();f.change('wifi');f.events.dispatchEvent(new Event('online'));f.change('wifi');f.flush();assert.equal(f.count(),1);
  f.change('cellular');f.flush();assert.equal(f.count(),2);f.stop();
});
test('bandwidth changes on the same interface do not interrupt transfers',()=>{
  const f=fixture('wifi');f.info.effectiveType='2g';f.change('wifi');f.info.effectiveType='4g';f.change('wifi');f.flush();assert.equal(f.count(),0);f.stop();
});
test('offline cancels a pending restart, online restores it',()=>{
  const f=fixture();f.change('wifi');f.events.dispatchEvent(new Event('offline'));f.flush();assert.equal(f.count(),0);
  f.change('none');f.flush();assert.equal(f.count(),0);
  f.events.dispatchEvent(new Event('online'));f.flush();assert.equal(f.count(),1);f.stop();
});
test('browsers without interface information rely on online events',()=>{
  const f=fixture('unknown');f.change('unknown');f.flush();assert.equal(f.count(),0);
  f.events.dispatchEvent(new Event('online'));f.flush();assert.equal(f.count(),1);f.stop();
});
test('cleanup removes listeners and cancels delayed callbacks',()=>{
  const f=fixture();f.change('wifi');f.stop();f.flush();f.change('cellular');f.events.dispatchEvent(new Event('online'));f.flush();assert.equal(f.count(),0);
});
