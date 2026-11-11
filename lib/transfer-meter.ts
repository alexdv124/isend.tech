export type TransferMeasurement={
  bytesPerSecond:number|null;averageBytesPerSecond:number|null;remainingSeconds:number|null;
  elapsedSeconds:number;offset:number;total:number;complete:boolean;paused:boolean;
};

// Measure durable file progress, never bytes merely queued in RTCDataChannel.
// A fresh meter on reconnect excludes bytes already present on the receiver.
export class TransferMeter{
  private offset:number;
  private samples:{at:number;offset:number}[];
  private finishedAt:number|null=null;
  constructor(private baseline:number,private total:number,private startedAt:number){
    this.offset=baseline;this.samples=[{at:startedAt,offset:baseline}];
  }
  advance(offset:number){if(Number.isSafeInteger(offset)&&offset>=this.offset&&offset<=this.total)this.offset=offset;}
  finish(now:number){this.finishedAt=now;}
  sample(now:number,paused=false):TransferMeasurement{
    const at=this.finishedAt??now,complete=this.finishedAt!==null;
    if(at>this.samples.at(-1)!.at)this.samples.push({at,offset:this.offset});
    while(this.samples.length>2&&this.samples[1].at<=at-3000)this.samples.shift();
    const first=this.samples[0],elapsed=(at-this.startedAt)/1000,windowSeconds=(at-first.at)/1000;
    const average=elapsed>0&&this.offset>this.baseline?(this.offset-this.baseline)/elapsed:null;
    const speed=paused?0:complete?average:elapsed<.3?null:windowSeconds>0?(this.offset-first.offset)/windowSeconds:0;
    return {bytesPerSecond:speed,averageBytesPerSecond:average,remainingSeconds:complete?0:speed&&speed>0?(this.total-this.offset)/speed:null,elapsedSeconds:elapsed,offset:this.offset,total:this.total,complete,paused};
  }
}

export function formatRate(bytesPerSecond:number){
  return `${(Math.max(0,bytesPerSecond)/1048576).toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:2})} МБ/с`;
}
export function formatDuration(seconds:number){
  const value=Math.max(1,Math.ceil(seconds));
  if(value<60)return `${value} с`;
  if(value<3600)return `${Math.floor(value/60)} мин ${value%60} с`;
  return `${Math.floor(value/3600)} ч ${Math.floor(value%3600/60)} мин`;
}
