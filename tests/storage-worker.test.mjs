import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=await readFile(process.env.ISEND_STORAGE_WORKER||new URL('../public/storage-worker.js',import.meta.url),'utf8');
const B=262144,room='a'.repeat(48),id='b'.repeat(48),key=room+'-'+id;
const digest=async data=>Buffer.from(await webcrypto.subtle.digest('SHA-256',data)).toString('hex');
function fixture(){
 const records=new Map(),files=new Map(),writes=[];let resultOverride,seq=0;
 const database={transaction(){
  const tx={objectStore(){const req=operation=>{const r={};queueMicrotask(()=>{r.result=operation();r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;};
   return {get:k=>req(()=>structuredClone(records.get(k))),put:r=>{const copy=structuredClone(r);return req(()=>records.set(r.key,copy));},getAll:()=>req(()=>structuredClone([...records.values()])),delete:k=>req(()=>records.delete(k))};}};return tx;
 }};
 const directory={async getFileHandle(k){let file=files.get(k);if(!file){file={size:0,bytes:new Uint8Array(0)};files.set(k,file);}
  const resize=n=>{assert(n<64*B,'unexpected huge file allocation');const copy=new Uint8Array(n);copy.set(file.bytes.subarray(0,n));file.bytes=copy;file.size=n;};
  return {async createSyncAccessHandle(){return {getSize:()=>file.size,truncate:resize,flush(){},close(){},write(bytes,{at}){assert(writes.length<128,'write loop exceeded test bound');writes.push({at,length:bytes.length});const n=resultOverride===undefined?bytes.length:resultOverride;
    if(Number.isSafeInteger(n)&&n>0&&n<=bytes.length){if(at+n>file.size)resize(at+n);file.bytes.set(bytes.subarray(0,n),at);}return n;}};},async getFile(){return new Blob([file.bytes]);}};
 }};
 const pending=new Map();const context=vm.createContext({ArrayBuffer,Uint8Array,crypto:webcrypto,Date,DOMException,console,navigator:{storage:{getDirectory:async()=>({getDirectoryHandle:async()=>directory}),estimate:async()=>({quota:1e12,usage:0})}},fakeDatabase:database,postMessage:v=>pending.get(v.request)?.(v)});
 vm.runInContext(source+'\ndatabase=fakeDatabase;',context);
 const call=values=>new Promise(resolve=>{const request=++seq;pending.set(request,resolve);context.onmessage({data:{room,id,request,...values}});});
 return {records,files,writes,call,setWriteResult(n){resultOverride=n;},async open(size=8*B){return call({op:'open',meta:{id,name:'fixture.bin',size,blockSize:B}});},async write(offset,checkpoint=false){const bytes=new Uint8Array(B).fill(offset/B+1);return call({op:'write',offset,buffer:bytes.buffer,hash:await digest(bytes),checkpoint});}};
}
test('Chromium unsigned -8 cannot advance the offset past the file size',async()=>{
 const f=fixture();await f.open();await f.write(0);await f.write(B);
 f.setWriteResult(2**32-8);const r=await f.write(2*B);
 assert.equal(r.result?.offset,undefined,'unsafe reported offset: '+r.result?.offset);
 assert.match(r.error||'',/хранилище браузера получателя/);
 assert.equal(r.result,undefined);assert.equal(f.records.get(key).offset,0);assert.equal(f.files.get(key).size,0);
 f.setWriteResult(undefined);assert.equal((await f.open()).result.offset,0);
 assert.equal((await f.write(0,true)).result.offset,B);
});
test('invalid write counts never become durable positions; short writes finish exactly',async()=>{
 for(const count of [-8,-1,0,1.5,NaN,Infinity,B+1,2**32-1]){
  const f=fixture();await f.open();f.setWriteResult(count);const r=await f.write(0,true);
  assert(r.error,'accepted '+count);assert.equal(f.records.get(key).offset,0);assert.equal(f.files.get(key).size,0);
 }
 const f=fixture();await f.open();f.setWriteResult(B/4);const r=await f.write(0,true);
 assert.equal(r.result.offset,B);assert.equal(f.writes.length,4);assert.equal(f.records.get(key).offset,B);
});
test('failed write keeps the previous durable checkpoint for retry',async()=>{
 const f=fixture();await f.open();for(let i=0;i<4;i++)await f.write(i*B,i===3);
 await f.write(4*B);f.setWriteResult(2**32-8);assert((await f.write(5*B)).error);
 assert.equal(f.records.get(key).offset,4*B);assert.equal(f.files.get(key).size,4*B);
 f.setWriteResult(undefined);assert.equal((await f.open()).result.offset,4*B);
});
test('opening a legacy invalid checkpoint never expands the partial file',async()=>{
 const f=fixture();await f.open();const r=f.records.get(key);r.offset=4295491576;f.records.set(key,r);
 const reopened=await f.open();assert.equal(reopened.result.offset,0);assert.equal(f.files.get(key).size,0);
});
test('valid final partial and completed files retain their checkpoints',async()=>{
 const f=fixture();await f.open(B+17);await f.write(0,true);const bytes=new Uint8Array(17).fill(19);
 assert.equal((await f.call({op:'write',offset:B,buffer:bytes.buffer,hash:await digest(bytes),checkpoint:true})).result.offset,B+17);
 assert.equal((await f.call({op:'complete'})).result.complete,true);assert.equal((await f.open(B+17)).result.offset,B+17);
});
