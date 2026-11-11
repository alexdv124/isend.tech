import {createContext,useContext} from 'react';
export type Language='ru'|'en';
export const LanguageContext=createContext<Language>('ru');
export const useLanguage=()=>{const lang=useContext(LanguageContext);return {lang,t:(ru:string,en:string)=>lang==='ru'?ru:en};};
const errors:Record<string,string>={
'Запись в выбранный файл прервана. Отправьте файл заново.':'Writing to the chosen file was interrupted. Send the file again.',
'Получатель отклонил выбор файла для сохранения.':'The receiver did not choose a destination file. Send again when ready.',
'Не совпала контрольная сумма блока.':'The block checksum did not match. Retry the transfer.',

'Браузер вернул неверный результат записи файла. Сохранённая часть не изменена. Повторите передачу в обновлённом браузере.':'The browser returned an invalid file write result. The saved checkpoint is unchanged. Retry in an up-to-date browser.',
'Браузер вернул неверную позицию записи. Передача приостановлена для защиты файла.':'The browser returned an invalid write position. The transfer was paused to protect the file.',
'Неверный порядок блоков.':'The received block position does not match the expected position.',
'Проверяем сохранённую часть и продолжаем передачу…':'Checking the saved part and resuming the transfer…',
'Не удалось восстановить порядок блоков. Сохранённая часть осталась у получателя. Нажмите «Повторить»; подробности — в сведениях о передаче.':'Could not recover the block sequence. The receiver keeps the saved part. Press Retry; diagnostic information is in Transfer details.',

'Недостаточно места в хранилище браузера получателя. Откройте «Хранилище сайта» на получателе, удалите ненужные копии и повторите отправку.':'The receiving browser could not save the file. Open Site storage on the receiver, remove unneeded copies, then retry.',
'Файл сейчас используется. Остановите передачу перед удалением.':'This file is in use. Stop the transfer before removing it.',
'Дождитесь завершения передачи.':'Wait until the transfer finishes.',
'Файл ещё не получен.':'This file has not finished transferring.',
'Слишком много запросов или подключений. Повторим автоматически.':'The connection service is busy. Retrying automatically.',
'Слишком много активных вкладок. Закройте лишние и повторите через 2 минуты.':'Too many active tabs. Close unused tabs and try again in two minutes.',
'Запрос уже закрыт. Подождите немного перед повтором.':'This request was declined or closed. Wait a moment before trying again.',
'Выбираем доступный маршрут…':'Getting the connection ready…',
'Получаем сведения о файле…':'Receiving file details…',
'Принимаем соединение…':'Connecting to the sender…',
'Продолжаем с сохранённого блока…':'Resuming from the last saved block…',
'Подтвердите приём на этом устройстве.':'Accept the transfer on this device.',
'Ждём возвращения второго устройства. Соединимся автоматически…':'Waiting for the other device. We’ll reconnect automatically…',
'Подключаем текстовый канал…':'Getting the text connection ready…',
'Передача остановлена.':'Transfer stopped.',
'Связь прервалась. Сохранённые блоки не потеряны. Соединяемся снова…':'Connection lost. Saved blocks are safe. Reconnecting…',
'Соединение прервалось. Переподключаемся…':'Connection interrupted. Reconnecting…',

'Получатель отклонил передачу.':'The other device declined the transfer.',
'Получатель занят другой передачей. Повторите после её завершения.':'The other device is busy. Try again when its transfer finishes.',
'Подтвердите приём на втором устройстве.':'Accept the transfer on the other device.',
'Устройство больше не доступно.':'The other device is offline. Open the page there and try again.',
'Недостаточно места в хранилище браузера. Освободите место на устройстве.':'Not enough browser storage. Free up space on this device and try again.',
'На устройстве закончилось место. Освободите место и повторите.':'The receiving browser could not save the file. Check Site storage on the receiver.',
'Текст слишком большой. Отправьте его файлом.':'This text is too long. Send it as a file instead.',
'Не удалось подготовить канал. Повторите подключение.':'Could not connect. Keep both pages open and try again.',
'Не удалось отправить блок. Повторно соединяемся с получателем…':'The connection was interrupted. Reconnecting to continue the transfer…',
'Связь прервалась. Передача продолжится автоматически.':'Connection lost. The transfer will resume automatically.',
'Сеть изменилась. Выбираем маршрут заново и продолжаем передачу…':'Network changed. Reconnecting to resume the transfer…',
'Обновите Переброс на втором устройстве.':'Refresh the page on the other device.',
'Не удалось сохранить текст.':'The text could not be saved. Try again.',
'Обновите страницу, чтобы восстановить связь с устройствами.':'Refresh the page to reconnect your devices.',
'Нет связи с сервером подключения. Повторим автоматически.':'The connection service is unavailable. Retrying automatically.',
'Текст получен не полностью.':'The text did not arrive intact. Please try again.',
'Не удалось очистить локальное хранилище.':'Could not clear local storage. Please try again.',
};
export function localizeMessage(message:string,lang:Language){if(lang==='ru'||!/[А-Яа-яЁё]/.test(message))return message;return errors[message]||'Connection or storage error. Keep both pages open and retry. If it continues, refresh both pages.';}
