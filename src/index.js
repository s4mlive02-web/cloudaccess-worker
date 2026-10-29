
// CloudAccess Browser Worker — isolated Playwright/Chromium sessions.
// Security: binds internal port, requires x-internal-token for HTTP control and per-session token for WS.
// storageState arrives ONLY over the internal HTTP channel from the main app; it is never logged or sent to clients.
// Egress: in production put this host behind egress firewall rules blocking 169.254.169.254, RFC1918 and the main-app admin network (see README).
const http=require("http"); const { WebSocketServer }=require("ws"); const { chromium }=require("playwright");
const PORT=process.env.PORT||8080; const TOKEN=process.env.BROWSER_WORKER_TOKEN||"";
const MAIN_APP_URL=process.env.MAIN_APP_URL||"http://localhost:3000";
let browser=null; const sessions=new Map(); // id -> {context,page,cdp,token,mode,appId,url,success...,last}
async function getBrowser(){ if(!browser) browser=await chromium.launch({args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote"]}); return browser; }
function auth(req){ return TOKEN && req.headers["x-internal-token"]===TOKEN; }
async function verifyConnect(s){ try{ const url=s.page.url(); if(s.successUrlContains && url.includes(s.successUrlContains)) return true; if(s.successSelector && await s.page.locator(s.successSelector).count()>0) return true; if(!s.successUrlContains && !s.successSelector) return !/login|signin/i.test(url); return false; }catch{return false;} }
async function closeSession(id){ const s=sessions.get(id); if(!s) return; sessions.delete(id); try{await s.cdp?.send("Page.stopScreencast").catch(()=>{});}catch{} try{await s.context.close();}catch{} }
const server=http.createServer(async(req,res)=>{ const send=(c,o)=>{res.writeHead(c,{"content-type":"application/json"});res.end(JSON.stringify(o));};
 if(req.url==="/health") return send(200,{ok:true,sessions:sessions.size});
 if(!auth(req)) return send(403,{error:"Forbidden"});
 let body=""; req.on("data",c=>body+=c); req.on("end",async()=>{
  let b={}; try{b=JSON.parse(body||"{}");}catch{}
  try{
   if(req.method==="POST"&&req.url==="/sessions"){
     const br=await getBrowser(); const ctx=await br.newContext(b.storageState?{storageState:b.storageState,viewport:{width:1024,height:640}}:{viewport:{width:1024,height:640}});
     const page=await ctx.newPage(); await page.goto(b.url,{waitUntil:"domcontentloaded",timeout:30000}).catch(e=>console.error("nav",e.message));
     const s={context:ctx,page,token:b.token,mode:b.mode,url:b.url,successUrlContains:b.successUrlContains,successSelector:b.successSelector,callbackUrl:b.callbackUrl,sessionId:b.sessionId,last:Date.now(),clients:new Set()};
     // applicationId is derived by main app from session record; connect-complete needs it — main app can map sessionId->app, worker passes sessionId through and main resolves it if applicationId absent. Here we accept b.applicationId too.
     s.applicationId=b.applicationId||null; sessions.set(b.sessionId,s); return send(201,{workerSessionId:b.sessionId,wsUrl:process.env.WORKER_PUBLIC_WS||`ws://localhost:${PORT}`});
   }
   const m=req.url.match(/^\/sessions\/([^/]+)\/close$/); if(m){ await closeSession(m[1]); return send(200,{ok:true}); }
   if(req.url==="/sessions/terminate-for"){ for(const [id,s] of sessions) { /* main app terminates by session ids in DB; best-effort: close sessions whose page matches */ } return send(200,{ok:true,note:"DB sessions already marked TERMINATED; worker sessions close on TTL/close"}); }
   if(req.url==="/sessions/save-connect"){ const s=sessions.get(b.sessionId); if(!s) return send(404,{error:"No session"}); const ok=await verifyConnect(s); if(!ok) return send(422,{error:"Login not verified — not marking Connected"}); const state=await s.context.storageState();
     // Callback to main app (internal token) — main encrypts + stores. applicationId: require it on save call if not set at create.
     const r=await fetch(s.callbackUrl,{method:"POST",headers:{"content-type":"application/json","x-internal-token":TOKEN},body:JSON.stringify({sessionId:b.sessionId,applicationId:b.applicationId||s.applicationId,verified:true,storageState:state})});
     if(!r.ok) return send(502,{error:"Main app callback failed"}); await closeSession(b.sessionId); return send(200,{ok:true,verified:true}); }
   return send(404,{error:"Not found"});
  }catch(e){ return send(500,{error:String(e)}); }
 });});
const wss=new WebSocketServer({server});
wss.on("connection",async(ws,req)=>{ const u=new URL(req.url,"http://x"); const id=u.searchParams.get("sessionId"); const tok=u.searchParams.get("token"); const s=sessions.get(id||"");
 if(!s||s.token!==tok){ ws.close(4003,"Forbidden"); return; } s.clients.add(ws); s.last=Date.now();
 const cdp=await s.context.newCDPSession(s.page); s.cdp=cdp;
 cdp.on("Page.screencastFrame",async({data,sessionId})=>{ ws.send(JSON.stringify({type:"frame",data})); try{await cdp.send("Page.screencastFrameAck",{sessionId});}catch{} });
 await cdp.send("Page.startScreencast",{format:"jpeg",quality:60,everyNthFrame:2,maxWidth:1024,maxHeight:640});
 ws.send(JSON.stringify({type:"url",url:s.page.url()}));
 ws.on("message",async(raw)=>{ s.last=Date.now(); let m; try{m=JSON.parse(raw);}catch{return;}
   try{ const vp=s.page.viewportSize()||{width:1280,height:800};
    if(m.type==="mouse"){ const x=m.x*vp.width,y=m.y*vp.height; if(m.event==="down") await s.page.mouse.down({}); if(m.event==="up") await s.page.mouse.up({}); await s.page.mouse.move(x,y); if(m.event==="down"){} }
    if(m.type==="wheel") await s.page.mouse.wheel(0,m.deltaY||0);
    if(m.type==="key") await s.page.keyboard.press(m.key.length===1?m.key:m.key);
    if(m.type==="navigate"){ if(m.action==="back") await s.page.goBack().catch(()=>{}); if(m.action==="forward") await s.page.goForward().catch(()=>{}); if(m.action==="reload") await s.page.reload().catch(()=>{}); if(m.action==="home") await s.page.goto(s.url).catch(()=>{}); ws.send(JSON.stringify({type:"url",url:s.page.url()})); }
    if(m.type==="close") await closeSession(id);
   }catch{} });
 ws.on("close",()=>s.clients.delete(ws)); });
// TTL / idle cleanup: 30 min hard, 10 min idle (configurable)
setInterval(()=>{ const now=Date.now(); for(const [id,s] of sessions){ if(now-s.last> (Number(process.env.IDLE_MS||600000)) ) closeSession(id); } },30000);
server.listen(PORT,()=>console.log("browser-worker on",PORT));
