const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../../..'),old=fs.mkdtempSync(path.join(os.tmpdir(),'cashbuddy-migrations-'));
const baseline=old+'/apps/api/prisma';fs.mkdirSync(baseline+'/migrations',{recursive:true});
fs.copyFileSync(root+'/apps/api/prisma/schema.prisma',baseline+'/schema.prisma');
for(const f of fs.readdirSync(root+'/apps/api/prisma/migrations'))if(f!=='20260928220000_order_manual_override')fs.cpSync(root+'/apps/api/prisma/migrations/'+f,baseline+'/migrations/'+f,{recursive:true});
const u=new URL(process.env.DATABASE_URL||'invalid:');
if(u.pathname!=='/cashbuddy_codex_blockers')throw Error('Proporciona la conexión temporal cashbuddy_codex_blockers, nunca la operativa');
if(!['localhost','127.0.0.1'].includes(u.hostname))throw Error('No local');
const pg={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:'postgres'};
function sql(s,db='postgres'){const r=cp.spawnSync('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-v','ON_ERROR_STOP=1','-At','-c',s],{env:{...pg,PGDATABASE:db},encoding:'utf8'});if(r.status)throw Error(r.stderr);return r.stdout.trim()}
const results=[];
// Un nombre reservado de prueba no autoriza borrar una base ajena preexistente.
for(const name of ['cashbuddy_codex_fresh_v2','cashbuddy_codex_upgrade_v2'])assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='"+name+"'"),'0','Conserva la base preexistente '+name);
for(const name of ['cashbuddy_codex_fresh_v2','cashbuddy_codex_upgrade_v2']){
 assert.notEqual(u.pathname,'/'+name);sql('CREATE DATABASE '+name);const test=new URL(u);test.pathname='/'+name;
 const env={...process.env,DATABASE_URL:test.toString(),JWT_SECRET:'test-only',ADMIN_EMAIL:'migration@test.invalid',ADMIN_PASSWORD:'Test-Only-2026',NODE_ENV:'test'};
 function run(label,args){const r=cp.spawnSync(process.execPath,args,{cwd:root+'/apps/api',env,encoding:'utf8',timeout:120000});fs.writeFileSync(__dirname+'/'+name+'-'+label+'.log',(r.stdout||'')+(r.stderr||''));assert.equal(r.status,0,label+' falló')}
 const migrate=dir=>run('migrate-'+(dir===old?'old':'new'),[root+'/node_modules/prisma/build/index.js','migrate','deploy','--schema',dir+'/apps/api/prisma/schema.prisma']);
 const startup=mode=>run('startup-'+mode,[root+'/node_modules/tsx/dist/cli.mjs',root+'/apps/api/tests/post-claude-startup.ts',mode]);
 try{
 if(name.endsWith('fresh_v2')){startup('empty');migrate(root);startup('ready');startup('idempotent');results.push({name,emptyStartupNoWrites:true,allMigrations:true,idempotentStartup:true});}
 else{
  migrate(old);startup('old');
  sql(`INSERT INTO "User" (id,email,name,"passwordHash",role,"updatedAt") VALUES ('migration-admin','migration@test.invalid','Admin','none','admin',now());
  INSERT INTO "Branch" (id,name,"apiKeyEnc","updatedAt") VALUES ('migration-branch','Branch','none',now());
  INSERT INTO "Driver" (id,"shipdayDriverId","branchId",name,"pendingDebt","updatedAt") VALUES ('migration-driver','1','migration-branch','Driver',12345,now());
  INSERT INTO "ShipdayOrder" (id,"shipdayOrderId","branchId","driverId","deliveryValue","companyAmount",status) VALUES ('migration-order','1','migration-branch','migration-driver',0,0,'DELIVERED');
  INSERT INTO "EditRequest" (id,"requesterId","entityType","entityId","entityLabel",changes,reason,status,"reviewerId","reviewedAt") VALUES ('migration-edit','migration-admin','ShipdayOrder','migration-order','Order','{"deliveryValue":{"old":"20000","new":"0"}}','Test','approved','migration-admin',now());`,name);
  const before=sql(`SELECT row_to_json(d) FROM "Driver" d`,name);migrate(root);assert.equal(sql(`SELECT row_to_json(d) FROM "Driver" d`,name),before);
  const o=JSON.parse(sql(`SELECT row_to_json(o) FROM "ShipdayOrder" o`,name));assert.equal(o.manualOverride,true);assert.equal(o.manualOriginalValue,20000);assert.equal(o.manualOverrideBy,'migration-admin');assert.equal(o.deliveryValue,0);assert.equal(o.companyAmount,0);
  startup('ready');results.push({name,oldStartupNoWrites:true,upgrade:true,driverUnchanged:true,oldOverrideProtected:true});
 }
 }finally{sql('DROP DATABASE '+name)}
}
fs.writeFileSync(__dirname+'/migration-v2.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
