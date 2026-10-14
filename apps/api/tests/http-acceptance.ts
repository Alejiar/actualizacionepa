import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
if(new URL(process.env.DATABASE_URL||'').pathname!=='/cashbuddy_codex_test_fixes')throw Error('Base no autorizada');
async function main(){
 const SRC=pathToFileURL(path.resolve(__dirname,'../src')).href;
 const {createServer}=await import(`${SRC}/server.ts`);
 const {prisma:p}=await import(`${SRC}/lib/prisma.ts`);
 const {signToken}=await import(`${SRC}/lib/jwt.ts`);
 const user=await p.user.create({data:{email:'http-test@example.invalid',name:'HTTP test',passwordHash:'no-login',role:'user'}});
 const admin=await p.user.findFirstOrThrow({where:{role:'admin'}});
 const token=(u:any)=>signToken({sub:u.id,email:u.email,name:u.name,role:u.role});
 const app=createServer({webDir:path.resolve(__dirname,'../../web/out')});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 const headers=(u:any)=>({'Authorization':'Bearer '+token(u),'Content-Type':'application/json','X-Device-Id':'codex-test-device'});
 const results:any[]=[];
 const record=(name:string)=>{results.push({name,ok:true});console.log(name+': OK')};
 try{
  assert.equal((await fetch(base+'/api/health')).status,200);record('API health');
  assert.equal((await fetch(base+'/login')).status,200);record('Frontend estático');
  const before=await p.settings.findUniqueOrThrow({where:{id:'singleton'}});
  const denied=await fetch(base+'/api/settings',{method:'PATCH',headers:headers(user),body:JSON.stringify({initialCash:1})});
  assert.equal(denied.status,403); /* falta de permisos = 403: el 401 cerraba la sesión en el frontend */ assert.equal((await p.settings.findUniqueOrThrow({where:{id:'singleton'}})).initialCash,before.initialCash);record('Usuario no administrador no puede alterar capital');
  const report=await fetch(base+'/api/sd/report/2026-09',{headers:headers(admin)});assert.equal(report.status,200);
  const body=await report.json() as any;assert.equal(body.debtReconciliation.total,body.debtReconciliation.basesAllTime+body.debtReconciliation.commission);record('Reporte HTTP concilia deuda');
  const excel=await fetch(base+'/api/sd/closes/export/2026-09',{headers:headers(admin)});assert.equal(excel.status,200);
  const bytes=Buffer.from(await excel.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');
  const ExcelJS=(await import('exceljs')).default;const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes as any);
  const sheet=wb.getWorksheet('CIERRE MES')!;assert.ok(sheet);
  let found=false;sheet.eachRow(row=>{if(row.getCell(5).value==='DEUDA ACTUAL DOMICILIARIOS'){assert.equal(row.getCell(6).value,body.debtReconciliation.total);found=true}});
  assert.ok(found);record('Excel descargable concilia con reporte HTTP');
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await p.$disconnect()}
 await writeFile(path.join(__dirname,'http-acceptance.json'),JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
