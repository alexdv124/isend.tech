export type TextRecord={key:string;room:string;id:string;text:string;size:number;updatedAt:number};
// Separate store/transactions: a text never waits for the large-file OPFS writer.
export class ClipboardStore{
  private db:Promise<IDBDatabase>;
  constructor(private room:string){
    this.db=new Promise((resolve,reject)=>{const req=indexedDB.open('perebros-text-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('texts',{keyPath:'key'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    void this.db.catch(()=>{});
  }
  async list():Promise<TextRecord[]>{const db=await this.db;return new Promise((resolve,reject)=>{const req=db.transaction('texts').objectStore('texts').getAll();req.onsuccess=()=>resolve(req.result.filter((r:TextRecord)=>r.room===this.room));req.onerror=()=>reject(req.error);});}
  async save(id:string,text:string,size:number){
    const db=await this.db,record:TextRecord={key:this.room+'-'+id,room:this.room,id,text,size,updatedAt:Date.now()};
    return new Promise<TextRecord>((resolve,reject)=>{const tx=db.transaction('texts','readwrite',{durability:'strict'}),s=tx.objectStore('texts'),req=s.get(record.key);let result=record;
      req.onsuccess=()=>{if(req.result){if(req.result.text!==text){tx.abort();return;}result=req.result;}else s.put(record);};
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Не удалось сохранить текст.'));});
  }
  async clear(){const db=await this.db;return new Promise<void>((resolve,reject)=>{const tx=db.transaction('texts','readwrite'),s=tx.objectStore('texts'),req=s.openCursor();req.onsuccess=()=>{const cursor=req.result;if(cursor){if(cursor.value.room===this.room)cursor.delete();cursor.continue();}};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
  stop(){void this.db.then(db=>db.close()).catch(()=>{});}
}
