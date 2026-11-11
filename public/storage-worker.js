/* File bytes stay in the origin-private filesystem on the receiving device.
   Writes stream immediately; a batch is acknowledged only after flush and an
   atomic IndexedDB checkpoint. A restart discards any uncommitted tail. */
let queue=Promise.resolve(), database, directory, opened;
const valid=/^[a-f0-9]{48}$/;
const storageFull='Недостаточно места в хранилище браузера получателя. Откройте «Хранилище сайта» на получателе, удалите ненужные копии и повторите отправку.';
async function init(){
  if(!navigator.storage?.getDirectory)throw new Error('Этот браузер не поддерживает запись на диск. Откройте ссылку в свежем Chrome, Edge или Safari.');
  directory ||= await (await navigator.storage.getDirectory()).getDirectoryHandle('perebros-v3',{create:true});
  database ||= await new Promise((resolve,reject)=>{
    const request=indexedDB.open('perebros-checkpoints-v3',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'key'});
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
function db(mode,action){return new Promise((resolve,reject)=>{
  const tx=database.transaction('files',mode,{durability:'strict'});
  const req=action(tx.objectStore('files'));let result;
  req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);
  tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Не удалось сохранить позицию файла.'));
});}
const get=key=>db('readonly',s=>s.get(key));
const put=record=>db('readwrite',s=>s.put(record));
function validCheckpoint(record){
  return record&&Number.isSafeInteger(record.size)&&record.size>=0&&Number.isSafeInteger(record.offset)&&record.offset>=0&&record.offset<=record.size&&
    (record.offset===record.size||record.offset%262144===0)&&(!record.complete||record.offset===record.size);
}
function close(){const current=opened;opened=null;if(current)current.handle.close();}
async function release(){
  if(!opened)return;
  const current=opened;
  try{
    const saved=await get(current.key);
    // Never keep a failed write's in-memory offset as a resume checkpoint.
    const offset=validCheckpoint(saved)?saved.offset:0;
    current.handle.truncate(offset);current.handle.flush();
    if(saved&&!validCheckpoint(saved))await put({...saved,offset:0,complete:false,updatedAt:Date.now()});
  }finally{close();}
}
async function inventory(){
  const estimate=await navigator.storage.estimate(),records=await db('readonly',s=>s.getAll()),entries=[];
  const byKey=new Map(records.map(r=>[r.key,r]));
  for await(const [key,file] of directory.entries()){
    if(file.kind!=='file'||!/^[a-f0-9]{48}-[a-f0-9]{48}$/.test(key))continue;
    const record=byKey.get(key);let bytes=record?.offset||0;
    try{bytes=(await file.getFile()).size;}catch{/* A busy file still has a durable checkpoint. */}
    entries.push({key,room:key.slice(0,48),id:key.slice(49),name:record?.name||'',size:record?.size||bytes,bytes,complete:record?.complete||false,updatedAt:record?.updatedAt||0});
  }
  return {usage:estimate.usage??null,quota:estimate.quota??null,entries:entries.sort((a,b)=>b.updatedAt-a.updatedAt)};
}
async function open(record){
  if(opened?.key===record.key)return opened.handle;
  close();
  const file=await directory.getFileHandle(record.key,{create:true});
  if(!file.createSyncAccessHandle)throw new Error('Этот браузер не поддерживает потоковую запись на диск. Используйте свежий Chrome или Edge.');
  const handle=await file.createSyncAccessHandle();opened={key:record.key,handle,record};return handle;
}
const digest=async buffer=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),x=>x.toString(16).padStart(2,'0')).join('');
async function action(data){
  await init();
  if(!valid.test(data.room))throw new Error('Неверная ссылка.');
  if(data.op==='inventory')return inventory();
  if(['stored-file','remove-stored'].includes(data.op)){
    if(!/^[a-f0-9]{48}-[a-f0-9]{48}$/.test(data.key))throw new Error('Неверный файл.');
    if(opened?.key===data.key)throw new Error('Файл сейчас используется. Остановите передачу перед удалением.');
    const stored=await get(data.key);
    if(data.op==='stored-file'){
      if(!stored?.complete)throw new Error('Файл ещё не получен.');
      return (await directory.getFileHandle(data.key)).getFile();
    }
    // removeEntry refuses a file locked by another receiving tab. Never bypass that lock.
    try{await directory.removeEntry(data.key);}catch(e){if(e.name!=='NotFoundError')throw e;}
    await db('readwrite',s=>s.delete(data.key));return true;
  }
  if(data.op==='list')return (await db('readonly',s=>s.getAll())).filter(r=>r.room===data.room);
  if(!valid.test(data.id))throw new Error('Неверный файл.');
  const key=`${data.room}-${data.id}`;
  if(data.op==='release'){if(opened?.key===key)await release();return true;}
  // Only the active write stream may use the uncommitted in-memory offset.
  // Reopen, completion and listing always consult the durable checkpoint.
  let record=data.op==='write'&&opened?.key===key?opened.record:await get(key);
  if(data.op==='open'){
    const m=data.meta;
    if(!Number.isSafeInteger(m.size)||m.size<0||m.blockSize!==262144||typeof m.name!=='string'||m.name.length>255)throw new Error('Неверный формат файла.');
    if(m.payloadKind!==undefined&&m.payloadKind!=='file'&&m.payloadKind!=='text')throw new Error('Неверный тип передачи.');
    if(m.payloadKind==='text'&&m.size>512*1024)throw new Error('Текст слишком большой. Отправьте его файлом.');
    if(record&&((record.payloadKind||'file')!==(m.payloadKind||'file')||record.size!==m.size||record.name!==m.name||record.blockSize!==m.blockSize))throw new Error('Параметры возобновляемого файла изменились.');
    // Older clients could persist an OS error code as a successful byte count.
    // Such a checkpoint cannot identify a verified prefix; restart this partial.
    if(record&&!validCheckpoint(record)){record.offset=0;record.complete=false;}
    const estimate=await navigator.storage.estimate();
    if(!record?.complete&&estimate.quota&&m.size-(record?.offset||0)>estimate.quota-(estimate.usage||0))throw new Error(storageFull);
    record ||= {key,room:data.room,id:data.id,name:m.name,size:m.size,blockSize:m.blockSize,payloadKind:m.payloadKind||'file',offset:0,complete:false,updatedAt:Date.now()};
    const handle=await open(record);opened.record=record;
    // Discard a flushed but uncommitted tail left by a terminated browser process.
    if(handle.getSize()<record.offset){record.offset=0;record.complete=false;}
    if(handle.getSize()!==record.offset){handle.truncate(record.offset);handle.flush();}
    await put(record);if(record.complete)close();return record;
  }
  if(!record)throw new Error('Часть файла больше недоступна на устройстве. Повторите отправку.');
  if(data.op==='write'){
    if(record.complete||data.offset!==record.offset||!(data.buffer instanceof ArrayBuffer)||data.buffer.byteLength!==Math.min(record.blockSize,record.size-record.offset)||!/^[a-f0-9]{64}$/.test(data.hash))throw new Error('Неверная последовательность блоков.');
    if(await digest(data.buffer)!==data.hash)throw new Error('Проверка блока не прошла. Повторите передачу.');
    const handle=await open(record),bytes=new Uint8Array(data.buffer);let written=0;
    while(written<bytes.length){
      const remaining=bytes.length-written,n=handle.write(bytes.subarray(written),{at:record.offset+written});
      // Chromium issue 541725401: a file error could be returned as a byte count
      // (NO_SPACE = -8, exposed as unsigned 4294967288). Never trust that count.
      if(n===-8||n===4294967288)throw new Error(storageFull);
      if(!Number.isSafeInteger(n)||n<=0||n>remaining)throw new Error('Браузер вернул неверный результат записи файла. Сохранённая часть не изменена. Повторите передачу в обновлённом браузере.');
      written+=n;
    }
    record.offset=data.offset+bytes.length;record.updatedAt=Date.now();
    if(data.checkpoint!==false){handle.flush();await put(record);}
    return record;
  }
  if(data.op==='complete'){
    if(record.offset!==record.size)throw new Error('Файл получен не полностью.');
    if(opened?.key===key){opened.handle.flush();close();}
    record.complete=true;record.updatedAt=Date.now();await put(record);return record;
  }
  if(data.op==='file'){
    if(!record.complete)throw new Error('Файл ещё не получен.');
    if(opened?.key===key)close();
    return (await directory.getFileHandle(key)).getFile();
  }
  if(data.op==='remove'){
    if(opened?.key===key)close();
    try{await directory.removeEntry(key);}catch(e){if(e.name!=='NotFoundError')throw e;}
    await db('readwrite',s=>s.delete(key));return true;
  }
  throw new Error('Unknown operation');
}
onmessage=event=>{
  const {request,...data}=event.data;
  queue=queue.then(async()=>{
    try{postMessage({request,result:await action(data)});}
    catch(error){
      if(['open','write','complete'].includes(data.op))try{await release();}catch{/* Preserve the original error; reopening uses the durable checkpoint. */}
      const text=error.name==='QuotaExceededError'?storageFull:error.name==='NoModificationAllowedError'?'Файл сейчас используется. Остановите передачу перед удалением.':error.message;
      postMessage({request,error:text||'Не удалось записать файл на устройство.'});
    }
  });
};
