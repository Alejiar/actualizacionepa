import { pathToFileURL } from "node:url";
import path from "node:path";
import {writeFile} from 'node:fs/promises';
const SRC = pathToFileURL(path.resolve(__dirname,"../src")).href;
if(new URL(process.env.DATABASE_URL||'').pathname!=='/cashbuddy_codex_test_fixes')throw Error('Base no autorizada');
globalThis.fetch=async()=>{throw Error('Red bloqueada')};
async function main(){
 const {prisma:p}=await import(`${SRC}/lib/prisma.ts`);
 const cls=await import(`${SRC}/services/client.service.ts`);
 const day=await import(`${SRC}/services/day.service.ts`);
 const {todayBogota}=await import(`${SRC}/lib/date-range.ts`);
 const {manualCreate}=await import(`${SRC}/controllers/order.controller.ts`);
 const es=await import(`${SRC}/services/edit-request.service.ts`);
 const results:any[]=[];
 function report(id:string,title:string,actual:unknown,expected:unknown){const r={id,title,actual,expected,reproduced:JSON.stringify(actual)!==JSON.stringify(expected)};results.push(r);console.log(JSON.stringify(r));}
 const client=await p.client.create({data:{name:'Codex abono parcial'}});
 await cls.addDebt(client.id,'Abono parcial',20000);
 const before=await day.getDaySummary(todayBogota());
 await cls.registerClientPayment(client.id,10000,false,'cash');
 const after=await day.getDaySummary(todayBogota());
 report('N13','Historial debe mostrar ingreso del abono parcial',{ingresosDelta:after.ingresos-before.ingresos,deudasCobradasDelta:after.deudasCobradas-before.deudasCobradas},{ingresosDelta:10000,deudasCobradasDelta:10000});
 const admin=await p.user.findFirstOrThrow();
 const b=await p.branch.create({data:{name:'Codex pedido cliente',apiKeyEnc:'invalid'}});
 const c=await p.client.create({data:{name:'Codex deuda pedido manual'}});
 const res:any={status(){return this},json(body:any){this.body=body;return this}};
 await manualCreate({body:{branchId:b.id,deliveryValue:20000,clientId:c.id,addToClientDebt:true}} as any,res);
 const o=res.body;
 const req=await es.createRequest({requesterId:admin.id,requestType:'delete',entityType:'ShipdayOrder',entityId:o.id,entityLabel:'manual',changes:{},reason:'audit'});
 await es.reviewRequest(req.id,admin.id,'approved');
 const clientAfter=await p.client.findUniqueOrThrow({where:{id:c.id}});
 report('N14','Eliminar pedido manual no revierte deuda generada al cliente',{orderExists:!!(await p.shipdayOrder.findUnique({where:{id:o.id}})),clientDebt:clientAfter.pendingDebt},{orderExists:false,clientDebt:0});
 await writeFile(path.join(__dirname,"clients.json"),JSON.stringify(results,null,2));
 await p.$disconnect();
  if(results.some(r=>r.reproduced)) throw Error("Regresión de auditoría");
}
main().catch(e=>{console.error(e);process.exit(1)});
