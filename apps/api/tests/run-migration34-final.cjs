const fs=require('node:fs'),cp=require('node:child_process');
const u=new URL(process.env.DATABASE_URL||'invalid:');
if(u.pathname!=='/cashbuddy_codex_definitive_20261014'||!['localhost','127.0.0.1'].includes(u.hostname))throw Error('Solo la conexión temporal local autorizada');
for(const file of ['codex-migration34.cjs','codex-migration34-recovery.cjs','codex-migration34-compiled.cjs']){
 const r=cp.spawnSync(process.execPath,[__dirname+'/'+file],{env:process.env,encoding:'utf8',timeout:180000,windowsHide:true});
 fs.writeFileSync(__dirname+'/'+file+'.log',(r.stdout||'')+(r.stderr||''));
 console.log(file+': '+r.status); if(r.status!==0)process.exit(1);
}
const dir=__dirname+'/results-m34/';
const results=['migration34.json','recovery-after-failure.json','compiled-startup.json'].map(file=>({file,results:JSON.parse(fs.readFileSync(dir+file,'utf8'))}));
fs.writeFileSync(__dirname+'/migration34-final.json',JSON.stringify(results,null,2));
