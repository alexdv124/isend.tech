export async function signalingError(response:Response){
  let error:string|undefined;
  try{const data=await response.json() as {error?:unknown}|null;if(typeof data?.error==='string'&&data.error.length<=200)error=data.error;}catch{/* A proxy may return HTML instead of API JSON. */}
  if(error)return new Error(error);
  if(response.status===401)return new Error('Неверная ссылка подключения. Откройте ссылку со второго устройства.');
  if(response.status===429)return new Error('Слишком много запросов или подключений. Повторим автоматически.');
  return new Error(`Сервер подключения временно недоступен (HTTP ${response.status}). Повторим автоматически.`);
}
