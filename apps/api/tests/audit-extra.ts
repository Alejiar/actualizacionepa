import { pathToFileURL } from "node:url";
import path from "node:path";
import { writeFile } from 'node:fs/promises';
const SRC = pathToFileURL(path.resolve(__dirname,"../src")).href;
if (new URL(process.env.DATABASE_URL || '').pathname !== '/cashbuddy_codex_test_fixes') throw Error('Base no autorizada');
// Ninguna prueba puede contactar Shipday u otro servidor externo.
globalThis.fetch = async () => { throw Error('Red externa deshabilitada por la auditoría'); };
async function main() {
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const ds = await import(`${SRC}/services/driver.service.ts`);
  const bs = await import(`${SRC}/services/base.service.ts`);
  const cs = await import(`${SRC}/services/close.service.ts`);
  const es = await import(`${SRC}/services/edit-request.service.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const { todayBogota } = await import(`${SRC}/lib/date-range.ts`);
  const { shipdayWebhook } = await import(`${SRC}/controllers/webhook.controller.ts`);
  const results: any[] = [];
  const report = (id: string, title: string, actual: unknown, expected: unknown) => {
    const result = { id, title, actual, expected, reproduced: JSON.stringify(actual) !== JSON.stringify(expected) };
    results.push(result); console.log(JSON.stringify(result));
  };
  const admin = await p.user.findFirstOrThrow();
  let seq = 0;
  const branch = await p.branch.create({data:{name:'Codex independientes',apiKeyEnc:'invalid'}});
  const driver = (tag: string, branchId = branch.id) => p.driver.create({data:{name:tag,shipdayDriverId:'codex-'+(++seq),branchId}});
  const state = async (id: string) => {
    const d = await p.driver.findUniqueOrThrow({where:{id}});
    return {debt:d.pendingDebt, credit:d.creditAmount};
  };
  const webhook = async (d: any, value: number, id = 'codex-order-'+(++seq), date = new Date()) => {
    const res: any = {status(){return this;},json(b:any){this.body=b;return this;}};
    await shipdayWebhook({params:{branchId:d.branchId},headers:{token:'audit-token'},query:{},body:{event:'ORDER_COMPLETED',order:{id,delivery_fee:value,delivery_time:date.getTime()},carrier:{id:d.shipdayDriverId}}} as any,res);
    return p.shipdayOrder.findUniqueOrThrow({where:{shipdayOrderId:id}});
  };
  // Concurrencia real: no se parchea Prisma ni el servicio, solo se lanzan llamadas simultáneas.
  {
    const d = await driver('Dos cobros simultáneos');
    await webhook(d,100000);
    const outcomes = await Promise.allSettled([ds.registerPayment(d.id,10000,'cash'),ds.registerPayment(d.id,10000,'cash')]);
    const total = await p.bankTransaction.aggregate({where:{driverId:d.id},_sum:{amount:true}});
    report('N1','Dos cobros persistidos deben descontarse ambos', {success:outcomes.filter(x=>x.status==='fulfilled').length,paid:total._sum.amount,...await state(d.id)}, {success:2,paid:20000,debt:10000,credit:0});
  }
  {
    const d = await driver('Dos pagos del mismo crédito');
    await ds.registerPayment(d.id,10000,'cash');
    const outcomes = await Promise.allSettled([ds.payCredit(d.id,'cash'),ds.payCredit(d.id,'cash')]);
    const total = await p.bankTransaction.aggregate({where:{driverId:d.id,type:'egreso'},_sum:{amount:true}});
    report('N2','Un crédito de 10000 solo puede pagarse una vez', {success:outcomes.filter(x=>x.status==='fulfilled').length,outgoing:total._sum.amount,...await state(d.id)}, {success:1,outgoing:10000,debt:0,credit:0});
  }
  {
    const d = await driver('Bases simultáneas');
    // F14 (14-oct-2026): la base ya no suma a la deuda por comisiones; la concurrencia de
    // applyDebtDelta se ejerce con dos comisiones simultáneas y la de bases con su libro.
    const outcomes = await Promise.allSettled([bs.giveBase(d.id,{cashAmount:10000}),bs.giveBase(d.id,{cashAmount:20000}),webhook(d,10000),webhook(d,20000)]);
    const total = await p.baseTransaction.aggregate({where:{driverId:d.id},_sum:{amount:true}});
    report('N3','applyDebtDelta no debe perder incrementos concurrentes', {success:outcomes.filter(x=>x.status==='fulfilled').length,given:total._sum.amount,...await state(d.id)}, {success:4,given:30000,debt:9000,credit:0});
  }
  {
    const b = await p.branch.create({data:{name:'Codex 21 deudores',apiKeyEnc:'invalid'}});
    for(let i=0;i<21;i++){const d=await driver('Deudor '+i,b.id);await webhook(d,10000);}
    const r=await cs.getMonthlyReport(todayBogota().slice(0,7),b.id);
    const total=await p.driver.aggregate({where:{branchId:b.id},_sum:{pendingDebt:true}});
    report('N4','Reporte no debe sumar solo los primeros veinte deudores', {dashboardDebt:total._sum.pendingDebt,reportCommission:r.commission.pending}, {dashboardDebt:63000,reportCommission:63000});
  }
  {
    const d=await driver('Borrar stub');
    await webhook(d,10000);
    const stub=await webhook(d,0);
    const req=await es.createRequest({requesterId:admin.id,requestType:'delete',entityType:'ShipdayOrder',entityId:stub.id,entityLabel:'stub',changes:{},reason:'audit'});
    await es.reviewRequest(req.id,admin.id,'approved');
    const stat=await p.dailyDriverStat.findUniqueOrThrow({where:{date_driverId:{date:todayBogota(),driverId:d.id}}});
    report('N5','Eliminar stub no contado no debe restar un pedido válido',{orderCount:stat.orderCount,companyTotal:stat.companyTotal},{orderCount:1,companyTotal:3000});
  }
  {
    const missing={branchId:branch.id,shipdayDriverId:'codex-driver-late'};
    const o=await webhook(missing,10000);
    const d=await p.driver.create({data:{...missing,name:'Domiciliario tardío'}});
    const o2=await webhook(d,10000,o.shipdayOrderId);
    report('N6','Reenvío después de registrar domiciliario debe reconciliar el pedido',{assigned:!!o2.driverId,...await state(d.id)},{assigned:true,debt:3000,credit:0});
  }
  {
    const d=await driver('Editar pago de crédito');
    await ds.registerPayment(d.id,10000,'cash');await ds.payCredit(d.id,'cash');
    const t=await p.bankTransaction.findFirstOrThrow({where:{driverId:d.id,type:'egreso'}});
    const req=await es.createRequest({requesterId:admin.id,entityType:'BankTransaction',entityId:t.id,entityLabel:'Pago crédito',changes:{amount:{old:'10000',new:'5000'}},reason:'audit'});
    await es.reviewRequest(req.id,admin.id,'approved');
    const tx=await p.bankTransaction.findUniqueOrThrow({where:{id:t.id}});
    report('N7','Reducir egreso de pago de crédito debe restaurar crédito restante',{amount:tx.amount,debtApplied:tx.debtApplied,...await state(d.id)},{amount:5000,debtApplied:-5000,debt:0,credit:5000});
  }
  // Limpieza al final: elimina exclusivamente fixtures de esta base desechable.
  {
    const d=await driver('Base anterior a dos meses');
    const b=await bs.giveBase(d.id,{cashAmount:50000});
    const old=new Date();old.setMonth(old.getMonth()-3);
    await p.baseTransaction.update({where:{id:b.id},data:{date:old}});
    const beforeBalance=await dash.getExpectedBalancesForDate(todayBogota());
    const before=(await ds.listDrivers(branch.id)).find((x:any)=>x.id===d.id);
    const { deleteOldData }=await import(`${SRC}/services/order-cleanup.service.ts`);
    const removed=await deleteOldData();
    const afterBalance=await dash.getExpectedBalancesForDate(todayBogota());
    const after=(await ds.listDrivers(branch.id)).find((x:any)=>x.id===d.id);
    report('N8','La limpieza no debe borrar una base pendiente ni cambiar el efectivo esperado',{basePending:after.basePending,balances:afterBalance},{basePending:before.basePending,balances:beforeBalance});
    console.log('Limpieza aislada:',JSON.stringify(removed));
  }
  await writeFile(path.join(__dirname,"adicionales.json"),JSON.stringify(results,null,2));
  await p.$disconnect();
  if(results.some(r=>r.reproduced)) throw Error("Regresión de auditoría");
}
main().catch(e=>{console.error(e);process.exit(1);});
