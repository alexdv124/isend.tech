import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import {mkdir,readFile,writeFile,cp,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(root,'dist');
await mkdir(out,{recursive:true});
const result=await build({
  absWorkingDir:root,entryPoints:['app/main.tsx'],outdir:resolve(out,'assets'),
  entryNames:'app-[hash]',bundle:true,minify:true,metafile:true,
  target:['chrome109','firefox115','safari17'],format:'esm',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},
  plugins:[{name:'css',setup(plugin){plugin.onLoad({filter:/globals\.css$/},async args=>{
    const css=await postcss([tailwind({base:root,optimize:true})]).process(await readFile(args.path,'utf8'),{from:args.path});
    return {contents:css.css,loader:'css',resolveDir:root};
  });}}],
});
await cp(resolve(root,'public'),out,{recursive:true});
const entry=Object.entries(result.metafile.outputs).find(([,value])=>value.entryPoint==='app/main.tsx');
if(!entry)throw new Error('Client entry not found');
const pathFor=path=>'/'+path.replace(/^dist\//,'');
await writeFile(resolve(out,'index.html'),`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="description" content="isend.tech — передавайте файлы, фото и текст между телефоном и компьютером без установки и регистрации.">
<title>isend.tech — файлы и текст между устройствами</title><link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="${pathFor(entry[1].cssBundle)}"><script type="module" src="${pathFor(entry[0])}"></script></head>
<body class="antialiased"><div id="root"></div></body></html>`);
for(const path of await readdir(out,{recursive:true})){
  if(!/\.(html|css|js|svg)$/.test(path))continue;
  const data=await readFile(resolve(out,path));
  await writeFile(resolve(out,path+'.gz'),gzipSync(data,{level:9}));
}
console.log('Built standalone V28 browser client. No runtime npm dependencies required.');
