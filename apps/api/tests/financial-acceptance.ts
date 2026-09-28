import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const SRC = pathToFileURL(path.resolve(__dirname,"../src")).href;
if(new URL(process.env.DATABASE_URL || "").pathname !== "/cashbuddy_codex_test_fixes") throw Error("Base no autorizada");
async function main(){
 const {prisma:p,moneyTransaction}=await import(`${SRC}/lib/prisma.ts`);
 const ds=await import(`${SRC}/services/driver.service.ts`);
 const bs=await import(`${SRC}/services/base.service.ts`);
 const bank=await import(`${SRC}/services/bank-transaction.service.ts`);
 const es=await import(`${SRC}/services/edit-request.service.ts`);
 const cls=await import(`${SRC}/services/client.service.ts`);
 const close=await import(`${SRC}/services/close.service.ts`);
 const dashboard=await import(`${SRC}/services/shipday-dashboard.service.ts`);
 const hourly=await import(`${SRC}/services/hourly-client.service.ts`);
 const {manualCreate}=await import(`${SRC}/controllers/order.controller.ts`);
 const {shipdayWebhook}=await import(`${SRC}/controllers/webhook.controller.ts`);
 const {todayBogota}=await import(`${SRC}/lib/date-range.ts`);
 const admin=await p.user.findFirstOrThrow();
 const branch=await p.branch.create({data:{name:'Aceptación',apiKeyEnc:'invalid'}});
 let seq=0;
 const driver=()=>p.driver.create({data:{name:'Aceptación '+(++seq),shipdayDriverId:'accept-'+seq,branchId:branch.id}});
 const state=async(id:string)=>{const d=await p.driver.findUniqueOrThrow({where:{id}});return [d.pendingDebt,d.creditAmount]};
 const res=()=>({code:200,body:null as any,status(c:number){this.code=c;return this},json(body:any){this.body=body;return this}});
 const req=async(type:string,id:string,changes:any,requestType='edit')=>es.createRequest({requesterId:admin.id,entityType:type,entityId:id,entityLabel:'test',changes,reason:'regresión',requestType});
 const edit=async(type:string,id:string,changes:any)=>{const r=await req(type,id,changes);return es.reviewRequest(r.id,admin.id,'approved')};
 const results:any[]=[];
 async function test(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,ok:true})}catch(e){results.push({name,ok:false,error:String(e)})}console.log(JSON.stringify(results.at(-1)))}
 await test('Rollback conjunto de pago y saldo, incluso entre servicios',async()=>{
  const d=await driver();await bs.giveBase(d.id,{cashAmount:30000});
  await assert.rejects(moneyTransaction(async()=>{await ds.registerPayment(d.id,10000,'cash');throw Error('fallo simulado')}));
  assert.deepEqual(await state(d.id),[30000,0]);assert.equal(await p.bankTransaction.count({where:{driverId:d.id}}),0);
  assert.equal(await p.baseTransaction.count({where:{driverId:d.id,type:'pago'}}),0);
 });
 await test('Un movimiento bancario no puede aplicarse dos veces',async()=>{
  const d=await driver();await bs.giveBase(d.id,{cashAmount:30000});
  const t=await bank.create({type:'ingreso',medium:'cash',amount:10000,description:'test',noCounterpart:true}) as any;
  const r=await Promise.allSettled([ds.applyBankToDriver(t.id,d.id),ds.applyBankToDriver(t.id,d.id)]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.deepEqual(await state(d.id),[20000,0]);
  assert.equal(await p.baseTransaction.count({where:{bankTransactionId:t.id}}),1);
 });
 await test('Dos aprobaciones simultáneas aplican un solo delta',async()=>{
  const d=await driver();const b=await bs.giveBase(d.id,{cashAmount:30000});
  const r=await req('BaseTransaction',b.id,{amount:{old:'30000',new:'40000'}});
  const rr=await Promise.allSettled([es.reviewRequest(r.id,admin.id,'approved'),es.reviewRequest(r.id,admin.id,'approved')]);
  assert.equal(rr.filter(x=>x.status==='fulfilled').length,1);assert.deepEqual(await state(d.id),[40000,0]);
 });
 await test('Editar cobro dividido base/comisión y después eliminarlo',async()=>{
  const d=await driver();await bs.giveBase(d.id,{cashAmount:50000});await ds.registerPayment(d.id,60000,'bank');
  const t=await p.bankTransaction.findFirstOrThrow({where:{driverId:d.id}});
  await edit('BankTransaction',t.id,{amount:{old:'60000',new:'40000'}});
  assert.deepEqual(await state(d.id),[10000,0]);
  assert.equal((await p.baseTransaction.aggregate({where:{bankTransactionId:t.id},_sum:{amount:true}}))._sum.amount,40000);
  await bank.remove(t.id);assert.deepEqual(await state(d.id),[50000,0]);
  assert.equal(await p.driverPayment.count({where:{bankTransactionId:t.id}}),0);
 });
 await test('No editar ni eliminar el desglose interno de un cobro',async()=>{
  const d=await driver();await bs.giveBase(d.id,{cashAmount:30000});await ds.registerPayment(d.id,10000,'cash');
  const b=await p.baseTransaction.findFirstOrThrow({where:{driverId:d.id,type:'pago'}});
  await assert.rejects(bs.removeBase(b.id));await assert.rejects(bs.editBase(b.id,{amount:9000}));
  assert.deepEqual(await state(d.id),[20000,0]);
 });
 await test('No modificar campos contables arbitrarios ni montos negativos',async()=>{
  await assert.rejects(req('BankTransaction','none',{debtApplied:{old:'0',new:'1000'}}));
  await assert.rejects(req('BaseTransaction','none',{amount:{old:'1000',new:'-1'}}));
  await assert.rejects(req('Unknown','none',{}));
 });
 await test('Abono mixto: conserva medio, no duplica caja y revierte una parte',async()=>{
  const c=await p.client.create({data:{name:'Mixto'}});const debt=await cls.addDebt(c.id,'deuda',30000);
  const before=await dashboard.getExpectedBalancesForDate(todayBogota());
  await cls.registerClientPayment(c.id,15000,false,'cash',{cashAmount:10000,bankAmount:5000});
  const payments=await p.clientDebtPayment.findMany({where:{debtId:debt.id}});assert.equal(payments.length,2);
  const after=await dashboard.getExpectedBalancesForDate(todayBogota());assert.equal(after.cash-before.cash,10000);assert.equal(after.bank-before.bank,5000);
  await cls.reverseClientPayment(payments.find((x:any)=>x.paidBank>0)!.id);
  const final=await dashboard.getExpectedBalancesForDate(todayBogota());assert.equal(final.cash-before.cash,10000);assert.equal(final.bank-before.bank,0);
  assert.equal((await p.client.findUniqueOrThrow({where:{id:c.id}})).pendingDebt,20000);
 });
 await test('Dos abonos de cliente simultáneos conservan ambas cantidades',async()=>{
  const c=await p.client.create({data:{name:'Concurrente'}});const debt=await cls.addDebt(c.id,'deuda',30000);
  await Promise.all([cls.registerClientPayment(c.id,10000,false,'cash'),cls.registerClientPayment(c.id,10000,false,'bank')]);
  const d=await p.clientDebt.findUniqueOrThrow({where:{id:debt.id}});assert.equal(d.paidAmount,20000);assert.equal(d.paidCash,10000);assert.equal(d.paidBank,10000);
  assert.equal((await p.client.findUniqueOrThrow({where:{id:c.id}})).pendingDebt,10000);
 });
 await test('Pedido pagado bloquea eliminación y no cambia deuda ni aprobación',async()=>{
  const d=await driver(),c=await p.client.create({data:{name:'Pedido abonado'}}),r=res();
  await manualCreate({body:{branchId:branch.id,driverId:d.id,clientId:c.id,addToClientDebt:true,deliveryValue:20000}} as any,r as any);
  await cls.registerClientPayment(c.id,10000,false,'cash');
  const request=await req('ShipdayOrder',r.body.id,{},'delete');
  await assert.rejects(es.reviewRequest(request.id,admin.id,'approved'));
  assert.deepEqual(await state(d.id),[6000,0]);assert.equal((await p.editRequest.findUniqueOrThrow({where:{id:request.id}})).status,'pending');
  assert.ok(await p.shipdayOrder.findUnique({where:{id:r.body.id}}));
 });
 await test('Editar pedido actualiza deuda vinculada y mantiene número como texto',async()=>{
  const c=await p.client.create({data:{name:'Pedido editable'}}),r=res();
  await manualCreate({body:{branchId:branch.id,clientId:c.id,addToClientDebt:true,deliveryValue:20000}} as any,r as any);
  await edit('ShipdayOrder',r.body.id,{deliveryValue:{old:'20000',new:'30000'},orderNumber:{old:'',new:'0012'}});
  assert.equal((await p.client.findUniqueOrThrow({where:{id:c.id}})).pendingDebt,30000);
  assert.equal((await p.shipdayOrder.findUniqueOrThrow({where:{id:r.body.id}})).orderNumber,'0012');
 });
 await test('Pedido provisional editado y eliminado mantiene estadísticas exactas',async()=>{
  const d=await driver(),r=res();
  await shipdayWebhook({params:{branchId:branch.id},headers:{token:'audit-token'},query:{},body:{event:'ORDER_COMPLETED',order:{id:'accept-stub',delivery_fee:0,delivery_time:Date.now()},carrier:{id:d.shipdayDriverId}}} as any,r as any);
  const o=await p.shipdayOrder.findUniqueOrThrow({where:{shipdayOrderId:'accept-stub'}});
  await edit('ShipdayOrder',o.id,{deliveryValue:{old:'0',new:'10000'}});
  assert.deepEqual(await state(d.id),[3000,0]);
  assert.equal((await p.dailyDriverStat.findUniqueOrThrow({where:{date_driverId:{date:todayBogota(),driverId:d.id}}})).orderCount,1);
  const request=await req('ShipdayOrder',o.id,{},'delete');await es.reviewRequest(request.id,admin.id,'approved');assert.deepEqual(await state(d.id),[0,0]);
 });
 await test('100+ deudores: lista y reporte incluyen a todos',async()=>{
  const b=await p.branch.create({data:{name:'101 domiciliarios',apiKeyEnc:'invalid'}});
  await p.driver.createMany({data:Array.from({length:101},(_,i)=>({name:'D'+i,shipdayDriverId:'many-'+i,branchId:b.id,pendingDebt:3000}))});
  const d=await dashboard.getDebtsDashboard(b.id);assert.equal(d.debtors.length,101);
  const report=await close.getMonthlyReport(todayBogota().slice(0,7),b.id);assert.equal(report.commission.pending,303000);assert.equal(report.debtReconciliation.total,303000);
 });
 await test('Por hora: pago, abono y reversión comparten transacción sin bloqueos',async()=>{
  const d=await driver();const c=await hourly.createHourlyClient({name:'Horas',driverHourValue:10000,companyHourValue:3000});
  const s=await hourly.registerShift(c.id,{driverId:d.id,startTime:'10:00',endTime:'11:00',medium:'cash'});
  await hourly.payClient(c.id,{amount:5000,medium:'bank'});
  const t=await p.bankTransaction.findFirstOrThrow({where:{hourlyShiftId:s.id,type:'ingreso'}});await bank.remove(t.id);
  assert.equal((await p.hourlyClient.findUniqueOrThrow({where:{id:c.id}})).pendingDebt,13000);
  await hourly.deleteShift(s.id);assert.equal((await p.hourlyClient.findUniqueOrThrow({where:{id:c.id}})).pendingDebt,0);
 });
 await writeFile(path.join(__dirname,'financial-acceptance.json'),JSON.stringify(results,null,2));
 await p.$disconnect();if(results.some(x=>!x.ok))throw Error('Falló aceptación');
}
main().catch(e=>{console.error(e);process.exit(1)});
