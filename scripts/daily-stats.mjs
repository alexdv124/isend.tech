#!/usr/bin/env node
import {analyticsDay,journalRows,summarizeDaily} from '../analytics.mjs';
import {AudienceStore} from '../audience.mjs';
import {join} from 'node:path';
const args=process.argv.slice(2),options={directory:process.env.DIAGNOSTICS_DIR||'/var/lib/perebros-diagnostics'};
for(let i=0;i<args.length;i++){
  const key=args[i].replace(/^--/,'');
  if(['json','help'].includes(key))options[key]=true;
  else if(['from','to','directory','audience','store'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))options[key]=args[++i];
  else throw new Error('Unknown or incomplete option: '+args[i]);
}
if(options.help){console.log(`isend: посещения, воронка и передачи по московским дням (SSH).
node scripts/daily-stats.mjs --from 2026-10-12 --to 2026-10-12 [--json]
--audience all|internal|unmarked|mixed (по умолчанию all).
Отдельные сегменты также включены в JSON и обычный отчёт.
unmarked = не отмеченные как наши, НЕ доказанные новые люди/органические посетители.
mixed = передача между нашим и неотмеченным устройством; в чистый внешний объём не входит.
По умолчанию: сегодня и 6 предыдущих дней. Доступность ограничена журналом.
Браузеры: уникальные браузеры, открывшие страницу в этот день, а не люди.
Открытия: новые загрузки страницы, включая обновления; сетевые повторы не считаются.
Воронка: открыли → нашли живое устройство → участвовали → завершили передачу.
Воронка относится к дню открытия; поздние этапы той же страницы учитываются в нём.
Передачи: единый ID для отправителя/получателя/докачки. Новая отправка = новый ID.
Начали и завершили за день считаются по дате первого соответствующего события.
% завершения — доля начатых в этот день с известным завершением, в том числе позднее.
Файлы и тексты входят в счётчики. Ошибки могут быть и у успешно завершённых передач.
Метрики приблизительные: без JS/доступа к серверу, при блокировке или потере событий
посещение может не попасть в отчёт. Инкогнито и очистка данных создают новый браузер.
Сумма уникальных браузеров за дни не является уникальными браузерами за период.
Дни до первого page_view показывают «—», а не нулевую посещаемость.
Нет сохранения файлов, содержимого текста, URL, referrer и IP в этом отчёте.`);process.exit(0);}
const today=analyticsDay(Date.now());options.from??=analyticsDay(Date.now()-6*86400000);options.to??=today;
for(const key of ['from','to']){const d=options[key];if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d+'T12:00:00Z'))||new Date(d+'T12:00:00Z').toISOString().slice(0,10)!==d)throw new Error('Use a valid YYYY-MM-DD for --'+key);}
if(options.from>options.to||Date.parse(options.to)-Date.parse(options.from)>366*86400000)throw new Error('Invalid date range (maximum 366 days)');
options.audienceRegistry=new AudienceStore({path:options.store||process.env.ANALYTICS_AUDIENCE_FILE||join(options.directory,'audience.json')}).snapshot();
const quality={},report=await summarizeDaily(journalRows(options.directory,quality),{...options,includeSegments:!options.audience||options.audience==='all'});
report.audience_note='unmarked means not excluded yet, not verified external people. Mixed transfers are separate; raw diagnostics are preserved.';
report.quality=quality;report.retention='Up to 7 UTC calendar days / 256 MiB; boundary days and delivery may be incomplete.';
if(options.json)console.log(JSON.stringify(report,null,2));
else{
  console.log('isend.tech · статистика по Москве · '+options.from+' — '+options.to+'\n');
  console.log('| Дата | Открытия | Браузеры | Нашли | Участвовали | Завершили (браузеры) | Начали передач | Завершили передач | Файлы / тексты | Объём, МиБ | С ошибками |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const show=v=>v===null?'—':v;
  for(const d of report.days)console.log(`| ${d.day} | ${show(d.page_views)} | ${show(d.unique_browsers)} | ${show(d.browsers_found_device)} | ${show(d.browsers_started_transfer)} | ${show(d.browsers_completed_transfer)} | ${d.transfers_started} | ${d.transfers_completed} | ${d.files_completed} / ${d.texts_completed} | ${(d.bytes_completed/1048576).toFixed(2)} | ${d.transfers_with_errors} |`);
  console.log('\nВоронка — по браузерам дня открытия, с событиями обеих ролей. Передачи и байты объединены по ID, без удвоения.\nДо начала учёта посещений — «—». Отчёт отражает полученные события: границы 7-дневного журнала, текущий день и потерянные события дают неполные данные.\nБраузер не равен человеку; сумма уникальных за дни не равна уникальным за период.');
  if(report.segments){
    console.log('\nРазделение наших тестов и остальных\n| Дата | Группа | Открытия | Браузеры | Завершённые передачи | Объём, МиБ |\n|---|---|---:|---:|---:|---:|');
    const labels={internal:'Наши тестовые',unmarked:'Не отмеченные как наши',mixed:'Наши ↔ остальные'};
    for(const [group,days]of Object.entries(report.segments))for(const d of days)console.log(`| ${d.day} | ${labels[group]} | ${group==='mixed'?'—':show(d.page_views)} | ${group==='mixed'?'—':show(d.unique_browsers)} | ${d.transfers_completed} | ${(d.bytes_completed/1048576).toFixed(2)} |`);
    console.log('Остальные ещё могут включать ваши неотмеченные браузеры и ботов. Смешанные передачи не считаются чисто внешними.');
  }
  if(quality.skipped||quality.rotated)console.log('Пропущенные строки / файлы при ротации: '+(quality.skipped||0)+' / '+(quality.rotated||0));
}
