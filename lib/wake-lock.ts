import {useEffect,useState} from 'react';
export function useScreenAwake(active:boolean){
  const [state,setState]=useState<'idle'|'held'|'unavailable'>('idle');
  useEffect(()=>{
    let stopped=false,pending=false,lock:WakeLockSentinel|undefined;
    const acquire=async()=>{
      if(!active||stopped||pending||lock||document.hidden)return;
      if(!navigator.wakeLock){setState('unavailable');return;}
      pending=true;
      try{const next=await navigator.wakeLock.request('screen');if(stopped){await next.release();return;}lock=next;setState('held');next.addEventListener('release',()=>{lock=undefined;if(!stopped)setState('unavailable');});}
      catch{if(!stopped)setState('unavailable');}finally{pending=false;}
    };
    if(active)void acquire();else setState('idle');
    const visible=()=>{if(!document.hidden)void acquire();};document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;document.removeEventListener('visibilitychange',visible);void lock?.release().catch(()=>{});};
  },[active]);
  return state;
}
