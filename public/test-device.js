'use strict';
const token=location.hash.slice(1),statusNode=document.getElementById('status'),retry=document.getElementById('retry');
history.replaceState(null,'',location.pathname);
async function mark(){
  retry.hidden=true;
  try{
    let identity=localStorage.getItem('isend-browser-key');
    if(!/^[a-f0-9]{48}$/.test(identity||'')){
      if(!/^[a-f0-9]{48}$/.test(token))throw new Error('Откройте специальную ссылку владельца, чтобы отметить этот браузер.');
      identity=Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');localStorage.setItem('isend-browser-key',identity);
    }
    const response=await fetch('/api/internal-device',{method:token?'POST':'GET',headers:{'X-Isend-Identity':identity,...(token?{'Content-Type':'application/json'}:{})},...(token?{body:JSON.stringify({token})}:{}),cache:'no-store',signal:AbortSignal.timeout(12000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить отметку.');
    statusNode.textContent=result.internal?'Готово. Этот браузер отмечен как наш тестовый. Его посещения и передачи будут учитываться отдельно; доступная история тоже пересчитается.':'Этот браузер пока не отмечен. Откройте специальную ссылку владельца.';
  }catch(e){statusNode.textContent=e instanceof Error?e.message:'Не удалось сохранить отметку.';retry.hidden=false;}
}
retry.addEventListener('click',mark);void mark();
