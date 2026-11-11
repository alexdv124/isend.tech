export const MAX_TEXT_BYTES=512*1024;
export type PayloadKind='file'|'text';
// Encode exactly what was pasted, including whitespace, line breaks and Unicode.
export function textFile(text:string):File{
  if(!text.trim())throw new Error('Вставьте или введите текст.');
  const file=new File([text],'Текст.txt',{type:'text/plain;charset=utf-8'});
  if(file.size>MAX_TEXT_BYTES)throw new Error('Текст слишком большой. Максимум — 512 КБ; длинный документ отправьте файлом.');
  return file;
}
export function validPayload(kind:unknown,size:number){
  return kind===undefined||kind==='file'||(kind==='text'&&size<=MAX_TEXT_BYTES);
}
