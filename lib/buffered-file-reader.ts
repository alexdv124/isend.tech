export const READ_BATCH_BYTES=2*1024*1024;
type Chunk={offset:number;bytes:Uint8Array<ArrayBuffer>};
type ReadResult={chunk:Chunk;error?:never}|{error:Error;chunk?:never};

// Keep one current batch and one read ahead, independent of the file's size.
// Android document providers can make reopening a slice much more expensive
// than reading its bytes. Wire blocks and durable checkpoints stay unchanged.
export class BufferedFileReader{
  private current:Chunk|null=null;
  private next:Promise<ReadResult>|null=null;
  private stopped=false;
  private cursor:number;
  private readMs=0;
  private readBytes=0;
  constructor(private file:Blob,offset:number){
    if(!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw new Error('Неверная позиция чтения.');
    this.cursor=offset;
    if(offset<file.size)this.next=this.load(offset);
  }
  get millisecondsPerMiB(){return this.readBytes?this.readMs/(this.readBytes/1048576):null;}
  private async load(offset:number):Promise<ReadResult>{
    try{
      const length=Math.min(READ_BATCH_BYTES,this.file.size-offset),started=performance.now();
      const buffer=await this.file.slice(offset,offset+length).arrayBuffer();
      if(this.stopped)throw new Error('Чтение остановлено.');
      if(buffer.byteLength!==length)throw new Error('Не удалось прочитать файл полностью.');
      this.readMs+=performance.now()-started;this.readBytes+=buffer.byteLength;
      return {chunk:{offset,bytes:new Uint8Array(buffer)}};
    }catch(error){return {error:error instanceof Error?error:new Error('Не удалось прочитать файл.')};}
  }
  async read(offset:number,length:number):Promise<Uint8Array<ArrayBuffer>>{
    if(this.stopped)throw new Error('Чтение остановлено.');
    if(offset!==this.cursor||!Number.isSafeInteger(length)||length<=0||offset+length>this.file.size)throw new Error('Неверная позиция чтения.');
    if(!this.current||offset===this.current.offset+this.current.bytes.byteLength){
      // Drop the old batch before accepting another one. Only the pump calls read.
      this.current=null;
      if(!this.next)throw new Error('Нет данных для чтения.');
      const result=await this.next;
      if(this.stopped)throw new Error('Чтение остановлено.');
      this.next=null;
      if(result.error)throw result.error;
      this.current=result.chunk;
      const nextOffset=this.current.offset+this.current.bytes.byteLength;
      if(nextOffset<this.file.size)this.next=this.load(nextOffset);
    }
    const relative=offset-this.current.offset;
    if(relative<0||relative+length>this.current.bytes.byteLength)throw new Error('Блок выходит за границу чтения.');
    this.cursor+=length;
    return this.current.bytes.subarray(relative,relative+length);
  }
  dispose(){this.stopped=true;this.current=null;this.next=null;}
}
