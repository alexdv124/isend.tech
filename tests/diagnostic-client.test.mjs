import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const {outputFiles}=await build({entryPoints:['lib/diagnostic-log.ts'],bundle:true,write:false,format:'iife',globalName:'Diagnostics',platform:'browser'});
function fixture(){
 let fail=false;const calls=[],handlers=new Map();
 const context=vm.createContext({crypto:webcrypto,performance,Date,AbortSignal,console,localStorage:{getItem:()=>null,setItem(){}},setInterval:()=>1,clearInterval(){},document:{hidden:false,addEventListener:(k,v)=>handlers.set(k,v),removeEventListener:k=>handlers.delete(k)},window:{addEventListener:(k,v)=>handlers.set(k,v),removeEventListener:k=>handlers.delete(k)},navigator:{userAgent:'Mozilla Chrome/130.0 Windows',onLine:true},fetch:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});if(fail)throw new Error('offline');return {ok:true};}});
 vm.runInContext(outputFiles[0].text,context);const log=new context.Diagnostics.DiagnosticLog('a'.repeat(48),'b'.repeat(48),()=>[{transfer:'c'.repeat(48),role:'send'}]);
 return {log,calls,handlers,error:context.Diagnostics.diagnosticError,setFail:v=>{fail=v;}};
}
test('offline diagnostics are bounded, retry without throwing, and do not duplicate acknowledged events',async()=>{
 const f=fixture();f.setFail(true);for(let n=0;n<180;n++)f.log.event('sample',{offset:n});
 assert.equal(f.calls.length,0,'recording should not perform per-packet requests');
 await f.log.flush();assert.equal(f.calls[0].body.events.length,12);assert.equal(f.calls[0].body.events[0].seq,54);
 assert.equal(f.calls[0].body.events.at(-1).revision,28);assert.equal(f.calls[0].options.keepalive,true);
 await f.log.flush();assert.equal(f.calls.length,1,'retry backs off');
 f.setFail(false);await f.log.flush(true);assert.deepEqual(f.calls[1].body.events,f.calls[0].body.events);
 await f.log.flush(true);assert.equal(f.calls[2].body.events[0].seq,66);f.log.stop();
});
test('lifecycle diagnostics include transfer context; raw errors are never returned',async()=>{
 const f=fixture();f.handlers.get('pagehide')();await Promise.resolve();
 assert.equal(f.calls[0].body.events[1].event,'page_exit');assert.equal(f.calls[0].body.events[1].transfer,'c'.repeat(48));
 assert.equal(f.error(new Error('passport.pdf: Неверный порядок блоков.')),'sequence');
 assert.equal(f.error(new Error('my-secret-content')),'unknown');
 f.log.stop();assert.equal(f.handlers.size,0);
});
test('solo page is recorded after registration, discovery is counted once without polling duplicates',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);
 f.log.registered();await Promise.resolve();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.events.map(e=>e.event),['page_view']);
 f.log.registered();f.log.devicesFound(0);await f.log.flush();assert.equal(f.calls.length,1);
 f.log.devicesFound(2);f.log.devicesFound(1);f.log.devicesFound(3);await f.log.flush();
 assert.deepEqual(f.calls[1].body.events.map(e=>e.event),['device_found']);assert.equal(f.calls[1].body.events[0].peerCount,2);f.log.stop();
});
test('registration failure retains the page view for later delivery',async()=>{
 const f=fixture();f.setFail(true);f.log.registered();await new Promise(resolve=>setImmediate(resolve));
 f.setFail(false);await f.log.flush(true);assert.deepEqual(f.calls[1].body.events,f.calls[0].body.events);f.log.stop();
});
