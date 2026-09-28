import { pathToFileURL } from "node:url";
import path from "node:path";
import { writeFile } from 'node:fs/promises';
const SRC = pathToFileURL(path.resolve(__dirname,"../src")).href;
if(new URL(process.env.DATABASE_URL||'').pathname!=='/cashbuddy_codex_test_fixes')throw Error('Base no autorizada');
async function main(){
 const {prisma:p}=await import(`${SRC}/lib/prisma.ts`);
 const ds=await import(`${SRC}/services/driver.service.ts`);
 const bs=await import(`${SRC}/services/branch.service.ts`);
 const cls=await import(`${SRC}/services/client.service.ts`);
 const dash=await import(`${SRC}/services/shipday-dashboard.service.ts`);
 const {shipdayWebhook}=await import(`${SRC}/controllers/webhook.controller.ts`);
 const {todayBogota}=await import(`${SRC}/lib/date-range.ts`);
 const b=await p.branch.create({data:{name:'Codex polling simulado',apiKeyEnc:'test-only'}});
 const results:any[]=[];
 function report(id:string,title:string,actual:unknown,expected:unknown){const r={id,title,actual,expected,reproduced:JSON.stringify(actual)!==JSON.stringify(expected)};results.push(r);console.log(JSON.stringify(r));}
 const now=new Date();
 const carrier=99001;
 async function webhook(id:string,value:number){
  const r:any={status(){return this},json(){return this}};
  await shipdayWebhook({params:{branchId:b.id},headers:{token:'audit-token'},query:{},body:{event:'ORDER_COMPLETED',order:{id,delivery_fee:value,delivery_time:now.getTime()},carrier:{id:carrier}}} as any,r);
 }
 let delivered:any[]=[{orderId:'codex-poll-orphan',orderNumber:'501',deliveryFee:10000,deliveryTime:now.toISOString(),carrier:{id:carrier}},{orderId:'codex-poll-stub',orderNumber:'502',deliveryFee:20000,deliveryTime:now.toISOString(),carrier:{id:carrier}}];
 // Respuestas HTTP simuladas; todo el código de polling, persistencia y deuda es real.
 globalThis.fetch=async(input:any)=>{
  const u=String(input);
  if(u==='https://api.shipday.com/carriers')return new Response(JSON.stringify([{id:carrier,name:'Codex carrier'}]),{status:200});
  if(u==='https://api.shipday.com/orders/query')return new Response(JSON.stringify(delivered),{status:200});
  throw Error('Red bloqueada: URL no simulada');
 };
 await webhook('codex-poll-orphan',10000);
 await webhook('codex-poll-stub',0);
 await bs.syncBranch(b.id);
 const d=await p.driver.findUniqueOrThrow({where:{shipdayDriverId_branchId:{shipdayDriverId:String(carrier),branchId:b.id}}});
 const orphan=await p.shipdayOrder.findUniqueOrThrow({where:{shipdayOrderId:'codex-poll-orphan'}});
 const stub=await p.shipdayOrder.findUniqueOrThrow({where:{shipdayOrderId:'codex-poll-stub'}});
 report('N9','Polling no recupera asignación de pedido no cero sin domiciliario',{assigned:!!orphan.driverId,debt:d.pendingDebt},{assigned:true,debt:9000});
 report('C4','Polling sana stub con tarifa y domiciliario',{value:stub.deliveryValue,commission:stub.companyAmount,assigned:!!stub.driverId},{value:20000,commission:6000,assigned:true});
 await bs.syncBranch(b.id);
 const repeat=await p.driver.findUniqueOrThrow({where:{id:d.id}});
 report('C5','Polling secuencial repetido no duplica deuda',{debt:repeat.pendingDebt},{debt:d.pendingDebt});
 await webhook('codex-race-stub',0);
 delivered=[{orderId:'codex-race-stub',orderNumber:'503',deliveryFee:10000,deliveryTime:now.toISOString(),carrier:{id:carrier}}];
 const race=await Promise.allSettled([bs.syncBranch(b.id),bs.syncBranch(b.id)]);
 const raced=await p.driver.findUniqueOrThrow({where:{id:d.id}});
 const stats=await p.dailyDriverStat.findUniqueOrThrow({where:{date_driverId:{date:todayBogota(),driverId:d.id}}});
 report('N10','Dos sync de un stub deben aplicar comisión una sola vez',{success:race.filter(x=>x.status==='fulfilled').length,debt:raced.pendingDebt,orders:stats.orderCount},{success:2,debt:repeat.pendingDebt+3000,orders:3});
 // Abonos en dos días: el segundo no debe mover al día actual lo cobrado ayer.
 const client=await p.client.create({data:{name:'Codex abonos dos días'}});
 const debt=await cls.addDebt(client.id,'Prueba',20000);
 const yesterday=new Date(todayBogota()+'T12:00:00-05:00');yesterday.setDate(yesterday.getDate()-1);
 const yesterdayStr=yesterday.toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
 await cls.registerClientPayment(client.id,10000,false,'cash');
 await p.clientDebt.update({where:{id:debt.id},data:{paidAt:yesterday}});
 await p.clientDebtPayment.updateMany({where:{debtId:debt.id},data:{paidAt:yesterday}});
 const before=await dash.getExpectedBalancesForDate(yesterdayStr);
 await cls.registerClientPayment(client.id,10000,false,'cash');
 const after=await dash.getExpectedBalancesForDate(yesterdayStr);
 report('N11','Abono de hoy no debe borrar del saldo histórico el abono de ayer',{cashYesterday:after.cash},{cashYesterday:before.cash});
 // Limpieza con cierre ancla antiguo: ahora el dinero borrado pertenece al período acumulado.
 const baseSvc=await import(`${SRC}/services/base.service.ts`);
 const old=new Date();old.setMonth(old.getMonth()-3);
 const anchor=new Date(old);anchor.setMonth(anchor.getMonth()-1);
 await p.monthlyClose.create({data:{month:anchor.toISOString().slice(0,7),closedAt:anchor,initialCash:300000,initialBank:103130,totalOrders:0,totalValue:0,companyTotal:0,basesGiven:0,basesPaid:0,basesPending:0,conversions:{},snapshot:{}}});
 const base=await baseSvc.giveBase(d.id,{cashAmount:50000});
 await p.baseTransaction.update({where:{id:base.id},data:{date:old}});
 const balanceBefore=await dash.getExpectedBalancesForDate(todayBogota());
 const {deleteOldData}=await import(`${SRC}/services/order-cleanup.service.ts`);
 await deleteOldData();
 const balanceAfter=await dash.getExpectedBalancesForDate(todayBogota());
 report('N12','Limpieza modifica efectivo esperado con cierre ancla antiguo',balanceAfter,balanceBefore);
 await writeFile(path.join(__dirname,"sync-clientes.json"),JSON.stringify(results,null,2));
 await p.$disconnect();
  if(results.some(r=>r.reproduced)) throw Error("Regresión de auditoría");
}
main().catch(e=>{console.error(e);process.exit(1)});
