import {useEffect,useRef,useState} from 'react';
import {Download,RefreshCw,Trash2,X} from 'lucide-react';
import type {DirectTransfer} from '@/lib/p2p';
import type {StorageInventory,StoredEntry} from '@/lib/disk-store';
import {formatSize} from '@/lib/transfer';
import {useLanguage,localizeMessage} from '@/lib/language';

export function StoragePanel({client,room,active,revision,onRemoved,onClose}:{client:DirectTransfer;room:string;active:boolean;revision:number;onRemoved:(entry:StoredEntry)=>void;onClose:()=>void}){
  const {t,lang}=useLanguage(),size=(n:number)=>formatSize(n,lang);
  const [data,setData]=useState<StorageInventory|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false),[selected,setSelected]=useState<StoredEntry|null>(null);
  const alive=useRef(true),section=useRef<HTMLElement>(null);
  useEffect(()=>{section.current?.scrollIntoView({behavior:'smooth',block:'start'});},[]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function refresh(){try{const value=await client.storageInventory();if(alive.current)setData(value);}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}}
  useEffect(()=>{void refresh();},[client,revision,active]);
  async function save(entry:StoredEntry){
    setWorking(true);setError('');
    try{const file=await client.storedFile(entry.key),url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=entry.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setWorking(false);}
  }
  async function remove(){
    if(!selected)return;setWorking(true);setError('');
    try{await client.removeStored(selected.key);onRemoved(selected);setSelected(null);await refresh();}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setWorking(false);}
  }
  return <section ref={section} className="storage-panel card" aria-label={t('Хранилище сайта','Site storage')}>
    <div className="storage-heading"><h2>{t('Хранилище сайта на этом устройстве','Site storage on this device')}</h2><button className="text-button" onClick={onClose} aria-label={t('Закрыть хранилище','Close storage')}><X size={18}/></button></div>
    <p>{t('Здесь все полученные файлы этого сайта в этом браузере, в том числе по прежним ссылкам. Скачивание создаёт отдельную копию и не удаляет файл отсюда.','These are all files received by this site in this browser, including through older links. Downloading makes a separate copy and does not remove it here.')}</p>
    {data?<><div className="storage-summary"><strong>{t('Копии файлов: ','File copies: ')}{size(data.entries.reduce((n,e)=>n+e.bytes,0))}</strong><span>{t('Занято сайтом: ','Site usage: ')}{data.usage===null?'—':size(data.usage)} · {t('Лимит браузера: ','Browser limit: ')}{data.quota===null?'—':size(data.quota)}</span></div><p className="storage-help">{t('Лимит и занятое место — оценки браузера, а не объём свободного диска. Даже при свободном диске браузер может отказать в записи.','Usage and limit are browser estimates, not free disk space. The browser may refuse a write even when the disk has room.')}</p>
    {data.entries.length===0?<p>{t('Сохранённых файлов нет. Если ошибка повторяется, откройте получатель в обычном Chrome или Edge вне приватного режима.','No stored files. If the error persists, open the receiving page in regular Chrome or Edge, outside private browsing.')}</p>:<div className="file-list">{data.entries.map(entry=><div className="file-row" key={entry.key}><div className="file-info"><strong>{entry.name||t('Незавершённая временная копия','Unfinished temporary copy')}</strong><span>{size(entry.bytes)} · {entry.complete?t('Получен','Received'):t('Незавершённая передача','Unfinished transfer')} · {entry.room===room?t('Текущая ссылка','Current link'):t('Прежняя ссылка','Older link')}</span></div><div className="storage-file-actions">{entry.complete&&<button className="download" disabled={working} onClick={()=>void save(entry)} aria-label={`${t('Сохранить копию','Save copy')} ${entry.name}`}><Download size={16}/><span>{t('Сохранить','Save')}</span></button>}<button className="text-button" disabled={active||working} onClick={()=>setSelected(entry)} aria-label={`${t('Удалить из хранилища','Remove from storage')} ${entry.name||entry.id}`}><Trash2 size={16}/><span>{t('Удалить','Remove')}</span></button></div></div>)}</div>}
    </>:<p>{t('Проверяем хранилище…','Checking storage…')}</p>}
    {selected&&<div className="storage-confirm" role="group" aria-label={t('Подтверждение удаления','Confirm removal')}><strong>{t('Удалить из браузера: ','Remove from browser: ')}{selected.name||t('временную копию','temporary copy')}?</strong><p>{t('Если вы ещё не сохранили файл в обычную папку, эта копия будет потеряна. Для удалённой части докачка начнётся заново. Файл отправителя и копии в «Загрузках» останутся.','If you have not saved this file to a regular folder, this copy will be lost. Removing a partial transfer restarts it from the beginning. The sender’s file and downloaded copies will remain.')}</p><div className="storage-file-actions"><button className="secondary" disabled={working} onClick={()=>setSelected(null)}>{t('Отмена','Cancel')}</button><button className="secondary" disabled={active||working} onClick={()=>void remove()}>{t('Удалить эту копию','Remove this copy')}</button></div></div>}
    {active&&<p>{t('Удаление доступно после остановки или завершения передачи.','Stop or finish the transfer to remove a copy.')}</p>}
    {error&&<p role="alert" className="notice error">{localizeMessage(error,lang)}</p>}
    <button className="text-button" disabled={working} onClick={()=>void refresh()}><RefreshCw size={14}/>{t('Обновить сведения','Refresh storage')}</button>
  </section>;
}
