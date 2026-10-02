'use strict';
// Node.js 20+, zero npm dependencies. Authoritative two-player turn-based map room server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BODY = 120000;
const MAX_ROOMS = 200;
const MAX_ZONES = 400;
const TTL_MS = 48 * 60 * 60 * 1000;
const FRONTLINE_FALLBACK = '20260928'; // Verified existing public mirror snapshot; shown as dated, never as live.
const frontBase = 'https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data/';
const frontTree = 'https://api.github.com/repos/cyterat/deepstate-map-data/git/trees/main?recursive=1';
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function error(res, status, message) { sendJSON(res, status, {error: message}); }
function sendJSON(res, status, object) {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(object));}
function randomCode() {let code='';for(let i=0;i<6;i++) code+=CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];return code;}
function token() {return crypto.randomBytes(24).toString('base64url');}
function nameOf(value) {return String(value||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,28)||'Игрок';}
function readBody(req) {return new Promise((resolve,reject)=>{let body='';req.on('data',part=>{body+=part;if(body.length>MAX_BODY){reject({status:413,message:'Слишком большой запрос'});req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(body||'{}'))}catch{reject({status:400,message:'Некорректный JSON'})}});req.on('error',reject);});}
function validPoints(points) {
 if(!Array.isArray(points)||points.length<3||points.length>160) return false;
 if(!points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=-80&&p[0]<=80&&p[1]>=-180&&p[1]<=180)) return false;
 let signed=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];signed+=a[1]*b[0]-b[1]*a[0];}
 if(Math.abs(signed)<1e-9) return false;
 // Disallow self-intersection, including bow-tie geometries.
 function orient(a,b,c){return(b[1]-a[1])*(c[0]-a[0])-(b[0]-a[0])*(c[1]-a[1]);}
 function onSeg(a,b,c){return Math.min(a[0],b[0])<=c[0]+1e-10&&c[0]<=Math.max(a[0],b[0])+1e-10&&Math.min(a[1],b[1])<=c[1]+1e-10&&c[1]<=Math.max(a[1],b[1])+1e-10;}
 function intersects(a,b,c,d){let ab1=orient(a,b,c),ab2=orient(a,b,d),cd1=orient(c,d,a),cd2=orient(c,d,b);if((ab1>0&&ab2<0||ab1<0&&ab2>0)&&(cd1>0&&cd2<0||cd1<0&&cd2>0))return true;return Math.abs(ab1)<1e-10&&onSeg(a,b,c)||Math.abs(ab2)<1e-10&&onSeg(a,b,d)||Math.abs(cd1)<1e-10&&onSeg(c,d,a)||Math.abs(cd2)<1e-10&&onSeg(c,d,b);}
 for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++){
  if(i===j||((i+1)%points.length)===j||i===((j+1)%points.length))continue;
  if(intersects(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]))return false;
 }
 return true;
}
function pointInPoly(p, pts){let inside=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++) {let a=pts[i],b=pts[j];if(((a[0]>p[0])!==(b[0]>p[0]))&&(p[1]<(b[1]-a[1])*(p[0]-a[0])/(b[0]-a[0])+a[1]))inside=!inside;}return inside;}
function touching(a,b){
 if(a.some(p=>pointInPoly(p,b))||b.some(p=>pointInPoly(p,a)))return true;
 const orient=(p,q,r)=>(q[1]-p[1])*(r[0]-p[0])-(q[0]-p[0])*(r[1]-p[1]);
 for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){
  const p=a[i],q=a[(i+1)%a.length],r=b[j],s=b[(j+1)%b.length];
  const x=orient(p,q,r),y=orient(p,q,s),z=orient(r,s,p),w=orient(r,s,q);
  if(((x<=0&&y>=0)||(x>=0&&y<=0))&&((z<=0&&w>=0)||(z>=0&&w<=0))){
   const bA=[Math.min(p[0],q[0]),Math.max(p[0],q[0]),Math.min(p[1],q[1]),Math.max(p[1],q[1])];
   const bB=[Math.min(r[0],s[0]),Math.max(r[0],s[0]),Math.min(r[1],s[1]),Math.max(r[1],s[1])];
   if(bA[0]<=bB[1]+1e-9&&bB[0]<=bA[1]+1e-9&&bA[2]<=bB[3]+1e-9&&bB[2]<=bA[3]+1e-9)return true;
  }
 }
 return false;
}
function createGameServer(options={}) {
 const dataDir=options.dataDir||process.env.DATA_DIR||path.join(__dirname,'data');
 fs.mkdirSync(dataDir,{recursive:true});
 const savePath=path.join(dataDir,'rooms.json');
 const rooms=new Map();
 const streams=new Map(); // room code -> Map<token, Set<ServerResponse>>; never serialized
 let cache=null, cacheAt=0, inFlight=null;
 try{
  const loaded=JSON.parse(fs.readFileSync(savePath,'utf8'));
  if(Array.isArray(loaded))for(const room of loaded){
   if(room&&/^[A-Z2-9]{6}$/.test(room.code)&&Array.isArray(room.players)&&room.updatedAt>Date.now()-TTL_MS&&Array.isArray(room.zones))rooms.set(room.code,room);
  }
 }catch{}
 function save(){const tmp=savePath+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...rooms.values()]));fs.renameSync(tmp,savePath);}
 function status(room){return {code:room.code,players:room.players.map(p=>({name:p.name,side:p.side,joined:true,connected:!!streams.get(room.code)?.get(p.token)?.size})),turn:room.turn,round:room.round,zones:room.zones,history:room.history,revision:room.revision,ready:room.players.length===2,updatedAt:room.updatedAt};}
 function broadcast(room){const data=`event: snapshot\ndata: ${JSON.stringify(status(room))}\n\n`;for(const set of streams.get(room.code)?.values()||[])for(const res of set){try{res.write(data)}catch{}}}
 function authenticate(room, value){if(typeof value!=='string'||value.length>80)return -1;return room.players.findIndex(p=>p.token===value);}
 function change(room){room.revision++;room.updatedAt=Date.now();save();broadcast(room);}
 function cleanup(){let mutated=false;for(const [code,room] of rooms){if(room.updatedAt<Date.now()-TTL_MS){rooms.delete(code);mutated=true;for(const set of streams.get(code)?.values()||[])for(const res of set)res.end();streams.delete(code);}}if(mutated)save();}
 const cleaner=setInterval(cleanup,60*60*1000);cleaner.unref();
 async function getFrontline(){
  if(cache&&Date.now()-cacheAt<6*60*60*1000)return cache;
  if(inFlight)return inFlight;
  inFlight=(async()=>{
   let date=FRONTLINE_FALLBACK;
   try{
    const r=await fetch(frontTree,{headers:{'User-Agent':'frontline-duel-map/1.0','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(9000)});
    if(r.ok){const data=await r.json();const dates=(data.tree||[]).map(e=>/^data\/deepstatemap_data_(\d{8})\.geojson$/.exec(e.path||'')).filter(Boolean).map(m=>m[1]).sort();if(dates.length)date=dates[dates.length-1];}
   }catch{}
   for(const d of [...new Set([date,FRONTLINE_FALLBACK])]){
    try{
     const r=await fetch(frontBase+'deepstatemap_data_'+d+'.geojson',{signal:AbortSignal.timeout(12000)});
     if(!r.ok)continue;
     const geojson=await r.json();if(!geojson||typeof geojson!=='object'||!geojson.type)continue;
     cache={date:`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`,geojson,source:'cyterat/deepstate-map-data — общественное зеркало, не официальный API',fetchedAt:new Date().toISOString()};cacheAt=Date.now();return cache;
    }catch{}
   }
   if(cache)return cache;
   throw Error('Публичный источник данных временно недоступен');
  })();try{return await inFlight}finally{inFlight=null;}
 }
 const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin){try{if(new URL(origin).host!==req.headers.host)return error(res,403,'Другой источник запрещён');}catch{return error(res,403,'Некорректный Origin')}}
  let url;try{url=new URL(req.url,'http://localhost')}catch{return error(res,400,'Некорректный адрес')}
  const route=url.pathname;
  if(req.method==='GET'&&(route==='/'||route==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});return res.end(INDEX)}
  if(req.method==='GET'&&route==='/api/health')return sendJSON(res,200,{ok:true,rooms:rooms.size});
  if(req.method==='GET'&&route==='/api/frontline') {try{return sendJSON(res,200,await getFrontline())}catch{return error(res,503,'Не удалось получить слой. Игра доступна без него.')}}
  if(req.method==='POST'&&route==='/api/rooms'){
   try{
    const body=await readBody(req);
    if(rooms.size>=MAX_ROOMS)return error(res,429,'Лимит комнат. Попробуй позднее.');
    let code=randomCode();while(rooms.has(code))code=randomCode();
    const side=body.side==='ru'?'ru':'ua';const secret=token();
    const room={code,players:[{name:nameOf(body.name),side,token:secret}],turn:0,round:1,zones:[],history:[],revision:0,createdAt:Date.now(),updatedAt:Date.now()};
    rooms.set(code,room);save();return sendJSON(res,201,{room:status(room),token:secret,playerIndex:0});
   }catch(e){return error(res,e.status||500,e.message||'Не удалось создать комнату')}
  }
  const m=/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|resume|events|action|export))?$/.exec(route);
  if(!m)return error(res,404,'Маршрут не найден');
  const room=rooms.get(m[1]);if(!room)return error(res,404,'Комната не найдена или устарела');
  const what=m[2]||'';
  if(req.method==='POST'&&what==='join'){
   try{const body=await readBody(req);
    if(room.players.length>=2)return error(res,409,'В комнате уже два игрока');
    const secret=token();room.players.push({name:nameOf(body.name),side:room.players[0].side==='ua'?'ru':'ua',token:secret});change(room);
    return sendJSON(res,200,{room:status(room),token:secret,playerIndex:1});
   }catch(e){return error(res,e.status||500,e.message||'Ошибка подключения')}
  }
  if(req.method==='POST'&&what==='resume'){
   try{const body=await readBody(req);const playerIndex=authenticate(room,body.token);if(playerIndex<0)return error(res,403,'Неверный ключ игрока');return sendJSON(res,200,{room:status(room),token:body.token,playerIndex});}
   catch(e){return error(res,e.status||500,e.message||'Ошибка восстановления')}
  }
  if(req.method==='GET'&&what==='events'){
   const secret=url.searchParams.get('token');const playerIndex=authenticate(room,secret);
   if(playerIndex<0)return error(res,403,'Неверный ключ игрока');
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','Referrer-Policy':'no-referrer'});
   res.write(': joined\nretry: 2000\n\n');
   let byToken=streams.get(room.code);if(!byToken){byToken=new Map();streams.set(room.code,byToken)}
   let set=byToken.get(secret);if(!set){set=new Set();byToken.set(secret,set)}set.add(res);
   broadcast(room);
   const ping=setInterval(()=>{try{res.write(': keepalive\n\n')}catch{}},22000);
   req.on('close',()=>{clearInterval(ping);set.delete(res);if(!set.size)byToken.delete(secret);if(!byToken.size)streams.delete(room.code);broadcast(room)});
   return;
  }
  if(req.method==='GET'&&what==='export'){
   const secret=url.searchParams.get('token');if(authenticate(room,secret)<0)return error(res,403,'Неверный ключ игрока');
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="party-${room.code}.json"`,'Cache-Control':'no-store'});
   return res.end(JSON.stringify(status(room),null,2));
  }
  if(req.method==='POST'&&what==='action'){
   try{const body=await readBody(req);const index=authenticate(room,body.token);if(index<0)return error(res,403,'Неверный ключ игрока');
    if(room.players.length!==2)return error(res,409,'Дождись второго игрока');
    if(room.turn!==index)return error(res,409,'Сейчас не твой ход');
    if(room.zones.length>=MAX_ZONES)return error(res,409,'Лимит зон этой партии');
    const action=body.action;if(!action||!['zone','pass'].includes(action.type))return error(res,422,'Некорректный ход');
    let move={id:crypto.randomUUID(),player:index,type:action.type,time:new Date().toISOString(),round:room.round};
    if(action.type==='zone'){
     const shape=action.shape;
     if(!['polygon','rectangle','advance'].includes(shape)||!validPoints(action.points))return error(res,422,'Некорректный полигон');
     if(shape==='rectangle'&&action.points.length!==4)return error(res,422,'Прямоугольник должен иметь 4 вершины');
     if(shape==='advance'&&!room.zones.some(z=>z.player===index&&touching(z.points,action.points)))return error(res,422,'Продвижение должно соприкасаться с одной из твоих зон');
     move.shape=shape;move.points=action.points.map(p=>[p[0],p[1]]);room.zones.push(move);
    }
    room.history.push({id:move.id,player:index,type:move.type,shape:move.shape||null,round:room.round,time:move.time});
    room.turn=1-index;if(index===1)room.round++;
    change(room);return sendJSON(res,200,{room:status(room)});
   }catch(e){return error(res,e.status||500,e.message||'Ошибка хода')}
  }
  return error(res,405,'Метод не поддерживается');
 });
 server.on('close',()=>clearInterval(cleaner));
 return server;
}
if(require.main===module){const PORT=Number(process.env.PORT)||3000;const app=createGameServer();app.listen(PORT,'0.0.0.0',()=>console.log(`Frontline Duel Online: http://localhost:${PORT}`));}
module.exports={createGameServer,validPoints,touching};
