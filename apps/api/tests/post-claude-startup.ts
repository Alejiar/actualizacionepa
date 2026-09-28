import assert from "node:assert/strict";
import path from "node:path";
import {pathToFileURL} from "node:url";
const db=new URL(process.env.DATABASE_URL||'invalid:');
if(!['/cashbuddy_codex_fresh_v2','/cashbuddy_codex_upgrade_v2'].includes(db.pathname)||!['localhost','127.0.0.1'].includes(db.hostname))throw Error('Base no autorizada');
async function main(){
 const SRC=pathToFileURL(path.resolve(__dirname,'../src')).href;
 const {autoInit}=await import(`${SRC}/services/auto-init.service.ts`);
 const {prisma:p}=await import(`${SRC}/lib/prisma.ts`);
 try{
 if(process.argv[2]==='empty'){
  await assert.rejects(autoInit,/Base sin migraciones/);
  const rows=await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`);assert.equal(rows[0].n,0);
 }else if(process.argv[2]==='old'){
  const n=await p.user.count();await assert.rejects(autoInit,/Migraciones pendientes/);assert.equal(await p.user.count(),n);assert.equal(await p.settings.count(),0);
 }else{await autoInit();assert.equal(await p.settings.count(),1);assert.equal(await p.user.count({where:{role:'admin'}}),1);await p.shipdayOrder.findMany({take:1});}
 console.log('Arranque '+process.argv[2]+': OK');
 }finally{await p.$disconnect()}
}
main().catch(e=>{console.error(e);process.exit(1)});
