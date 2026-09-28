const path=require('node:path'),cp=require('node:child_process'),fs=require('node:fs');
const u=new URL(process.env.DATABASE_URL||'invalid:');
if(u.pathname!=='/cashbuddy_codex_blockers'||!['localhost','127.0.0.1'].includes(u.hostname))throw Error('Solo base temporal local cashbuddy_codex_blockers, vacía y migrada');
const root=path.resolve(__dirname,'../../..');
const r=cp.spawnSync(process.execPath,[path.join(root,'node_modules/tsx/dist/cli.mjs'),path.join(__dirname,'post-claude-blockers.ts')],{env:{...process.env,WEBHOOK_TOKEN:'blockers-token',NODE_ENV:'test'},encoding:'utf8',timeout:180000,maxBuffer:20e6});
fs.writeFileSync(path.join(__dirname,'post-claude-blockers.log'),(r.stdout||'')+(r.stderr||''));console.log('Bloqueadores: '+r.status);process.exit(r.status??1);
