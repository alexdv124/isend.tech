#!/usr/bin/env node
import {AudienceStore} from '../audience.mjs';
import {join} from 'node:path';
const args=process.argv.slice(2),action=args.shift(),options={};
while(args.length){const key=args.shift();if(!key.startsWith('--')||!args.length)throw new Error('Expected --option value');options[key.slice(2)]=args.shift();}
const path=options.store||process.env.ANALYTICS_AUDIENCE_FILE||join(process.env.DIAGNOSTICS_DIR||'/var/lib/perebros-diagnostics','audience.json');
const store=new AudienceStore({path});
if(action==='invite'){const r=store.invite({hours:Number(options.hours||24),uses:Number(options.uses||16)});console.log(JSON.stringify({url:(options.origin||'https://isend.tech')+'/test-device.html#'+r.token,expires:new Date(r.expires).toISOString(),uses:r.uses},null,2));}
else if(action==='add'){store.add(options.kind,options.value,options.label||'');console.log('Added internal '+options.kind);}
else if(action==='list'){const s=store.snapshot();console.log(JSON.stringify({identities:s.identities,devices:s.devices,visitors:s.visitors,activeInvites:s.invites.filter(r=>r.expires>Date.now()&&r.remaining>0).length},null,2));}
else throw new Error('Use invite [--hours 24 --uses 16], add --kind identity|device|visitor --value FULL_VALUE --label LABEL, or list; optional --store PATH. Run as the service user.');
