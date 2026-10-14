const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..'),ev=path.resolve(__dirname,'results-m34');
const parsed={DATABASE_URL:process.env.DATABASE_URL};
const u=new URL(parsed.DATABASE_URL);assert.equal(u.pathname,'/cashbuddy_codex_definitive_20261014','Solo la conexión temporal autorizada');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
fs.mkdirSync(ev,{recursive:true});
const pg={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password)};
const names=['cashbuddy_codex_m34_upgrade_20261014','cashbuddy_codex_m34_restore_20261014','cashbuddy_codex_m34_failed_20261014'];
function sql(s,db='postgres'){const r=cp.spawnSync('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-v','ON_ERROR_STOP=1','-At','-c',s],{env:{...pg,PGDATABASE:db},encoding:'utf8'});if(r.status)throw Error(r.stderr);return r.stdout.trim();}
function env(n){const v=new URL(u);v.pathname='/'+n;return {...process.env,DATABASE_URL:v.toString(),JWT_SECRET:'migration34-test-only',ENCRYPTION_KEY:'migration34-crypto-test-only',ADMIN_EMAIL:'migration34@audit.invalid',ADMIN_PASSWORD:'Migration-Only-2026',NODE_ENV:'test',TZ:'America/Bogota'};}
function run(label,args,n=names[0],extra={}){const r=cp.spawnSync(process.execPath,args,{cwd:root+'/apps/api',env:{...env(n),...extra},encoding:'utf8',timeout:120000});fs.writeFileSync(ev+'/'+label+'.log',(r.stdout||'')+(r.stderr||''));return r;}
function migrate(schema,label,n=names[0]){const r=run(label,[root+'/node_modules/prisma/build/index.js','migrate','deploy','--schema',schema],n);assert.equal(r.status,0,label);}
const baseline=path.resolve(ev,'schema33');fs.rmSync(baseline,{recursive:true,force:true});fs.mkdirSync(baseline+'/migrations',{recursive:true});fs.copyFileSync(root+'/apps/api/prisma/schema.prisma',baseline+'/schema.prisma');
for(const n of fs.readdirSync(root+'/apps/api/prisma/migrations'))if(n<'20261014090000_user_token_version')/* esquema exacto previo a la 34 (las migraciones posteriores, p. ej. F14/D7, no forman parte de la base 33) */fs.cpSync(root+'/apps/api/prisma/migrations/'+n,baseline+'/migrations/'+n,{recursive:true});
const fresh=path.resolve(ev,'m34-backup.dump');const results={};const created=[];
async function main(){for(const n of names)assert.equal(sql("SELECT count(*) FROM pg_database WHERE datname='"+n+"'"),'0','Preserve existing database');
try{for(const n of names){sql('CREATE DATABASE '+n);created.push(n);}migrate(baseline+'/schema.prisma','m34-migrate33');
assert.equal(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',names[0]),'33');results.migrationsBefore=33;
const hash=require(root+'/node_modules/bcryptjs').hashSync('Migration-Only-2026',4);
sql(`INSERT INTO "User" (id,email,name,"passwordHash",role,"updatedAt") VALUES ('m34-user','migration34@audit.invalid','Migration user','${hash}','user','2026-10-01 12:00:00'); INSERT INTO "Settings" (id,"initialCash","initialBank","setupComplete","updatedAt") VALUES ('singleton',123000,456000,true,now());`,names[0]);
const before=sql('SELECT row_to_json(u) FROM "User" u',names[0]);
const dump=cp.spawnSync('C:/Program Files/PostgreSQL/17/bin/pg_dump.exe',['-Fc','--file',fresh],{env:{...pg,PGDATABASE:names[0]},encoding:'utf8'});assert.equal(dump.status,0,dump.stderr);results.backupCreated=true;
const noMigration=run('m34-startup-missing',[root+'/node_modules/tsx/dist/cli.mjs',root+'/apps/api/tests/codex-m34-session.ts','missing']);assert.equal(noMigration.status,0);assert.equal(sql('SELECT row_to_json(u) FROM "User" u',names[0]),before);results.missingMigrationFailsClosed=true;
migrate(root+'/apps/api/prisma/schema.prisma','m34-migrate34');const after=JSON.parse(sql('SELECT row_to_json(u) FROM "User" u',names[0]));assert.equal(after.tokenVersion,0);delete after.tokenVersion;assert.deepEqual(after,JSON.parse(before));results.usersAndPasswordHashesPreserved=true;results.defaultVersion=0;assert.equal(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',names[0]),String(fs.readdirSync(root+'/apps/api/prisma/migrations').filter(n=>/^\d{14}_/.test(n)).length));results.migrationsAfter=Number(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',names[0]));
const ready=run('m34-sessions',[root+'/node_modules/tsx/dist/cli.mjs',root+'/apps/api/tests/codex-m34-session.ts','ready']);assert.equal(ready.status,0);results.startupAndSessionContractVerified=true;
// Restauración a una BD vacía separada, no encima de la BD migrada.
function restore(n,label){const r=cp.spawnSync('C:/Program Files/PostgreSQL/17/bin/pg_restore.exe',['--exit-on-error','--no-owner','--no-privileges','--dbname',n,fresh],{env:pg,encoding:'utf8'});fs.writeFileSync(ev+'/'+label+'.log',(r.stdout||'')+(r.stderr||''));assert.equal(r.status,0,r.stderr);}
restore(names[1],'m34-restore-backup');assert.equal(sql('SELECT row_to_json(u) FROM "User" u',names[1]),before);assert.equal(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',names[1]),'33');assert.equal(sql(`SELECT count(*) FROM information_schema.columns WHERE table_name='User' AND column_name='tokenVersion'`,names[1]),'0');results.restoreTo33PreservesUser=true;
// Fallo intencional: se crea una columna incompatible antes de migrate deploy.
restore(names[2],'m34-failure-seed');sql('ALTER TABLE "User" ADD COLUMN "tokenVersion" TEXT',names[2]);const failed=run('m34-migration-failure',[root+'/node_modules/prisma/build/index.js','migrate','deploy'],names[2]);assert.notEqual(failed.status,0);assert.equal(JSON.parse(sql('SELECT row_to_json(u) FROM "User" u',names[2])).passwordHash,JSON.parse(before).passwordHash);results.failedUpgradeDetected=true;
const blocked=run('m34-failed-startup',[root+'/node_modules/tsx/dist/cli.mjs',root+'/apps/api/tests/codex-m34-session.ts','missing'],names[2]);assert.equal(blocked.status,0);results.failedMigrationStartupAborts=true;
fs.writeFileSync(ev+'/migration34.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{for(const n of created)sql('DROP DATABASE '+n+' WITH (FORCE)');}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
