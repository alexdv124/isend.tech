// Include earlier clients: their receiver error is forwarded unchanged to the sender.
export function isStorageFull(message:string){
  return message.includes('места в хранилище браузера')||message.includes('На устройстве закончилось место');
}
