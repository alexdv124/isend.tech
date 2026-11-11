import {DirectFileStore,savePicker,shouldSaveDirect,type SaveHandle} from './direct-file-store';
import type {PayloadKind} from './clipboard';
export type DiskRecord={key:string;room:string;id:string;name:string;size:number;blockSize:number;offset:number;complete:boolean;updatedAt:number;payloadKind?:PayloadKind;destination?:'file';savedName?:string};
export type StoredEntry={key:string;room:string;id:string;name:string;size:number;bytes:number;complete:boolean;updatedAt:number};
export type StorageInventory={usage:number|null;quota:number|null;entries:StoredEntry[]};
export class DiskStore{
  private worker:Worker;
  private direct:DirectFileStore;
  preferDirect=false;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  constructor(private room:string){
    this.direct=new DirectFileStore(room);
    this.worker=new Worker('/storage-worker.js?v=22');
    this.worker.onmessage=e=>{const p=this.pending.get(e.data.request);if(!p)return;this.pending.delete(e.data.request);if(e.data.error)p.reject(new Error(e.data.error));else p.resolve(e.data.result);};
    this.worker.onerror=()=>{for(const p of this.pending.values())p.reject(new Error('Не удалось открыть локальное хранилище. Обновите страницу.'));this.pending.clear();};
  }
  private call<T>(op:string,values:Record<string,unknown>={},transfer:Transferable[]=[]):Promise<T>{
    return new Promise((resolve,reject)=>{const request=++this.sequence;this.pending.set(request,{resolve,reject});this.worker.postMessage({op,room:this.room,request,...values},transfer);});
  }
  list(){return this.call<DiskRecord[]>('list');}
  inventory(){return this.call<StorageInventory>('inventory');}
  storedFile(key:string){return this.call<File>('stored-file',{key});}
  removeStored(key:string){return this.call<boolean>('remove-stored',{key});}
  async needsDestination(meta:{id:string;size:number;payloadKind?:PayloadKind}){
    if(this.direct.has(meta.id)||meta.payloadKind==='text'||!savePicker())return false;
    const estimate=await navigator.storage?.estimate().catch(()=>null);
    return shouldSaveDirect(meta.size,this.preferDirect,estimate?.quota===undefined?undefined:Math.max(0,estimate.quota-(estimate.usage||0)));
  }
  attachDestination(meta:{id:string;name:string;size:number;blockSize:number},handle:SaveHandle){return this.direct.attach(meta,handle);}
  discardDestination(id:string){return this.direct.discard(id);}
  clearDestinations(){return this.direct.clear();}
  release(id:string){return this.direct.has(id)?this.direct.release(id):this.call<boolean>('release',{id});}
  open(meta:{id:string;name:string;size:number;blockSize:number;payloadKind?:PayloadKind}){return this.direct.has(meta.id)?this.direct.open(meta):this.call<DiskRecord>('open',{id:meta.id,meta});}
  async write(id:string,offset:number,buffer:ArrayBuffer,hash:string,checkpoint=true){
    const end=offset+buffer.byteLength;
    const record=await (this.direct.has(id)?this.direct.write(id,offset,buffer,hash,checkpoint):this.call<DiskRecord>('write',{id,offset,buffer,hash,checkpoint},[buffer]));
    if(record.id!==id||record.offset!==end||end>record.size)throw new Error('Браузер вернул неверную позицию записи. Передача приостановлена для защиты файла.');
    return record;
  }
  complete(id:string){return this.direct.has(id)?this.direct.complete(id):this.call<DiskRecord>('complete',{id});}
  file(id:string){return this.call<File>('file',{id});}
  remove(id:string){return this.call<boolean>('remove',{id});}
  stop(){this.direct.stop();this.worker.terminate();for(const p of this.pending.values())p.reject(new Error('Stopped'));this.pending.clear();}
}
