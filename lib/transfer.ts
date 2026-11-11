export type SharedFile = { id: string; name: string; size: number; expires: number; sender: string };
export function formatSize(size: number,lang: 'ru'|'en'='ru') {
  if (size < 1024) return `${size} ${lang==='en'?'B':'Б'}`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} ${lang==='en'?'KB':'КБ'}`;
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} ${lang==='en'?'GB':'ГБ'}`;
  return `${(size / 1024 / 1024).toFixed(1)} ${lang==='en'?'MB':'МБ'}`;
}
export function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, "0")).join("");
}
