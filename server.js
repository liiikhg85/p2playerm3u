const express = require("express");
const ftp = require("basic-ftp");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const ORIGIN_API_BASE = String(process.env.ORIGIN_API_BASE || "http://ativaronline.pro").replace(/\/+$/, "");
const LIVE_STREAM_BASE = String(process.env.LIVE_STREAM_BASE || "http://main.fashion:80").replace(/\/+$/, "");
const VOD_STREAM_BASE = String(process.env.VOD_STREAM_BASE || ORIGIN_API_BASE).replace(/\/+$/, "");

const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");

const FTP_HOST = String(process.env.FTP_HOST || "ftpupload.net");
const FTP_PORT = Number(process.env.FTP_PORT || 21);
const FTP_USER = String(process.env.FTP_USER || "");
const FTP_PASSWORD = String(process.env.FTP_PASSWORD || "");
const FTP_USERS_PATH = String(process.env.FTP_USERS_PATH || "/htdocs/usuarios.json");

const USERS_CACHE_SECONDS = Math.max(5, Math.min(300, Number(process.env.USERS_CACHE_SECONDS || 30)));
const CATALOG_CACHE_SECONDS = Math.max(30, Math.min(1800, Number(process.env.CATALOG_CACHE_SECONDS || 300)));
const CATEGORY_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.CATEGORY_CONCURRENCY || 4)));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 60000));

let usersCache = { expiresAt: 0, usuarios: null, lastError: null, lastPath: null, lastLoadedAt: null };
const catalogCache = new Map();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST");
  res.setHeader("Access-Control-Allow-Headers", "Origin, Accept, Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function candidateFtpPaths() {
  return [...new Set([
    FTP_USERS_PATH,
    "/htdocs/usuarios.json",
    "/p2playerweb.gamer.gd/htdocs/usuarios.json",
    "htdocs/usuarios.json",
    "p2playerweb.gamer.gd/htdocs/usuarios.json",
    "/usuarios.json"
  ].filter(Boolean))];
}

async function downloadUsersFromFtp(force = false) {
  const now = Date.now();
  if (!force && Array.isArray(usersCache.usuarios) && usersCache.expiresAt > now) return usersCache.usuarios;

  const client = new ftp.Client(30000);
  const tempFile = path.join(os.tmpdir(), `p2-users-${process.pid}-${Date.now()}.json`);
  let lastError = null;

  try {
    await client.access({
      host: FTP_HOST, port: FTP_PORT, user: FTP_USER, password: FTP_PASSWORD, secure: false
    });

    for (const remotePath of candidateFtpPaths()) {
      try {
        await client.downloadTo(tempFile, remotePath);
        const raw = await fs.readFile(tempFile, "utf8");
        const json = JSON.parse(raw);
        if (!json || !Array.isArray(json.usuarios)) throw new Error("JSON sem campo usuarios.");

        usersCache = {
          expiresAt: now + USERS_CACHE_SECONDS * 1000,
          usuarios: json.usuarios,
          lastError: null,
          lastPath: remotePath,
          lastLoadedAt: new Date().toISOString()
        };
        console.log(`[FTP] usuarios=${json.usuarios.length} path=${remotePath}`);
        return json.usuarios;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("usuarios.json não encontrado.");
  } catch (e) {
    usersCache.lastError = String(e?.message || e);
    throw e;
  } finally {
    client.close();
    await fs.unlink(tempFile).catch(() => {});
  }
}

function isExpired(validade) {
  const v = String(validade || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
  const end = new Date(`${v}T23:59:59-03:00`);
  return Number.isNaN(end.getTime()) || Date.now() > end.getTime();
}

async function validateClient(username, password) {
  const usuarios = await downloadUsersFromFtp();
  const u = String(username || "").trim().toLowerCase();
  const p = String(password || "");

  const cliente = usuarios.find(x =>
    x && typeof x === "object" &&
    String(x.usuario || "").toLowerCase() === u &&
    String(x.senha || "") === p
  );

  if (!cliente) return { ok:false, status:"Disabled", message:"Usuário ou senha inválidos." };

  const status = String(cliente.status || "ativo").trim().toLowerCase();
  const blocked = cliente.bloqueado === true ||
    ["bloqueado","inativo","suspenso","desativado"].includes(status);

  if (blocked) return { ok:false, status:"Disabled", message:"Conta bloqueada." };
  if (isExpired(cliente.validade)) return {
    ok:false, status:"Expired", message:"Conta vencida.", validade:String(cliente.validade || "")
  };

  return {
    ok:true, status:"Active", nome:String(cliente.nome || ""),
    validade:String(cliente.validade || ""), tipo_conta:String(cliente.tipo_conta || "cliente")
  };
}

async function originJson(action = "", extra = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const params = new URLSearchParams({ username: ORIGIN_USERNAME, password: ORIGIN_PASSWORD });
  if (action) params.set("action", action);
  for (const [k,v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ORIGIN_API_BASE}/player_api.php?${params.toString()}`, {
      headers: {
        accept: "application/json,*/*",
        "accept-encoding": "identity",
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerXtreamFTP/4.0)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Origem HTTP ${response.status}`);

    const text = await response.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`Origem retornou JSON inválido (${text.length} bytes).`); }
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`${action || "login"}: timeout`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let index = 0;

  async function run() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, run));
  return out;
}

async function aggregateByCategory(kind) {
  const config = {
    live:   { cats: "get_live_categories",   items: "get_live_streams" },
    movies: { cats: "get_vod_categories",    items: "get_vod_streams" },
    series: { cats: "get_series_categories", items: "get_series" }
  }[kind];

  const key = `agg:${kind}`;
  const now = Date.now();
  const cached = catalogCache.get(key);

  if (cached && cached.expiresAt > now) return cached.data;

  console.log(`[AGG] iniciando ${kind}`);

  const categories = await originJson(config.cats, {}, 60000);
  const list = Array.isArray(categories) ? categories : [];

  const chunks = await mapLimit(list, CATEGORY_CONCURRENCY, async (cat) => {
    const categoryId = String(cat?.category_id ?? cat?.id ?? "");
    if (!categoryId) return [];

    try {
      const data = await originJson(config.items, { category_id: categoryId }, 60000);
      const arr = Array.isArray(data) ? data : Object.values(data || {});
      console.log(`[AGG] ${kind} categoria=${categoryId} itens=${arr.length}`);
      return arr;
    } catch (e) {
      console.error(`[AGG] ${kind} categoria=${categoryId} ERRO ${e.message}`);
      return [];
    }
  });

  const merged = chunks.flat();

  catalogCache.set(key, {
    data: merged,
    expiresAt: now + CATALOG_CACHE_SECONDS * 1000
  });

  console.log(`[AGG] ${kind} pronto total=${merged.length}`);
  return merged;
}

function credentials(req) {
  return {
    username: String(req.query.username || req.body?.username || req.params.username || "").trim(),
    password: String(req.query.password || req.body?.password || req.params.password || "")
  };
}

function disabledLogin(username, password, req, message = "Conta inválida ou vencida.") {
  const now = Math.floor(Date.now() / 1000);
  return {
    user_info: {
      username, password, message, auth: 0, status: "Disabled", exp_date: "0",
      is_trial: "0", active_cons: "0", created_at: String(now), max_connections: "3",
      allowed_output_formats: ["m3u8","ts","rtmp"]
    },
    server_info: {
      url: req.hostname || "", port: "443", https_port: "443", server_protocol: "https",
      rtmp_port: "0", timezone: "America/Sao_Paulo", timestamp_now: now,
      time_now: new Date().toISOString().replace("T"," ").slice(0,19)
    }
  };
}

function activeLogin(originData, username, password, req, client) {
  const now = Math.floor(Date.now() / 1000);
  const originUser = originData?.user_info || {};
  const originServer = originData?.server_info || {};
  let expiry = 0;

  if (client.validade) {
    const dt = new Date(`${client.validade}T23:59:59-03:00`);
    if (!Number.isNaN(dt.getTime())) expiry = Math.floor(dt.getTime()/1000);
  }

  return {
    ...originData,
    user_info: {
      ...originUser,
      username, password,
      message: client.nome ? `P2 Player • ${client.nome}` : "P2 Player",
      auth: 1,
      status: "Active",
      exp_date: expiry ? String(expiry) : String(originUser.exp_date || "0"),
      active_cons: "0",
      max_connections: "3",
      allowed_output_formats: Array.isArray(originUser.allowed_output_formats)
        ? originUser.allowed_output_formats
        : ["m3u8","ts","rtmp"]
    },
    server_info: {
      ...originServer,
      url: req.hostname || "",
      port: "443",
      https_port: "443",
      server_protocol: "https",
      rtmp_port: "0",
      timezone: originServer.timezone || "America/Sao_Paulo",
      timestamp_now: now,
      time_now: new Date().toISOString().replace("T"," ").slice(0,19)
    }
  };
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req,res) => res.json({
  ok:true,
  service:"P2 Player Xtream FTP V4",
  ftpLoaded:Array.isArray(usersCache.usuarios),
  catalogCaches:[...catalogCache.keys()]
}));

app.get("/health", (_req,res) => res.json({ok:true, uptimeSeconds:Math.floor(process.uptime())}));

app.get("/ftp-debug", async (_req,res) => {
  try {
    const usuarios = await downloadUsersFromFtp(true);
    res.json({ok:true,count:usuarios.length,path:usersCache.lastPath,loadedAt:usersCache.lastLoadedAt});
  } catch(e) {
    res.status(502).json({ok:false,error:usersCache.lastError || e.message});
  }
});

async function handlePlayerApi(req, res) {
  const {username,password} = credentials(req);
  const action = String(req.query.action || req.body?.action || "").trim();

  try {
    const client = await validateClient(username,password);

    if (!client.ok) {
      if (!action) return res.json(disabledLogin(username,password,req,client.message));
      return res.status(401).json([]);
    }

    if (!action) {
      const origin = await originJson("",{},60000);
      return res.json(activeLogin(origin,username,password,req,client));
    }

    const extra = {};
    for (const key of ["category_id","series_id","vod_id","stream_id","limit","start"]) {
      const value = req.query[key] ?? req.body?.[key];
      if (value !== undefined && value !== "") extra[key] = value;
    }

    // Os endpoints gigantes da origem travam sem category_id.
    // O gateway agrega por categoria e guarda cache.
    if (action === "get_live_streams" && !extra.category_id) {
      return res.json(await aggregateByCategory("live"));
    }
    if (action === "get_vod_streams" && !extra.category_id) {
      return res.json(await aggregateByCategory("movies"));
    }
    if (action === "get_series" && !extra.category_id) {
      return res.json(await aggregateByCategory("series"));
    }

    const allowed = new Set([
      "get_live_categories","get_live_streams","get_vod_categories","get_vod_streams",
      "get_vod_info","get_series_categories","get_series","get_series_info",
      "get_short_epg","get_simple_data_table"
    ]);

    if (!allowed.has(action)) return res.status(400).json({error:"Ação não suportada."});

    return res.json(await originJson(action,extra,60000));

  } catch(e) {
    console.error("[player_api]",action || "login",e.message);
    if (!action) return res.json(disabledLogin(username,password,req,"Servidor temporariamente indisponível."));
    return res.status(502).json({error:"Falha temporária ao consultar catálogo."});
  }
}

app.get("/player_api.php", handlePlayerApi);
app.post("/player_api.php", handlePlayerApi);

async function streamRedirect(req,res,kind) {
  const {username,password} = credentials(req);
  try {
    const client = await validateClient(username,password);
    if (!client.ok) return res.status(401).send("Conta inválida ou vencida.");

    const id = String(req.params.id || "").replace(/[^0-9A-Za-z_-]/g,"");
    if (!id) return res.status(400).send("Stream inválido.");

    let target;
    if (kind === "live") {
      // A origem ao vivo confirmada funciona como /usuario/senha/id.m3u8
      target = `${LIVE_STREAM_BASE}/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${encodeURIComponent(id)}.m3u8`;
    } else {
      const ext = String(req.params.ext || "mp4").replace(/[^0-9A-Za-z]/g,"");
      target = `${VOD_STREAM_BASE}/${kind}/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${encodeURIComponent(id)}.${ext}`;
    }

    return res.redirect(302,target);
  } catch(e) {
    return res.status(502).send("Falha temporária.");
  }
}

app.get("/live/:username/:password/:id.:ext", (req,res)=>streamRedirect(req,res,"live"));
app.get("/live/:username/:password/:id", (req,res)=>streamRedirect(req,res,"live"));
app.get("/movie/:username/:password/:id.:ext", (req,res)=>streamRedirect(req,res,"movie"));
app.get("/series/:username/:password/:id.:ext", (req,res)=>streamRedirect(req,res,"series"));

app.listen(PORT,"0.0.0.0",()=>console.log(`[server] P2 Player Xtream FTP V4 ativo porta ${PORT}`));
