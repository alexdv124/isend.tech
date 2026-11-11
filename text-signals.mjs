// Bounded, short-lived SDP only. Clipboard contents never enter HTTP signaling.
export class TextSignals{
  constructor({now=Date.now,max=2048}={}){this.now=now;this.max=max;this.entries=new Map();}
  sweep(){for(const [key,v]of this.entries)if(this.now()-v.at>120000)this.entries.delete(key);}
  put(room,from,to,signal){this.sweep();const key=room+from+to;if(!this.entries.has(key)&&this.entries.size>=this.max)return false;this.entries.set(key,{room,from,to,...signal,at:this.now()});return true;}
  get(room,to){this.sweep();return [...this.entries.values()].filter(v=>v.room===room&&v.to===to).map(({room,...value})=>value);}
}
