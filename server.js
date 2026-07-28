const express = require("express");
const ftp = require("basic-ftp");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const FTP_HOST = String(process.env.FTP_HOST || "ftpupload.net");
const FTP_PORT = Number(process.env.FTP_PORT || 21);
const FTP_USER = String(process.env.FTP_USER || "");
const FTP_PASSWORD = String(process.env.FTP_PASSWORD || "");
const FTP_USERS_PATH = String(process.env.FTP_USERS_PATH || "/htdocs/usuarios.json");
const FTP_SERVERS_PATH = String(process.env.FTP_SERVERS_PATH || "/htdocs/servidores/servidores.json");

const USERS_CACHE_SECONDS = clamp(process.env.USERS_CACHE_SECONDS || 30, 5, 300);
const SERVERS_CACHE_SECONDS = clamp(process.env.SERVERS_CACHE_SECONDS || 15, 5, 300);
const API_CACHE_SECONDS = clamp(process.env.API_CACHE_SECONDS || 60, 0, 900);
const REQUEST_TIMEOUT_MS = clamp(process.env.REQUEST_TIMEOUT_MS || 45000, 5000, 120000);

const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "p2player2026");
const SIGNING_KEY = String(process.env.PROXY_SIGNING_KEY || ACCESS_TOKEN || "p2playerproxy2026");

let usersCache = { data:null, expiresAt:0, loadedAt:null, error:null };
let serversCache = { data:null, expiresAt:0, loadedAt:null, error:null };
const apiCache = new Map();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.urlencoded({ extended:false }));
app.use(express.json({ limit:"256kb" }));

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,HEAD,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers","Origin,Accept,Content-Type,Authorization,Range");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function clamp(v,min,max){
  const n = Number(v);
  return Math.max(min,Math.min(max,Number.isFinite(n)?n:min));
}

async function ftpJson(remotePath){
  if(!FTP_USER || !FTP_PASSWORD) throw new Error("FTP_USER/FTP_PASSWORD não configurados no Render.");

  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  const temp = path.join(os.tmpdir(), `p2-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

  try{
    await client.access({
      host:FTP_HOST, port:FTP_PORT, user:FTP_USER, password:FTP_PASSWORD,
      secure:false
    });
    await client.downloadTo(temp,remotePath);
    const raw = await fs.readFile(temp,"utf8");
    return JSON.parse(raw);
  }finally{
    client.close();
    await fs.unlink(temp).catch(()=>{});
  }
}

async function getUsers(force=false){
  const now=Date.now();
  if(!force && Array.isArray(usersCache.data) && usersCache.expiresAt>now) return usersCache.data;

  try{
    const json=await ftpJson(FTP_USERS_PATH);
    if(!json || !Array.isArray(json.usuarios)) throw new Error("usuarios.json sem campo usuarios.");
    usersCache={data:json.usuarios,expiresAt:now+USERS_CACHE_SECONDS*1000,loadedAt:new Date().toISOString(),error:null};
    return usersCache.data;
  }catch(e){
    usersCache.error=String(e?.message||e);
    if(Array.isArray(usersCache.data)) return usersCache.data;
    throw e;
  }
}

function normalizeServerObject(s,id){
  if(!s || typeof s!=="object") throw new Error("Servidor ativo inválido.");
  const server=String(s.server ?? s.servidor ?? "").replace(/\/+$/,"");
  const usuario=String(s.usuario ?? s["usuário"] ?? "");
  const senha=String(s.senha ?? "");
  if(!server || !usuario || !senha) throw new Error(`Servidor ${id} sem server/usuario/senha.`);

  return {
    id,
    nome:String(s.nome || id),
    status:String(s.status || "ativo"),
    server, usuario, senha,
    live_template:String(s.live_template || "{server}/live/{user}/{pass}/{id}.m3u8"),
    movie_template:String(s.movie_template || "{server}/movie/{user}/{pass}/{id}.{ext}"),
    series_template:String(s.series_template || "{server}/series/{user}/{pass}/{id}.{ext}"),
    m3u_template:String(s.m3u_template || "{server}/get.php?username={user}&password={pass}&type=m3u_plus&output=m3u8")
  };
}

async function getActiveServer(force=false){
  const now=Date.now();

  if(!force && serversCache.data && serversCache.expiresAt>now) return serversCache.data;

  try{
    const cfg=await ftpJson(FTP_SERVERS_PATH);
    const id=String(cfg?.ativo || "");
    const raw=cfg?.servidores?.[id];
    if(!id || !raw) throw new Error("Nenhum servidor ativo no servidores.json.");

    const active=normalizeServerObject(raw,id);
    const fingerprint=crypto.createHash("sha1")
      .update(JSON.stringify([active.id,active.server,active.usuario,active.senha,active.live_template,active.movie_template,active.series_template]))
      .digest("hex").slice(0,12);

    serversCache={
      data:{...active,fingerprint},
      expiresAt:now+SERVERS_CACHE_SECONDS*1000,
      loadedAt:new Date().toISOString(),
      error:null
    };

    // Troca de origem invalida cache de catálogo/API.
    for(const key of apiCache.keys()){
      if(!key.startsWith(fingerprint+":")) apiCache.delete(key);
    }

    return serversCache.data;
  }catch(e){
    serversCache.error=String(e?.message||e);
    if(serversCache.data) return serversCache.data;
    throw e;
  }
}

function fillTemplate(tpl,s,extra={}){
  return String(tpl||"")
    .replaceAll("{server}",String(s.server||"").replace(/\/+$/,""))
    .replaceAll("{user}",String(s.usuario||""))
    .replaceAll("{pass}",String(s.senha||""))
    .replaceAll("{id}",String(extra.id??""))
    .replaceAll("{ext}",String(extra.ext??""));
}

function isExpired(validade){
  const v=String(validade||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
  const end=new Date(`${v}T23:59:59-03:00`);
  return Number.isNaN(end.getTime()) || Date.now()>end.getTime();
}

async function validateClient(username,password){
  const usuarios=await getUsers();
  const u=String(username||"").trim().toLowerCase();
  const p=String(password||"");

  const client=usuarios.find(x=>
    x && typeof x==="object" &&
    String(x.usuario||"").trim().toLowerCase()===u &&
    String(x.senha||"")===p
  );

  if(!client) return {ok:false,status:"Disabled",message:"Usuário ou senha inválidos."};

  const st=String(client.status||"ativo").trim().toLowerCase();
  const blocked=client.bloqueado===true || ["bloqueado","inativo","suspenso","desativado"].includes(st);
  if(blocked) return {ok:false,status:"Disabled",message:"Conta bloqueada."};
  if(isExpired(client.validade)) return {ok:false,status:"Expired",message:"Conta vencida.",validade:String(client.validade||"")};

  return {
    ok:true,status:"Active",nome:String(client.nome||""),
    validade:String(client.validade||""),tipo_conta:String(client.tipo_conta||"cliente")
  };
}

function credentials(req){
  return {
    username:String(req.query.username || req.body?.username || req.params.username || "").trim(),
    password:String(req.query.password || req.body?.password || req.params.password || "")
  };
}

async function fetchWithTimeout(url,opts={},timeoutMs=REQUEST_TIMEOUT_MS){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);

  try{
    return await fetch(url,{
      redirect:"follow",
      ...opts,
      signal:controller.signal,
      headers:{
        "user-agent":"Mozilla/5.0 (compatible; P2PlayerGateway/6.0)",
        "accept":"*/*",
        "accept-encoding":"identity",
        ...(opts.headers||{})
      }
    });
  }finally{
    clearTimeout(timer);
  }
}

async function originJson(action="",extra={}){
  const s=await getActiveServer();
  const params=new URLSearchParams({username:s.usuario,password:s.senha});
  if(action) params.set("action",action);
  for(const [k,v] of Object.entries(extra)){
    if(v!==undefined && v!==null && v!=="") params.set(k,String(v));
  }

  const url=`${s.server}/player_api.php?${params.toString()}`;
  const cacheKey=`${s.fingerprint}:${url}`;
  const cached=apiCache.get(cacheKey);
  const now=Date.now();

  if(API_CACHE_SECONDS>0 && cached && cached.expiresAt>now) return cached.data;

  const r=await fetchWithTimeout(url,{headers:{accept:"application/json,*/*"}});
  if(!r.ok) throw new Error(`Origem HTTP ${r.status}`);

  const text=await r.text();
  let data;
  try{ data=JSON.parse(text); }
  catch{ throw new Error(`Origem não retornou JSON válido (${text.length} bytes).`); }

  if(API_CACHE_SECONDS>0){
    apiCache.set(cacheKey,{data,expiresAt:now+API_CACHE_SECONDS*1000});
  }
  return data;
}

function disabledLogin(username,password,req,message="Conta inválida ou vencida."){
  const now=Math.floor(Date.now()/1000);
  return {
    user_info:{
      username,password,message,auth:0,status:"Disabled",exp_date:"0",
      is_trial:"0",active_cons:"0",created_at:String(now),max_connections:"3",
      allowed_output_formats:["m3u8","ts","rtmp"]
    },
    server_info:{
      url:req.hostname||"",port:"443",https_port:"443",server_protocol:"https",
      rtmp_port:"0",timezone:"America/Sao_Paulo",timestamp_now:now,
      time_now:new Date().toISOString().replace("T"," ").slice(0,19)
    }
  };
}

function activeLogin(originData,username,password,req,client){
  const now=Math.floor(Date.now()/1000);
  const ou=originData?.user_info||{};
  const osrv=originData?.server_info||{};
  let expiry=0;
  if(client.validade){
    const d=new Date(`${client.validade}T23:59:59-03:00`);
    if(!Number.isNaN(d.getTime())) expiry=Math.floor(d.getTime()/1000);
  }

  return {
    ...originData,
    user_info:{
      ...ou,username,password,
      message:client.nome?`P2 Player • ${client.nome}`:"P2 Player",
      auth:1,status:"Active",exp_date:expiry?String(expiry):String(ou.exp_date||"0"),
      active_cons:"0",max_connections:"3",
      allowed_output_formats:Array.isArray(ou.allowed_output_formats)?ou.allowed_output_formats:["m3u8","ts","rtmp"]
    },
    server_info:{
      ...osrv,url:req.hostname||"",port:"443",https_port:"443",server_protocol:"https",
      rtmp_port:"0",timestamp_now:now,time_now:new Date().toISOString().replace("T"," ").slice(0,19),
      timezone:osrv.timezone||"America/Sao_Paulo"
    }
  };
}

function b64url(s){ return Buffer.from(String(s),"utf8").toString("base64url"); }
function fromB64url(s){ return Buffer.from(String(s),"base64url").toString("utf8"); }
function signTarget(target,scope){
  return crypto.createHmac("sha256",SIGNING_KEY).update(`${scope}\n${target}`).digest("base64url");
}
function verifyTarget(target,scope,sig){
  const expected=signTarget(target,scope);
  try{
    return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(String(sig||"")));
  }catch{return false;}
}
function absoluteUrl(value,base){
  try{return new URL(value,base).toString();}catch{return value;}
}
async function writeDrain(res,data){
  if(!res.write(data)) await once(res,"drain");
}

function publicBase(req){
  const proto=req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function clientRelayUrl(req,username,password,target){
  const scope=`client:${username}:${password}`;
  const u=b64url(target);
  const sig=signTarget(target,scope);
  return `${publicBase(req)}/relay/${encodeURIComponent(username)}/${encodeURIComponent(password)}?u=${encodeURIComponent(u)}&sig=${encodeURIComponent(sig)}`;
}

function tokenResourceUrl(req,target){
  const scope=`token:${ACCESS_TOKEN}`;
  const u=b64url(target);
  const sig=signTarget(target,scope);
  return `${publicBase(req)}/resource?token=${encodeURIComponent(ACCESS_TOKEN)}&u=${encodeURIComponent(u)}&sig=${encodeURIComponent(sig)}`;
}

async function proxyUpstream(req,res,target,urlBuilder){
  const headers={};
  if(req.headers.range) headers.range=req.headers.range;

  const upstream=await fetchWithTimeout(target,{headers},120000);
  if(!upstream.ok && upstream.status!==206){
    return res.status(upstream.status || 502).send(`Origem HTTP ${upstream.status}`);
  }

  const contentType=String(upstream.headers.get("content-type")||"");
  const isManifest=
    contentType.includes("mpegurl") ||
    /\.m3u8(?:$|\?)/i.test(target);

  res.status(upstream.status);
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control",isManifest?"no-store":"public, max-age=15");

  if(isManifest){
    res.setHeader("Content-Type","application/vnd.apple.mpegurl; charset=utf-8");
    const text=await upstream.text();
    const lines=text.split(/\r?\n/);
    const out=[];

    for(const line of lines){
      const trim=line.trim();

      if(!trim){
        out.push(line);
        continue;
      }

      if(trim.startsWith("#")){
        const replaced=line.replace(/URI="([^"]+)"/g,(_m,uri)=>{
          const abs=absoluteUrl(uri,target);
          return `URI="${urlBuilder(abs)}"`;
        });
        out.push(replaced);
        continue;
      }

      out.push(urlBuilder(absoluteUrl(trim,target)));
    }

    return res.send(out.join("\n"));
  }

  const passHeaders=["content-type","content-length","accept-ranges","content-range","last-modified","etag"];
  for(const h of passHeaders){
    const v=upstream.headers.get(h);
    if(v) res.setHeader(h,v);
  }

  if(!upstream.body) return res.end();

  const reader=upstream.body.getReader();
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done) break;
      await writeDrain(res,Buffer.from(value));
    }
  }finally{
    try{reader.releaseLock();}catch{}
    res.end();
  }
}

async function rewriteM3U(req,res,username,password){
  const s=await getActiveServer();
  const source=fillTemplate(s.m3u_template,s);
  const upstream=await fetchWithTimeout(source,{},120000);

  if(!upstream.ok || !upstream.body){
    return res.status(502).send(`Falha ao obter lista: HTTP ${upstream.status}`);
  }

  res.status(200);
  res.setHeader("Content-Type","application/x-mpegURL; charset=utf-8");
  res.setHeader("Content-Disposition",'inline; filename="p2player.m3u"');
  res.setHeader("Cache-Control","private, no-store");

  const reader=upstream.body.getReader();
  const decoder=new TextDecoder();
  let buffer="";

  while(true){
    const {value,done}=await reader.read();
    if(done) break;
    buffer+=decoder.decode(value,{stream:true});

    let idx;
    while((idx=buffer.indexOf("\n"))!==-1){
      let line=buffer.slice(0,idx);
      buffer=buffer.slice(idx+1);
      if(line.endsWith("\r")) line=line.slice(0,-1);

      const trim=line.trim();
      if(/^https?:\/\//i.test(trim)){
        line=clientRelayUrl(req,username,password,trim);
      }
      await writeDrain(res,line+"\n");
    }
  }

  buffer+=decoder.decode();
  if(buffer){
    const trim=buffer.trim();
    await writeDrain(res,/^https?:\/\//i.test(trim)?clientRelayUrl(req,username,password,trim):buffer);
  }
  res.end();
}

app.get("/",async (_req,res)=>{
  try{
    const s=await getActiveServer();
    res.json({
      ok:true,
      service:"P2 Player Universal Gateway V6",
      activeServer:{id:s.id,nome:s.nome},
      usersCached:Array.isArray(usersCache.data),
      configLoadedAt:serversCache.loadedAt
    });
  }catch(e){
    res.status(503).json({ok:false,error:String(e?.message||e)});
  }
});

app.get("/health",(_req,res)=>res.json({ok:true,uptimeSeconds:Math.floor(process.uptime())}));

app.get("/config-debug",async (_req,res)=>{
  try{
    const s=await getActiveServer(true);
    res.json({
      ok:true,
      active:{id:s.id,nome:s.nome,server:s.server,status:s.status},
      liveTemplate:s.live_template,
      loadedAt:serversCache.loadedAt
    });
  }catch(e){res.status(502).json({ok:false,error:String(e?.message||e)});}
});

app.get("/ftp-debug",async (_req,res)=>{
  try{
    const [users,s]=await Promise.all([getUsers(true),getActiveServer(true)]);
    res.json({ok:true,users:users.length,activeServer:{id:s.id,nome:s.nome},usersLoadedAt:usersCache.loadedAt,configLoadedAt:serversCache.loadedAt});
  }catch(e){res.status(502).json({ok:false,error:String(e?.message||e)});}
});

async function handlePlayerApi(req,res){
  const {username,password}=credentials(req);
  const action=String(req.query.action || req.body?.action || "").trim();

  try{
    const client=await validateClient(username,password);

    if(!client.ok){
      if(!action) return res.json(disabledLogin(username,password,req,client.message));
      return res.status(401).json([]);
    }

    if(!action){
      const origin=await originJson("");
      return res.json(activeLogin(origin,username,password,req,client));
    }

    const allowed=new Set([
      "get_live_categories","get_live_streams","get_vod_categories","get_vod_streams",
      "get_vod_info","get_series_categories","get_series","get_series_info",
      "get_short_epg","get_simple_data_table"
    ]);
    if(!allowed.has(action)) return res.status(400).json({error:"Ação não suportada."});

    const extra={};
    for(const key of ["category_id","series_id","vod_id","stream_id","limit","start"]){
      const v=req.query[key] ?? req.body?.[key];
      if(v!==undefined && v!=="") extra[key]=v;
    }

    return res.json(await originJson(action,extra));
  }catch(e){
    console.error("[player_api]",action||"login",String(e?.message||e));
    if(!action) return res.json(disabledLogin(username,password,req,"Servidor temporariamente indisponível."));
    return res.status(502).json({error:"Falha temporária ao consultar catálogo."});
  }
}
app.get("/player_api.php",handlePlayerApi);
app.post("/player_api.php",handlePlayerApi);

app.get("/get.php",async (req,res)=>{
  const {username,password}=credentials(req);
  try{
    const client=await validateClient(username,password);
    if(!client.ok) return res.status(401).send("#EXTM3U\n# Conta inválida ou vencida\n");
    return await rewriteM3U(req,res,username,password);
  }catch(e){
    console.error("[get.php]",String(e?.message||e));
    if(!res.headersSent) res.status(502).send("Falha temporária ao gerar lista.");
    else res.end();
  }
});

// Web player: mantém compatibilidade com https://p2player-proxy.../live/ID?token=...
app.get(["/live/:id","/live/:id.m3u8"],async (req,res,next)=>{
  if(req.params.username) return next();
  const token=String(req.query.token||"");
  if(!token || token!==ACCESS_TOKEN) return res.status(401).send("Token inválido.");

  try{
    const s=await getActiveServer();
    const id=String(req.params.id||"").replace(/[^0-9A-Za-z_-]/g,"");
    const target=fillTemplate(s.live_template,s,{id,ext:"m3u8"});
    return await proxyUpstream(req,res,target,t=>tokenResourceUrl(req,t));
  }catch(e){
    console.error("[web-live]",String(e?.message||e));
    if(!res.headersSent) res.status(502).send("Falha no canal.");
  }
});

app.get("/resource",async (req,res)=>{
  const token=String(req.query.token||"");
  if(!token || token!==ACCESS_TOKEN) return res.status(401).send("Token inválido.");

  let target="";
  try{ target=fromB64url(req.query.u||""); }catch{}
  if(!target || !/^https?:\/\//i.test(target)) return res.status(400).send("Recurso inválido.");

  const scope=`token:${ACCESS_TOKEN}`;
  if(!verifyTarget(target,scope,req.query.sig)) return res.status(403).send("Assinatura inválida.");

  try{
    return await proxyUpstream(req,res,target,t=>tokenResourceUrl(req,t));
  }catch(e){
    console.error("[resource]",String(e?.message||e));
    if(!res.headersSent) res.status(502).send("Falha no recurso.");
  }
});

// Xtream dos clientes: live via HTTPS gateway.
app.get(["/live/:username/:password/:id","/live/:username/:password/:id.:ext"],async (req,res)=>{
  const {username,password}=credentials(req);

  try{
    const client=await validateClient(username,password);
    if(!client.ok) return res.status(401).send("Conta inválida ou vencida.");

    const s=await getActiveServer();
    const id=String(req.params.id||"").replace(/[^0-9A-Za-z_-]/g,"");
    const ext=String(req.params.ext||"m3u8").replace(/[^0-9A-Za-z]/g,"") || "m3u8";
    const target=fillTemplate(s.live_template,s,{id,ext});
    return await proxyUpstream(req,res,target,t=>clientRelayUrl(req,username,password,t));
  }catch(e){
    console.error("[client-live]",String(e?.message||e));
    if(!res.headersSent) res.status(502).send("Falha no canal.");
  }
});

app.get("/relay/:username/:password",async (req,res)=>{
  const {username,password}=credentials(req);

  try{
    const client=await validateClient(username,password);
    if(!client.ok) return res.status(401).send("Conta inválida ou vencida.");

    const target=fromB64url(req.query.u||"");
    if(!target || !/^https?:\/\//i.test(target)) return res.status(400).send("URL inválida.");

    const scope=`client:${username}:${password}`;
    if(!verifyTarget(target,scope,req.query.sig)) return res.status(403).send("Assinatura inválida.");

    return await proxyUpstream(req,res,target,t=>clientRelayUrl(req,username,password,t));
  }catch(e){
    console.error("[relay]",String(e?.message||e));
    if(!res.headersSent) res.status(502).send("Falha temporária no stream.");
  }
});

async function vodRoute(req,res,kind){
  const {username,password}=credentials(req);

  try{
    const client=await validateClient(username,password);
    if(!client.ok) return res.status(401).send("Conta inválida ou vencida.");

    const s=await getActiveServer();
    const id=String(req.params.id||"").replace(/[^0-9A-Za-z_-]/g,"");
    const ext=String(req.params.ext||"mp4").replace(/[^0-9A-Za-z]/g,"") || "mp4";
    const tpl=kind==="movie"?s.movie_template:s.series_template;
    const target=fillTemplate(tpl,s,{id,ext});

    // VOD é redirecionado para economizar banda do Render.
    return res.redirect(302,target);
  }catch(e){
    return res.status(502).send("Falha temporária.");
  }
}
app.get("/movie/:username/:password/:id.:ext",(req,res)=>vodRoute(req,res,"movie"));
app.get("/series/:username/:password/:id.:ext",(req,res)=>vodRoute(req,res,"series"));

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`[server] P2 Player Universal Gateway V6 ativo na porta ${PORT}`);
});
