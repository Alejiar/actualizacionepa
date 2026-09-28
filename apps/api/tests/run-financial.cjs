const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const url=new URL(process.env.DATABASE_URL||'invalid:');
if(url.pathname!=='/cashbuddy_codex_test_fixes'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Solo se admite la base local cashbuddy_codex_test_fixes');
const root=path.resolve(__dirname,'../../..');
for(const name of ['audit-core','audit-extra','audit-sync','audit-clients','financial-acceptance','http-acceptance']){
 const r=cp.spawnSync(process.execPath,[path.join(root,'node_modules/tsx/dist/cli.mjs'),path.join(__dirname,name+'.ts')],{env:{...process.env,NODE_ENV:'test',WEBHOOK_TOKEN:'audit-token'},encoding:'utf8',timeout:180000});
 fs.writeFileSync(path.join(__dirname,name+'.log'),(r.stdout||'')+(r.stderr||''));
 console.log(name+': '+r.status);
 if(r.status!==0)process.exit(1);
}
