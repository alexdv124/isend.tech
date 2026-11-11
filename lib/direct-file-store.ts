import type {DiskRecord} from './disk-store';

export type SaveHandle={name:string;createWritable(options?:{keepExistingData?:boolean}):Promise<FileSystemWritableFileStream>};
export type SavePicker=(options:{suggestedName:string})=>Promise<SaveHandle>;
export function savePicker():SavePicker|undefined{
  return (globalThis as typeof globalThis&{showSaveFilePicker?:SavePicker}).showSaveFilePicker;
}
export function shouldSaveDirect(size:number,prefer:boolean,available?:number){
  return prefer||size>=512*1024*1024||(available!==undefined&&size>available);
}
type Entry={record:DiskRecord;stream:FileSystemWritableFileStream;checkpoint:number;failed:boolean};
// User-visible files are transactional: write() writes a temporary disk file;
// close() commits it. Checkpoints here survive NETWORK reconnects in this page,
// not page termination. Never persist these offsets or report completion early.
export class DirectFileStore{
  private entries=new Map<string,Entry>();private queue:Promise<unknown>=Promise.resolve();private stopped=false;
  constructor(private room:string){}
  has(id:string){return this.entries.has(id);}
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const task=this.queue.then(fn);this.queue=task.catch(()=>{});return task;}
  private entry(id:string){const e=this.entries.get(id);if(!e||e.failed||this.stopped)throw new Error('Запись в выбранный файл прервана. Отправьте файл заново.');return e;}
  async attach(meta:{id:string;name:string;size:number;blockSize:number},handle:SaveHandle){
    return this.serial(async()=>{
      if(this.stopped)throw new Error('Передача остановлена.');
      if(this.has(meta.id))return {...this.entry(meta.id).record};
      const stream=await handle.createWritable({keepExistingData:false});
      if(this.stopped){await stream.abort();throw new Error('Передача остановлена.');}
      const record:DiskRecord={...meta,key:this.room+'-'+meta.id,room:this.room,offset:0,complete:false,updatedAt:Date.now(),destination:'file',savedName:handle.name};
      this.entries.set(meta.id,{record,stream,checkpoint:0,failed:false});return {...record};
    });
  }
  open(meta:{id:string;name:string;size:number;blockSize:number}){return this.serial(async()=>{
    const e=this.entry(meta.id),r=e.record;
    if(meta.name!==r.name||meta.size!==r.size||meta.blockSize!==r.blockSize)throw new Error('Параметры возобновляемого файла изменились.');
    return {...r};
  });}
  write(id:string,offset:number,buffer:ArrayBuffer,hash:string,checkpoint:boolean){return this.serial(async()=>{
    const e=this.entry(id),r=e.record;
    if(r.complete||offset!==r.offset||buffer.byteLength!==Math.min(r.blockSize,r.size-offset))throw new Error('Неверная последовательность блоков.');
    const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==actual)throw new Error('Не совпала контрольная сумма блока.');
    try{await e.stream.write({type:'write',position:offset,data:buffer});}
    catch(error){e.failed=true;try{await e.stream.abort();}catch{}throw error;}
    r.offset=offset+buffer.byteLength;r.updatedAt=Date.now();if(checkpoint)e.checkpoint=r.offset;
    return {...r};
  });}
  release(id:string){return this.serial(async()=>{
    const e=this.entries.get(id);if(!e||e.failed||e.record.complete)return;
    // Serialize with in-flight writes before discarding an unacknowledged tail.
    try{await e.stream.truncate(e.checkpoint);e.record.offset=e.checkpoint;}
    catch(error){e.failed=true;try{await e.stream.abort();}catch{}throw error;}
  });}
  complete(id:string){return this.serial(async()=>{
    const e=this.entry(id);if(e.record.complete)return {...e.record};
    if(e.record.offset!==e.record.size)throw new Error('Файл получен не полностью.');
    try{await e.stream.close();}catch(error){e.failed=true;try{await e.stream.abort();}catch{}throw error;}
    e.record.complete=true;return {...e.record};
  });}
  discard(id:string){return this.serial(async()=>{
    const e=this.entries.get(id);if(!e)return;
    if(!e.record.complete)try{await e.stream.abort();}catch{}
    this.entries.delete(id);
  });}
  async clear(){for(const id of [...this.entries.keys()])await this.discard(id);}
  stop(){this.stopped=true;void this.clear();}
}
