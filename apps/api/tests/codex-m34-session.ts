import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prisma as p} from '../src/lib/prisma';
import {autoInit} from '../src/services/auto-init.service';
import {createServer} from '../src/server';
import {signToken} from '../src/lib/jwt';
import {login} from '../src/services/auth.service';
import {updateUser} from '../src/services/user.service';
const u=new URL(process.env.DATABASE_URL!);assert.ok(u.pathname.startsWith('/cashbuddy_codex_m34_'));assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
async function main(){if(process.argv[2]==='missing'){await assert.rejects(()=>autoInit(),/Migraciones pendientes o fallidas/);console.log(JSON.stringify({startupAbortedBeforeWrites:true}));await p.$disconnect();return;}
await autoInit();const server=createServer().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const origin='http://127.0.0.1:'+(server.address() as any).port;
try{const before=await p.user.findUniqueOrThrow({where:{id:'m34-user'}});const legacy=signToken({sub:before.id,email:before.email,name:before.name,role:before.role});const session=await login({email:before.email,password:'Migration-Only-2026'});
const status=(t:string)=>fetch(origin+'/api/auth/me',{headers:{Authorization:'Bearer '+t}}).then(r=>r.status);
assert.equal(await status(legacy),200);assert.equal(await status(session.token),200);await updateUser(before.id,{password:'Changed-Only-2026'});assert.equal(await status(legacy),401);assert.equal(await status(session.token),401);const next=await login({email:before.email,password:'Changed-Only-2026'});assert.equal(await status(next.token),200);
const after=await p.user.findUniqueOrThrow({where:{id:before.id}});assert.equal(after.tokenVersion,1);console.log(JSON.stringify({legacyAfterUpgrade:200,issuedAfterUpgrade:200,legacyAfterPasswordChange:401,oldVersionAfterPasswordChange:401,freshSession:200,version:1}));}
finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await p.$disconnect();}}
main().catch(e=>{console.error(e);process.exitCode=1});
