'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createGameServer,validPoints,touching}=require('../server');

async function appAt(dir){const server=createGameServer({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,base:`http://127.0.0.1:${server.address().port}`};}
async function post(base,route,body){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const sq=[[49,34],[49,35],[50,35],[50,34]];
test('geometries reject degenerate and self-crossing points; touching is checked',()=>{
 assert.equal(validPoints(sq),true);
 assert.equal(validPoints([[49,34],[50,35],[49,35],[50,34]]),false);
 assert.equal(validPoints([[49,34],[49,34],[49,34]]),false);
 assert.equal(touching(sq,[[49.8,34.5],[49.8,35.3],[50.2,35.3],[50.2,34.5]]),true);
 assert.equal(touching(sq,[[51,34],[51,35],[52,35],[52,34]]),false);
});
test('static client, two-player room, turn enforcement, SSE and restart recovery',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duel-test-'));
 let {server,base}=await appAt(dir);
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 let health=await fetch(base+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(await page.text(),/Frontline Map Duel/);
 const make=await post(base,'/api/rooms',{name:'Host',side:'ru'});assert.equal(make.status,201);
 const code=make.data.room.code,host=make.data.token;assert.match(code,/^[A-Z2-9]{6}$/);assert.equal(make.data.room.players[0].side,'ru');
 assert.equal((await post(base,`/api/rooms/${code}/action`,{token:host,action:{type:'pass'}})).status,409);
 const guestJoin=await post(base,`/api/rooms/${code}/join`,{name:'Guest'});assert.equal(guestJoin.status,200);
 const guest=guestJoin.data.token;assert.equal(guestJoin.data.room.players[1].side,'ua');
 assert.equal((await post(base,`/api/rooms/${code}/join`,{name:'Third'})).status,409);
 assert.equal((await post(base,`/api/rooms/${code}/action`,{token:'bad',action:{type:'pass'}})).status,403);
 assert.equal((await post(base,`/api/rooms/${code}/action`,{token:guest,action:{type:'pass'}})).status,409);
 const sse=await fetch(base+`/api/rooms/${code}/events?token=${encodeURIComponent(guest)}`);
 assert.equal(sse.status,200);assert.match(sse.headers.get('content-type'),/text\/event-stream/);
 const reader=sse.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/snapshot/);
 const move=await post(base,`/api/rooms/${code}/action`,{token:host,action:{type:'zone',shape:'polygon',points:sq}});
 assert.equal(move.status,200);assert.equal(move.data.room.turn,1);assert.equal(move.data.room.zones.length,1);
 const update=new TextDecoder().decode((await reader.read()).value);assert.match(update,/snapshot/);assert.match(update,/\"turn\":1/);
 assert.equal((await post(base,`/api/rooms/${code}/action`,{token:host,action:{type:'pass'}})).status,409);
 const invalidAdvance=await post(base,`/api/rooms/${code}/action`,{token:guest,action:{type:'zone',shape:'advance',points:[[51,35],[51,36],[52,36],[52,35]]}});
 assert.equal(invalidAdvance.status,422);
 const guestBase=await post(base,`/api/rooms/${code}/action`,{token:guest,action:{type:'zone',shape:'polygon',points:[[51,35],[51,36],[52,36],[52,35]]}});
 assert.equal(guestBase.status,200);assert.equal(guestBase.data.room.turn,0);assert.equal(guestBase.data.room.round,2);
 const hostAdvance=await post(base,`/api/rooms/${code}/action`,{token:host,action:{type:'zone',shape:'advance',points:[[49.6,34.7],[49.6,35.3],[50.2,35.3],[50.2,34.7]]}});
 assert.equal(hostAdvance.status,200);assert.equal(hostAdvance.data.room.zones.length,3);
 const resume=await post(base,`/api/rooms/${code}/resume`,{token:guest});assert.equal(resume.status,200);assert.equal(resume.data.playerIndex,1);
 const exported=await fetch(base+`/api/rooms/${code}/export?token=${guest}`);assert.equal(exported.status,200);const saved=await exported.text();assert.doesNotMatch(saved,new RegExp(host));assert.equal(JSON.parse(saved).zones.length,3);
 await reader.cancel();
 await new Promise(r=>server.close(r));
 ({server,base}=await appAt(dir));
 const resumed=await post(base,`/api/rooms/${code}/resume`,{token:host});assert.equal(resumed.status,200);assert.equal(resumed.data.room.zones.length,3);
});
