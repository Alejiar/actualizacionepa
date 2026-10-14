import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
const url=new URL(process.env.DATABASE_URL||'invalid:');
if(url.pathname!=='/cashbuddy_codex_blockers'||!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Solo base temporal de bloqueadores');
async function main(){
 const SRC=pathToFileURL(path.resolve(__dirname,'../src')).href;
 const {prisma:p,moneyTransaction}=await import(`${SRC}/lib/prisma.ts`);
 const {createServer}=await import(`${SRC}/server.ts`);
 const {signToken}=await import(`${SRC}/lib/jwt.ts`);
 const clients=await import(`${SRC}/services/client.service.ts`);
 const edits=await import(`${SRC}/services/edit-request.service.ts`);
 const branches=await import(`${SRC}/services/branch.service.ts`);
 const bases=await import(`${SRC}/services/base.service.ts`);
 const drivers=await import(`${SRC}/services/driver.service.ts`);
 const closes=await import(`${SRC}/services/close.service.ts`);
 const {getExpectedBalancesForDate}=await import(`${SRC}/services/shipday-dashboard.service.ts`);
 const {todayBogota}=await import(`${SRC}/lib/date-range.ts`);
 const {addMovement}=await import(`${SRC}/services/movement.service.ts`);
 const {encryptApiKey}=await import(`${SRC}/lib/crypto.ts`);
 await p.settings.create({data:{id:'singleton',initialCash:300000,initialBank:100000}});
 const admin=await p.user.create({data:{email:'admin@blockers.invalid',name:'Admin',passwordHash:'test',role:'admin'}});
 const user=await p.user.create({data:{email:'user@blockers.invalid',name:'User',passwordHash:'test',role:'user'}});
 const today=todayBogota(),month=today.slice(0,7);
 const server=createServer().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const origin='http://127.0.0.1:'+(server.address() as any).port;
 const realFetch=globalThis.fetch;
 const results:any[]=[];
 async function api(route:string,method='GET',body?:unknown,actor:any=admin){
  const headers:Record<string,string>={'Content-Type':'application/json'};
  if(actor)headers.Authorization='Bearer '+signToken({sub:actor.id,email:actor.email,name:actor.name,role:actor.role});
  const r=await realFetch(origin+'/api'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:r.status===204?null:await r.json() as any};
 }
 async function check(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,ok:true});console.log('OK '+name)}catch(e){results.push({name,ok:false,error:String(e)});throw e}}
 const balances=()=>getExpectedBalancesForDate(today);
 const debtState=(id:string)=>Promise.all([p.client.findUnique({where:{id}}),p.clientDebt.findMany({where:{clientId:id},orderBy:{id:'asc'}}),p.clientDebtPayment.findMany({where:{clientId:id},orderBy:{id:'asc'}})]);
 async function request(entityType:string,entityId:string,changes:any={},requestType='edit'){
  const r=await api('/edit-requests','POST',{entityType,entityId,entityLabel:'Prueba',changes,requestType,reason:'Corrección probada'},user);assert.equal(r.status,201,JSON.stringify(r));return r.body;
 }
 async function approve(id:string){return api('/edit-requests/'+id+'/review','POST',{action:'approved'})}
 try{
 await check('D1: rutas administrativas deniegan al usuario y no alteran capital, cierres ni usuarios',async()=>{
  const before=await p.settings.findUniqueOrThrow({where:{id:'singleton'}}),n=await p.user.count();
  for(const [route,method,body] of [['/settings','PATCH',{initialCash:1}],['/sd/closes','POST',{month:'2026-07',initialCash:1,initialBank:2}],['/admin/reset','POST',{}],['/admin/recalc-orders','POST',{}],['/auth/register','POST',{email:'hack@invalid.test',password:'password',name:'Hack'}],['/users','POST',{email:'hack@invalid.test',password:'password',name:'Hack'}],['/branches','POST',{name:'No',apiKey:'no'}]] as const){const r=await api(route,method,body,user);assert.ok([401,403].includes(r.status),route+JSON.stringify(r));}
  assert.deepEqual(await p.settings.findUniqueOrThrow({where:{id:'singleton'}}),before);assert.equal(await p.monthlyClose.count(),0);assert.equal(await p.user.count(),n);assert.equal(await p.branch.count(),0);
  assert.equal((await api('/auth/register','POST',{email:'public@invalid.test',password:'password',name:'Public'},null)).status,401);
 });
 await check('D1: capital inválido rechazado incluso para admin',async()=>{
  for(const value of [-1,1.5,null,'1','NaN','Infinity',2147483648])for(const route of ['/settings','/sd/closes']){const r=await api(route,route==='/settings'?'PATCH':'POST',{month:'2026-07',initialCash:value});assert.equal(r.status,400,route+JSON.stringify(r));}
  assert.equal(await p.monthlyClose.count(),0);assert.equal((await p.settings.findUniqueOrThrow({where:{id:'singleton'}})).initialCash,300000);
 });
 const expense={date:today,category:3,type:'egreso',medium:'cash',amount:10000,description:'Gasto prueba'};
 let movement:any;
 await check('D2: status y autor enviados por usuario no permiten gasto confirmado',async()=>{
  const before=await balances();const r=await api('/movements','POST',{...expense,status:'confirmed',createdBy:admin.id},user);assert.equal(r.status,201);movement=r.body;
  assert.equal(movement.status,'pending');assert.equal((await p.movement.findUniqueOrThrow({where:{id:movement.id}})).createdBy,user.id);assert.deepEqual(await balances(),before);
 });
 await check('D2: montos inválidos de gasto se rechazan en API y servicio sin crear día ni movimiento',async()=>{
  const count=await p.movement.count(),days=await p.day.count();
  for(const amount of [0,-50000,0.5,null,'1','abc','NaN','Infinity',2147483648])assert.equal((await api('/movements','POST',{...expense,amount},user)).status,400);
  for(const amount of [0,-1,NaN,Infinity,2147483648])await assert.rejects(()=>addMovement({...expense,amount} as any));
  assert.equal(await p.movement.count(),count);assert.equal(await p.day.count(),days);
  assert.equal((await api('/movements','POST',{...expense,type:'ingreso'})).status,400);
  assert.equal((await api('/movements','POST',{...expense,medium:'bank'})).status,400);
 });
 await check('D2: usuario no edita, confirma, rechaza ni borra directamente',async()=>{
  const before=await p.movement.findUniqueOrThrow({where:{id:movement.id}});
  for(const [suffix,method,body] of [['','PATCH',{amount:1,status:'confirmed'}],['/approve','POST',{}],['/reject','POST',{}],['','DELETE',undefined]] as const)assert.equal((await api('/movements/'+movement.id+suffix,method,body,user)).status,403);
  assert.deepEqual(await p.movement.findUniqueOrThrow({where:{id:movement.id}}),before);
 });
 await check('D2: aprobación concurrente aplica un solo gasto y conserva aprobador',async()=>{
  const before=await balances();const r=await Promise.all([api('/movements/'+movement.id+'/approve','POST',{}),api('/movements/'+movement.id+'/approve','POST',{})]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,400]);assert.equal((await balances()).cash,before.cash-10000);
  assert.equal((await p.movement.findUniqueOrThrow({where:{id:movement.id}})).approvedBy,admin.id);
 });
 await check('D2: confirmado se edita/revierte por solicitud administrativa; API directa bloqueada',async()=>{
  assert.equal((await api('/movements/'+movement.id,'PATCH',{amount:1})).status,400);
  assert.equal((await api('/movements/'+movement.id,'DELETE')).status,400);
  assert.equal((await api('/movements/'+movement.id+'/reject','POST',{})).status,400);
  const before=await balances(),r=await request('Movement',movement.id,{amount:{old:'10000',new:'7000'}});
  assert.equal((await api('/edit-requests/'+r.id+'/review','POST',{action:'approved'},user)).status,403);
  assert.equal((await approve(r.id)).status,200);assert.equal((await balances()).cash,before.cash+3000);
  const report=await closes.getMonthlyReport(month);assert.equal(report.expenses.total,7000);
  const del=await request('Movement',movement.id,{},'delete');assert.equal((await approve(del.id)).status,200);
  assert.equal((await balances()).cash,before.cash+10000);assert.equal((await p.editRequest.findUniqueOrThrow({where:{id:del.id}})).status,'approved');
 });
 await check('D2: fallo posterior revierte conjuntamente gasto y día',async()=>{
  const before=await p.movement.count(),days=await p.day.count();await assert.rejects(()=>moneyTransaction(async()=>{await addMovement({...expense,date:'2030-01-01'} as any);throw Error('fallo simulado')}));assert.equal(await p.movement.count(),before);assert.equal(await p.day.count(),days);
 });
 await check('Compatibilidad: cobro de domicilio pendiente conserva el flujo ajeno a gastos',async()=>{
  const r=await api('/movements','POST',{...expense,category:1,type:'ingreso',status:'pending'},user);assert.equal(r.status,201);
  const paid=await api('/movements/'+r.body.id,'PATCH',{status:'confirmed',medium:'bank',category:2},user);assert.equal(paid.status,200);assert.equal(paid.body.status,'confirmed');
 });
 const client=await clients.createClient({name:'Cliente pruebas'});assert.ok(client);
 await check('D3: deudas negativas, cero, inválidas y medio inválido no crean dinero',async()=>{
  const before=await balances(),state=await debtState(client.id);
  for(const amount of [0,-50000,1.5,null,'1','abc',2147483648])assert.equal((await api('/clients/'+client.id+'/debt','POST',{description:'Inválida',amount,medium:'cash'})).status,400);
  for(const initialDebt of [0,-1,null,'10',2147483648])assert.equal((await api('/clients','POST',{name:'Inválido',initialDebt})).status,400);
  for(const amount of [NaN,Infinity])await assert.rejects(()=>clients.addDebt(client.id,'Inválida',amount));
  assert.equal((await api('/clients/'+client.id+'/debt','POST',{description:'No',amount:100,medium:'inventado'})).status,400);
  assert.equal((await api('/clients/'+client.id,'PATCH',{pendingDebt:-50000})).status,400);
  assert.equal((await api('/clients','POST',{name:'Inyectado',pendingDebt:100})).status,400);
  assert.deepEqual(await debtState(client.id),state);assert.deepEqual(await balances(),before);
 });
 let debt:any;
 await check('D3: deuda positiva retira dinero una vez; abonos inválidos/sobrepago no tienen efecto',async()=>{
  const before=await balances();debt=await clients.addDebt(client.id,'Préstamo',10000,undefined,undefined,'cash');assert.equal((await balances()).cash,before.cash-10000);
  const state=await debtState(client.id),bal=await balances();
  for(const amount of [0,-1,null,'100','abc',1.5,10001,2147483648])assert.equal((await api('/clients/'+client.id+'/pay','POST',{amount,medium:'cash'})).status,400);
  assert.equal((await api('/clients/'+client.id+'/pay','POST',{cashAmount:8000,bankAmount:5000})).status,400);
  assert.equal((await api('/clients/'+client.id+'/pay','POST',{amount:100,medium:'inventado'})).status,400);
  assert.deepEqual(await debtState(client.id),state);assert.deepEqual(await balances(),bal);
 });
 await check('D3: cobros concurrentes no exceden deuda, reversión y eliminación conservan invariantes',async()=>{
  const result=await Promise.allSettled([clients.registerClientPayment(client.id,7000),clients.registerClientPayment(client.id,7000)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await p.client.findUniqueOrThrow({where:{id:client.id}})).pendingDebt,3000);
  const payment=await p.clientDebtPayment.findFirstOrThrow({where:{clientId:client.id}});
  const invalid=await request('ClientDebt',debt.id,{amount:{old:'10000',new:'6000'}});assert.equal((await approve(invalid.id)).status,400);assert.equal((await p.editRequest.findUniqueOrThrow({where:{id:invalid.id}})).status,'pending');
  await clients.reverseClientPayment(payment.id);assert.equal((await p.client.findUniqueOrThrow({where:{id:client.id}})).pendingDebt,10000);
  const edit=await request('ClientDebt',debt.id,{amount:{old:'10000',new:'12000'}});assert.equal((await approve(edit.id)).status,200);assert.equal((await p.client.findUniqueOrThrow({where:{id:client.id}})).pendingDebt,12000);
  const del=await request('ClientDebt',debt.id,{},'delete');assert.equal((await approve(del.id)).status,200);assert.equal((await p.client.findUniqueOrThrow({where:{id:client.id}})).pendingDebt,0);
 });
 const branch=await p.branch.create({data:{name:'Sucursal protegida',apiKeyEnc:encryptApiKey('test-key')}});
 const driver=await p.driver.create({data:{name:'Conductor',shipdayDriverId:'4242',branchId:branch.id}});
 const payload=(id:string,value:number)=>({event:'ORDER_COMPLETED',order:{id,order_number:id,delivery_fee:value,delivery_time:Date.now()},carrier:{id:4242}});
 async function webhook(token:string|undefined,id='override',value=20000){return realFetch(origin+'/api/webhooks/shipday/'+branch.id,{method:'POST',headers:{'Content-Type':'application/json',...(token?{token}:{})},body:JSON.stringify(payload(id,value))})}
 await check('D4: 80 webhooks falsos bajo candado no esperan ni afectan Dashboard',async()=>{
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
  const hold=moneyTransaction(async()=>{started();await gate});await ready;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([(async()=>{const all=await Promise.all(Array.from({length:80},(_,i)=>webhook(i%2?'incorrecto':undefined)));assert.ok(all.every(r=>r.status===401));assert.equal((await api('/sd/dashboard/full')).status,200);assert.equal(await p.shipdayOrder.count(),0)})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Tráfico inválido bloqueó lecturas')),5000)})]);}
  finally{if(timer)clearTimeout(timer);release();await hold}
 });
 await check('D4: webhook válido funciona después del ataque; ráfaga válida no monopoliza lecturas',async()=>{
  assert.equal((await webhook('blockers-token')).status,200);
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
  const hold=moneyTransaction(async()=>{started();await gate});await ready;
  const burst=Promise.all(Array.from({length:12},()=>webhook('blockers-token')));
  try{assert.equal((await api('/sd/dashboard/full')).status,200)}finally{release();await hold}
  const replies=await burst;assert.ok(replies.every(r=>[200,503].includes(r.status)));assert.equal((await p.driver.findUniqueOrThrow({where:{id:driver.id}})).pendingDebt,6000);
 });
 await check('D5: override a cero sobrevive tres sondeos y webhook, con original y autor verificables',async()=>{
  const order=await p.shipdayOrder.findUniqueOrThrow({where:{shipdayOrderId:'override'}});
  const req=await request('ShipdayOrder',order.id,{deliveryValue:{old:'20000',new:'0'}});assert.equal((await approve(req.id)).status,200);
  globalThis.fetch=async(input:any)=>{const u=String(input);if(u==='https://api.shipday.com/carriers')return new Response(JSON.stringify([{id:4242,name:'Conductor'}]));if(u==='https://api.shipday.com/orders/query')return new Response(JSON.stringify([{orderId:'override',orderNumber:'O',deliveryFee:20000,deliveryTime:new Date().toISOString(),carrier:{id:4242}}]));throw Error('Red no simulada: '+u)};
  try{for(let i=0;i<3;i++)await branches.syncBranch(branch.id)}finally{globalThis.fetch=realFetch}
  assert.equal((await webhook('blockers-token')).status,200);
  const after=await p.shipdayOrder.findUniqueOrThrow({where:{id:order.id}});assert.equal(after.deliveryValue,0);assert.equal(after.companyAmount,0);assert.equal(after.manualOverride,true);assert.equal(after.manualOriginalValue,20000);assert.equal(after.manualOverrideBy,admin.id);assert.ok(after.manualOverrideAt);assert.equal(after.shipdayDeliveryValue,20000);assert.equal((await p.driver.findUniqueOrThrow({where:{id:driver.id}})).pendingDebt,0);
 });
 await check('F06: desactivar conserva registros, vínculos, cierre y totales históricos',async()=>{
  await bases.giveBase(driver.id,{cashAmount:30000});await drivers.registerPayment(driver.id,5000,'cash');
  const closed=await closes.closeMonth(month,branch.id);
  const snapshot=()=>Promise.all([p.shipdayOrder.findMany({where:{branchId:branch.id}}),p.baseTransaction.findMany({where:{branchId:branch.id},orderBy:{id:'asc'}}),p.driverPayment.findMany({where:{driverId:driver.id}}),p.bankTransaction.findMany({where:{driverId:driver.id}}),p.monthlyClose.findUnique({where:{id:closed.id}}),p.driver.findUnique({where:{id:driver.id}})]);
  const before=await snapshot(),report=await closes.getMonthlyReport(month,branch.id),bal=await balances();
  assert.equal((await api('/branches/'+branch.id,'DELETE',undefined,user)).status,403);
  assert.equal((await api('/branches/'+branch.id,'DELETE')).status,204);
  assert.equal((await p.branch.findUniqueOrThrow({where:{id:branch.id}})).active,false);assert.deepEqual(await snapshot(),before);assert.deepEqual(await closes.getMonthlyReport(month,branch.id),report);assert.deepEqual(await balances(),bal);
  assert.equal((await webhook('blockers-token','after-archive')).status,200);assert.equal(await p.shipdayOrder.count({where:{shipdayOrderId:'after-archive'}}),0);
  assert.equal((await api('/sd/orders/manual','POST',{branchId:branch.id,driverId:driver.id,deliveryValue:10000})).status,400);
 });
 await check('D1: cierre administrativo válido conserva capital cero permitido',async()=>{const r=await api('/sd/closes','POST',{month:'2026-07',initialCash:0,initialBank:0});assert.equal(r.status,201);assert.equal((await p.settings.findUniqueOrThrow({where:{id:'singleton'}})).initialCash,0)});
 await check('F06: sucursal con pedido manual vinculado conserva deuda de cliente al desactivarse',async()=>{
  const b=await p.branch.create({data:{name:'Manual vinculado',apiKeyEnc:'test'}});
  const order=await api('/sd/orders/manual','POST',{branchId:b.id,clientId:client.id,deliveryValue:12000,addToClientDebt:true});assert.equal(order.status,201);
  const state=await debtState(client.id);assert.equal((await api('/branches/'+b.id,'DELETE')).status,204);assert.deepEqual(await debtState(client.id),state);assert.equal(await p.shipdayOrder.count({where:{branchId:b.id}}),1);
 });
 }finally{globalThis.fetch=realFetch;await new Promise<void>(r=>server.close(()=>r()));await p.$disconnect();await writeFile(path.join(__dirname,'post-claude-blockers.json'),JSON.stringify(results,null,2))}
}
main().catch(e=>{console.error(e);process.exit(1)});
