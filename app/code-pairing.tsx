import {useEffect,useRef,useState} from 'react';
import {Link,LoaderCircle,X} from 'lucide-react';
import type {PairingState} from '@/lib/browser-identity';
import {useLanguage} from '@/lib/language';

const messages:Record<string,[string,string]>={
  code_invalid:['Код неверный, уже использован или истёк. Проверьте второе устройство.','This code is incorrect, already used or expired. Check the other device.'],
  code_self:['Это код этого браузера. Введите код с другого устройства.','This is this browser’s code. Enter the code from your other device.'],
  pair_rate_limited:['Слишком много попыток. Подождите до 10 минут и попробуйте снова.','Too many attempts. Wait up to 10 minutes and try again.'],
  pair_pending:['Сначала завершите или отмените предыдущее знакомство.','Finish or cancel the current pairing first.'],
  request_expired:['Запрос уже закрыт или истёк. Получите новый код.','This request has ended or expired. Get a new code.'],
  already_paired:['Это устройство уже запомнено. Найдите его в списке устройств.','This device is already remembered. Look for it in Your devices.'],
  pair_storage_unavailable:['Разрешите сайту сохранять данные в браузере, чтобы запомнить устройство.','Allow this site to store browser data to remember devices.'],
  pair_limit:['Список устройств заполнен. Забудьте ненужное устройство и повторите.','Your device list is full. Forget an unused device and try again.'],
  codes_busy:['Все короткие коды сейчас заняты. Попробуйте чуть позже.','Short codes are busy. Try again shortly.'],
  pair_save_failed:['Не удалось запомнить связь. Подтверждение не сохранено — попробуйте снова.','Could not save the pairing. It has not been approved. Please try again.'],
};

export function CodePairing({state,onAction,disabled,ownDevice,hasPeers}:{state:PairingState|null;onAction:(action:string,extra?:Record<string,string>)=>Promise<unknown>;disabled:boolean;ownDevice:string;hasPeers:boolean}){
  const {t}=useLanguage();
  const [open,setOpen]=useState(false),[value,setValue]=useState(''),[error,setError]=useState(''),[waiting,setWaiting]=useState(false),[now,setNow]=useState(Date.now()),[forget,setForget]=useState(''),[dismissed,setDismissed]=useState(''),[complete,setComplete]=useState(false);
  const [hintVisible,setHintVisible]=useState(false),[hintDismissed,setHintDismissed]=useState(false);
  const inFlight=useRef(false),clock=useRef({server:state?.now||Date.now(),local:Date.now()}),decline=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLElement>(null);
  useEffect(()=>{if(state)clock.current={server:state.now,local:Date.now()};},[state?.now]);
  useEffect(()=>{const timer=setInterval(()=>setNow(clock.current.server+Date.now()-clock.current.local),500);return()=>clearInterval(timer);},[]);
  const pending=state?.requests.filter(r=>r.state==='pending'&&r.expires>now)||[],incoming=pending.find(r=>r.direction==='incoming'),outgoing=pending.find(r=>r.direction==='outgoing');
  const hintEligible=!hasPeers&&!open&&!disabled&&!pending.length&&!hintDismissed;
  useEffect(()=>{
    if(!hintEligible){setHintVisible(false);return;}
    const timer=setTimeout(()=>setHintVisible(true),3000);
    return()=>clearTimeout(timer);
  },[hintEligible]);
  function dismissHint(){setHintVisible(false);setHintDismissed(true);}
  const recent=state?.requests.filter(r=>r.expires>now&&r.id!==dismissed).at(-1);
  useEffect(()=>{if(recent?.state==='accepted'){setComplete(true);setValue('');}},[recent?.id,recent?.state]);
  const code=state?.code&&state.code.expires>now?state.code:null;
  const label=(p:{name:string;id:string})=>`${p.name==='Телефон'?t('Телефон','Phone'):t('Компьютер','Computer')} · ${p.id.slice(0,4)}`;
  const seconds=(expires:number)=>{const n=Math.min(120,Math.max(0,Math.ceil((expires-now)/1000)));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};
  useEffect(()=>{
    if(!incoming)return;const previous=document.activeElement as HTMLElement|null;decline.current?.focus();
    const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const buttons=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[]);if(!buttons.length){event.preventDefault();return;}const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
    document.addEventListener('keydown',trap);return()=>{document.removeEventListener('keydown',trap);previous?.focus();};
  },[incoming?.id]);
  async function action(name:string,extra:Record<string,string>={}){
    if(inFlight.current)return false;inFlight.current=true;setWaiting(true);setError('');
    try{await onAction(name,extra);return true;}catch(e){const pair=messages[e instanceof Error?e.message:''];setError(pair?t(...pair):t('Не удалось связаться с сервером. Попробуйте снова.','Could not reach the server. Please try again.'));return false;}
    finally{inFlight.current=false;setWaiting(false);}
  }
  async function submit(next=value){if(/^\d{4}$/.test(next))await action('lookup',{code:next});}
  async function close(){if(await action('close')){setDismissed(recent?.id||'');setOpen(false);setComplete(false);setValue('');}}
  return <section className="code-pairing" aria-label={t('Знакомство устройств','Pair devices')}>
    <div className="pair-code-entrypoint">
      {hintVisible&&hintEligible&&<div className="pair-code-hint" data-testid="pair-code-hint">
        <p id="pair-code-hint-text" role="status">{t('Не обнаруживается устройство? Познакомь их с помощью четырёх цифр :)','Can’t find your other device? Pair them with four digits :)')}</p>
        <button type="button" className="pair-hint-close" aria-label={t('Скрыть подсказку','Dismiss hint')} onClick={dismissHint}><X size={16}/></button>
        <svg className="pair-hint-arrow" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2v17m-6-6 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>}
      <button className="secondary" aria-expanded={open} aria-describedby={hintVisible&&hintEligible?'pair-code-hint-text':undefined} onClick={()=>{dismissHint();setOpen(!open);setError('');if(!open&&!pending.length&&!code){setDismissed(recent?.id||'');setComplete(false);void action('create');}}} disabled={disabled||waiting}><Link size={16}/>{t('Подключить по коду','Connect with a code')}</button>
    </div>
    {open&&<div className="code-pairing-body">
      <p>{t('Работает между разными сетями и с VPN. Достаточно познакомить устройства один раз.','Works across networks and with VPNs. Pair your devices once.')}</p>
      {outgoing?<div className="pair-wait" role="status"><LoaderCircle className="spin" size={18}/><strong>{t('Подтвердите на другом устройстве','Confirm on the other device')}</strong><p>{label(outgoing.peer)}<br/>{t('Там должен быть запрос от устройства','Look for a request from device')} <b>{ownDevice.slice(0,4)}</b>.</p><small>{t('Осталось','Time left')} {seconds(outgoing.expires)}</small><button className="text-button" disabled={waiting} onClick={()=>void action('cancel',{request:outgoing.id})}>{t('Отменить','Cancel')}</button></div>:
        (complete||recent?.state==='accepted')?<><p className="pair-complete" role="status">{t('Устройства связаны и запомнены. Теперь они найдут друг друга автоматически.','Devices paired and remembered. They will find each other automatically.')}</p><button className="secondary" onClick={()=>{setDismissed(recent?.id||'');setComplete(false);setValue('');void action('create');}}>{t('Подключить ещё устройство','Pair another device')}</button></>:
        incoming?<p role="status">{t('Подтвердите запрос ниже.','Confirm the request below.')}</p>:<>
          {recent&&['declined','cancelled'].includes(recent.state)&&<p role="status">{recent.state==='declined'?t('Подключение отклонено. Можно получить новый код.','Pairing declined. You can get a new code.'):t('Запрос отменён.','Request cancelled.')}</p>}
          <div className="own-code">{code?<><span>{t('Код этого устройства','This device’s code')}</span><output data-testid="pair-code" aria-label={t('Код подключения','Pairing code')}>{code.value}</output><span>{t('Введите на другом устройстве','Enter on the other device')}</span><small>{t('Действует ещё','Expires in')} {seconds(code.expires)}</small></>:<><p role="status">{waiting?t('Получаем код…','Getting a code…'):t('Код истёк или уже использован.','This code has expired or was used.')}</p><button className="secondary" disabled={waiting||disabled} onClick={()=>void action('create')}>{t('Получить новый код','Get a new code')}</button></>}</div>
          <form className="code-entry" onSubmit={e=>{e.preventDefault();void submit();}}><label htmlFor="pair-code-input">{t('Или введите код другого устройства','Or enter the other device’s code')}</label><input id="pair-code-input" type="text" inputMode="numeric" pattern="[0-9]{4}" autoComplete="off" maxLength={4} value={value} disabled={waiting||disabled} placeholder="0000" onChange={e=>{const next=e.target.value.replace(/\D/g,'').slice(0,4);setValue(next);setError('');if(next.length===4)void submit(next);}}/>{value.length===4&&<button className="secondary" disabled={waiting||disabled}>{waiting?<LoaderCircle className="spin" size={16}/>:null}{t('Подключить','Connect')}</button>}</form>
        </>}
      <p className="code-privacy">{t('Связь сохраняется в этом браузере. После очистки данных сайта понадобится новый код.','Pairing stays in this browser. If you clear site data, you’ll need to pair again.')}</p>
      <button className="text-button" disabled={waiting} onClick={()=>void close()}><X size={13}/>{t('Закрыть','Close')}</button>
    </div>}
    {error&&<p className="discovery-error" role="alert">{error}</p>}
    {!!state?.remembered.length&&<details className="remembered-devices"><summary>{t('Запомненные устройства','Remembered devices')} · {state.remembered.length}</summary>{state.remembered.map(p=><div className="remembered-row" key={p.id}><span><strong>{label(p.peer)}</strong><small>{p.online?t('Сайт открыт','Site is open'):t('Откройте сайт на этом устройстве','Open this site on that device')}</small></span>{forget===p.id?<div><p>{t('Забыть связь на обоих устройствах?','Forget this pairing on both devices?')}</p><button className="text-button" disabled={waiting||disabled} onClick={()=>void action('forget',{pair:p.id}).then(ok=>{if(ok)setForget('');})}>{t('Да, забыть','Yes, forget')}</button><button className="text-button" onClick={()=>setForget('')}>{t('Отмена','Cancel')}</button></div>:<button className="text-button" disabled={disabled} onClick={()=>setForget(p.id)}>{t('Забыть','Forget')}</button>}</div>)}</details>}
    {incoming&&<div className="approval-overlay pairing-overlay"><section ref={dialog} className="approval-card" role="dialog" aria-modal="true" aria-labelledby="pair-approval-title"><h2 id="pair-approval-title">{t('Подключить устройство?','Pair this device?')}</h2><strong>{label(incoming.peer)}</strong><p>{t('На этом устройстве ввели ваш код. Подтвердите, только если это сделали вы.','Your code was entered on this device. Confirm only if you entered it yourself.')}</p><p className="nearby-hint">{t('Сверьте четыре символа имени на другом экране. После подтверждения устройства запомнят друг друга и смогут принимать файлы и текст без повторного вопроса.','Check the four characters of its device name on the other screen. Once confirmed, these devices will remember each other and accept files and text without asking again.')}</p><p>{t('Осталось','Time left')} {seconds(incoming.expires)}</p>{error&&<p className="discovery-error" role="alert">{error}</p>}<div className="approval-actions"><button ref={decline} className="secondary" disabled={waiting} onClick={()=>void action('decline',{request:incoming.id})}>{t('Отклонить','Decline')}</button><button className="primary" disabled={waiting||disabled} onClick={()=>void action('accept',{request:incoming.id})}>{waiting?<LoaderCircle className="spin" size={16}/>:null}{t('Подключить','Connect')}</button></div></section></div>}
  </section>;
}
