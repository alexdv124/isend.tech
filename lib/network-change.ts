export type NetworkInformation = EventTarget & {type?: string};
type Timer = ReturnType<typeof setTimeout>;
type Scheduler = {set:(callback:()=>void,ms:number)=>Timer;clear:(timer:Timer)=>void};

// A bandwidth/effectiveType update is not a network handover. Restart only
// for an actual interface type change or an online event. Some browsers do
// not expose NetworkInformation.type; those retain online/offline recovery.
export function watchNetworkChanges(events:EventTarget,info:NetworkInformation|undefined,changed:()=>void,
  scheduler:Scheduler={set:(fn,ms)=>setTimeout(fn,ms),clear:clearTimeout}){
  let previous=info?.type,timer:Timer|undefined,stopped=false;
  const clear=()=>{if(timer!==undefined)scheduler.clear(timer);timer=undefined;};
  const schedule=()=>{
    clear();timer=scheduler.set(()=>{timer=undefined;if(!stopped)changed();},750);
  };
  const onChange=()=>{
    const next=info?.type,old=previous;previous=next;
    if(next==='none'){clear();return;}
    if(next&&next!=='unknown'&&next!==old)schedule();
  };
  const onOnline=()=>{previous=info?.type;schedule();};
  events.addEventListener('online',onOnline);
  events.addEventListener('offline',clear);
  info?.addEventListener('change',onChange);
  return ()=>{stopped=true;clear();events.removeEventListener('online',onOnline);events.removeEventListener('offline',clear);info?.removeEventListener('change',onChange);};
}
