// Destructivo SOLO sobre el fixture exacto, local y temporal. Nunca la base operativa.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const u=new URL(process.env.DATABASE_URL||'invalid:');
if(u.pathname!=='/cashbuddy_codex_definitive_20261014'||!['localhost','127.0.0.1'].includes(u.hostname))throw Error('Solo base temporal cashbuddy_codex_definitive_20261014 local');
const root=path.resolve(__dirname,'../../..');
const counts=[];
for(const name of ['codex-independent-final','codex-final-edges','codex-definitive']){
 const r=cp.spawnSync(process.execPath,[root+'/node_modules/tsx/dist/cli.mjs',__dirname+'/'+name+'.ts'],{
  cwd:root+'/apps/api',env:{...process.env,NODE_ENV:'test',WEBHOOK_TOKEN:'independent-test-token'},encoding:'utf8',timeout:180000,windowsHide:true});
 fs.writeFileSync(__dirname+'/'+name+'.log',(r.stdout||'')+(r.stderr||''));
 const cases=JSON.parse(fs.readFileSync(__dirname+'/'+name+'.json','utf8'));
 const fail=cases.filter(x=>!x.ok).length;
 counts.push({name,total:cases.length,pass:cases.length-fail,fail,exit:r.status});
 console.log(JSON.stringify(counts.at(-1)));
 if(r.status!==0||fail)process.exitCode=1;
}
fs.writeFileSync(__dirname+'/definitive-results.json',JSON.stringify(counts,null,2));
