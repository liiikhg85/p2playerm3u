const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const PLAYLIST_BASE = String(process.env.PLAYLIST_BASE || "").replace(/\/+$/, "");
const STREAM_BASE_ENV = String(process.env.STREAM_BASE || "").replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "");

const API_TIMEOUT_MS = 180000; // 3 minutos para listagens grandes
const SERIES_TIMEOUT_MS = 90000;
const SERIES_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.SERIES_CONCURRENCY || 6)));
const REFRESH_MS = 6 * 60 * 60 * 1000;

const DIR = "/tmp/p2player-v5";
const BASIC_FILE = path.join(DIR, "basic.m3u");
const FULL_FILE = path.join(DIR, "full.m3u");
const BUILD_FILE = path.join(DIR, "building.m3u");
fs.mkdirSync(DIR, { recursive: true });

let state = {
  phase: "iniciando",
  building: false,
  basicReady: false,
  fullReady: false,
  lastError: null,
  startedAt: null,
  finishedAt: null,
  streamBase: null,
  live: { total: 0, written: 0 },
  movies: { total: 0, written: 0 },
  series: { total: 0, processed: 0, failed: 0, episodesWritten: 0 },
  basicBytes: 0,
  fullBytes: 0
};

function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const token = req.query.token || req.get("x-access-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return token === ACCESS_TOKEN;
}

function apiUrl(action = "", extra = {}) {
  const p = new URLSearchParams({
    username: ORIGIN_USERNAME,
    password: ORIGIN_PASSWORD
  });
  if (action) p.set("action", action);
  for (const [k,v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  return `${PLAYLIST_BASE}/player_api.php?${p.toString()}`;
}

async function fetchJson(action = "", extra = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(apiUrl(action, extra), {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerM3U/5.0)",
        "accept": "application/json,*/*",
        "accept-encoding": "identity"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`${action || "auth"}: HTTP ${r.status}`);
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`${action || "auth"}: JSON inválido (${text.length} bytes)`); }
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`${action || "auth"}: timeout após ${Math.round(timeoutMs/1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function clean(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, "'");
}

function categoryMap(arr) {
  const m = new Map();
  if (Array.isArray(arr)) for (const x of arr)
    m.set(String(x.category_id ?? ""), clean(x.category_name || "Sem categoria"));
  return m;
}

function extinf(name, logo, group, tvgId = "") {
  return `#EXTINF:-1 tvg-id="${clean(tvgId)}" tvg-name="${clean(name)}" tvg-logo="${clean(logo)}" group-title="${clean(group)}",${clean(name)}\n`;
}

function determineStreamBase(authData) {
  if (STREAM_BASE_ENV) return STREAM_BASE_ENV;
  const s = authData?.server_info || {};
  const protocol = String(s.server_protocol || "http").replace(":", "");
  const host = String(s.url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!host) return PLAYLIST_BASE;
  const port = protocol === "https" ? String(s.https_port || s.port || "") : String(s.port || "");
  const defaultPort = (protocol === "http" && port === "80") || (protocol === "https" && port === "443");
  return `${protocol}://${host}${port && !defaultPort ? ":" + port : ""}`;
}

function liveUrl(base, x) {
  return `${base}/live/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${x.stream_id}.${clean(x.container_extension || "m3u8")}`;
}
function movieUrl(base, x) {
  return `${base}/movie/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${x.stream_id}.${clean(x.container_extension || "mp4")}`;
}
function episodeUrl(base, x) {
  return `${base}/series/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${x.id}.${clean(x.container_extension || "mp4")}`;
}

async function write(out, text) {
  if (out.write(text)) return;
  await new Promise((resolve, reject) => {
    out.once("drain", resolve);
    out.once("error", reject);
  });
}
async function finish(out) {
  out.end();
  await new Promise((resolve, reject) => {
    out.once("finish", resolve);
    out.once("error", reject);
  });
}

function flattenEpisodes(info) {
  const out = [];
  if (!info?.episodes || typeof info.episodes !== "object") return out;
  for (const [season, list] of Object.entries(info.episodes)) {
    if (!Array.isArray(list)) continue;
    for (const ep of list) out.push({ ...ep, __season: season });
  }
  return out;
}

async function build() {
  if (state.building) return;
  state = {
    ...state,
    phase: "autenticando",
    building: true,
    basicReady: false,
    fullReady: false,
    lastError: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    live: { total: 0, written: 0 },
    movies: { total: 0, written: 0 },
    series: { total: 0, processed: 0, failed: 0, episodesWritten: 0 },
    basicBytes: 0,
    fullBytes: 0
  };

  try {
    console.log("[V5] 1/6 Autenticando...");
    const authData = await fetchJson("", {}, 60000);
    const base = determineStreamBase(authData);
    state.streamBase = base;

    // CANAIS PRIMEIRO
    state.phase = "baixando_canais";
    console.log("[V5] 2/6 Buscando canais...");
    const liveCatsRaw = await fetchJson("get_live_categories", {}, 60000);
    const liveRaw = await fetchJson("get_live_streams", {}, API_TIMEOUT_MS);
    const liveCats = categoryMap(liveCatsRaw);
    const lives = Array.isArray(liveRaw) ? liveRaw : [];
    state.live.total = lives.length;
    console.log(`[V5] Canais recebidos: ${lives.length}`);

    // FILMES DEPOIS
    state.phase = "baixando_filmes";
    console.log("[V5] 3/6 Buscando filmes...");
    const movieCatsRaw = await fetchJson("get_vod_categories", {}, 60000);
    const movieRaw = await fetchJson("get_vod_streams", {}, API_TIMEOUT_MS);
    const movieCats = categoryMap(movieCatsRaw);
    const movies = Array.isArray(movieRaw) ? movieRaw : [];
    state.movies.total = movies.length;
    console.log(`[V5] Filmes recebidos: ${movies.length}`);

    // LIBERA BASIC ANTES DE TOCAR NAS SÉRIES
    state.phase = "gerando_basica";
    console.log("[V5] 4/6 Gerando BASIC...");
    const basicOut = fs.createWriteStream(BASIC_FILE, { encoding: "utf8" });
    await write(basicOut, "#EXTM3U\n");

    for (const x of lives) {
      const name = x.name || `Canal ${x.stream_id}`;
      const group = liveCats.get(String(x.category_id ?? "")) || "Canais";
      await write(basicOut,
        extinf(name, x.stream_icon || "", group, x.epg_channel_id || "") +
        liveUrl(base, x) + "\n"
      );
      state.live.written++;
    }

    for (const x of movies) {
      const name = x.name || `Filme ${x.stream_id}`;
      const group = movieCats.get(String(x.category_id ?? "")) || "Filmes";
      await write(basicOut,
        extinf(name, x.stream_icon || "", group) +
        movieUrl(base, x) + "\n"
      );
      state.movies.written++;
    }

    await finish(basicOut);
    state.basicBytes = fs.statSync(BASIC_FILE).size;
    state.basicReady = true;
    console.log(`[V5] BASIC PRONTA: ${(state.basicBytes/1048576).toFixed(2)} MB`);

    // SÓ AGORA SÉRIES
    state.phase = "baixando_series";
    console.log("[V5] 5/6 Buscando séries...");
    const seriesCatsRaw = await fetchJson("get_series_categories", {}, 60000);
    const seriesRaw = await fetchJson("get_series", {}, API_TIMEOUT_MS);
    const seriesCats = categoryMap(seriesCatsRaw);
    const series = Array.isArray(seriesRaw) ? seriesRaw : [];
    state.series.total = series.length;
    console.log(`[V5] Séries recebidas: ${series.length}`);

    await fs.promises.copyFile(BASIC_FILE, BUILD_FILE);
    const fullOut = fs.createWriteStream(BUILD_FILE, { flags: "a", encoding: "utf8" });

    state.phase = "processando_episodios";
    console.log(`[V5] 6/6 Episódios; concorrência=${SERIES_CONCURRENCY}`);

    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= series.length) return;
        const s = series[i];

        try {
          const info = await fetchJson("get_series_info", { series_id: s.series_id }, SERIES_TIMEOUT_MS);
          const eps = flattenEpisodes(info);
          const group = seriesCats.get(String(s.category_id ?? "")) || "Séries";
          const logo = s.cover || s.stream_icon || "";

          for (const ep of eps) {
            const season = ep.season ?? ep.__season ?? ep.info?.season ?? "";
            const number = ep.episode_num ?? ep.info?.episode_num ?? "";
            const title = clean(ep.title || ep.info?.title || `Episódio ${number}`);
            const name =
              `${clean(s.name || "Série")}` +
              `${season !== "" ? " S" + String(season).padStart(2,"0") : ""}` +
              `${number !== "" ? "E" + String(number).padStart(2,"0") : ""}` +
              ` - ${title}`;

            await write(fullOut,
              extinf(name, logo, group) + episodeUrl(base, ep) + "\n"
            );
            state.series.episodesWritten++;
          }
        } catch (e) {
          state.series.failed++;
          console.error(`[V5 série ${s.series_id}] ${e.message}`);
        } finally {
          state.series.processed++;
          if (state.series.processed % 25 === 0 || state.series.processed === state.series.total) {
            console.log(`[V5] Séries ${state.series.processed}/${state.series.total} | episódios=${state.series.episodesWritten} | falhas=${state.series.failed}`);
          }
        }
      }
    }

    await Promise.all(Array.from({ length: SERIES_CONCURRENCY }, () => worker()));
    await finish(fullOut);
    await fs.promises.rename(BUILD_FILE, FULL_FILE);

    state.fullBytes = fs.statSync(FULL_FILE).size;
    state.fullReady = true;
    state.phase = "pronto";
    state.finishedAt = new Date().toISOString();
    console.log(`[V5] FULL PRONTA: ${(state.fullBytes/1048576).toFixed(2)} MB`);

  } catch (e) {
    state.lastError = String(e?.message || e);
    state.phase = "erro";
    console.error("[V5 ERRO]", state.lastError);
  } finally {
    state.building = false;
  }
}

function status() {
  return {
    ...state,
    basicMB: Number((state.basicBytes/1048576).toFixed(2)),
    fullMB: Number((state.fullBytes/1048576).toFixed(2)),
    seriesPercent: state.series.total
      ? Number((state.series.processed/state.series.total*100).toFixed(2))
      : 0
  };
}

function serve(res, file) {
  if (!fs.existsSync(file))
    return res.status(503).type("text/plain").send("Playlist ainda nao esta pronta.");
  const st = fs.statSync(file);
  res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="p2player.m3u"');
  res.setHeader("Content-Length", st.size);
  res.setHeader("Cache-Control", "private, no-cache");
  fs.createReadStream(file).pipe(res);
}

app.get("/", (_q,res) => res.json(status()));
app.get("/health", (_q,res) => res.json({ok:true,phase:state.phase,basicReady:state.basicReady,fullReady:state.fullReady}));
app.get("/status", (req,res) => {
  if (!authorized(req)) return res.status(401).json({ok:false,error:"Token inválido"});
  res.setHeader("Cache-Control","no-store");
  res.json(status());
});
app.get("/playlist-basic", (req,res) => {
  if (!authorized(req)) return res.status(401).send("Token inválido");
  serve(res,BASIC_FILE);
});
app.get("/playlist", (req,res) => {
  if (!authorized(req)) return res.status(401).send("Token inválido");
  serve(res,FULL_FILE);
});
app.post("/refresh", express.json(), (req,res) => {
  if (!authorized(req)) return res.status(401).json({ok:false});
  if (!state.building) build();
  res.status(202).json({ok:true});
});

app.get("/monitor", (req,res) => {
  if (!authorized(req)) return res.status(401).send("Token inválido");
  const token = JSON.stringify(String(req.query.token || ""));
  res.setHeader("Cache-Control","no-store");
  res.type("html").send(`<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>P2 M3U V5</title><style>
body{font-family:system-ui;background:#0b0f14;color:#e6edf3;padding:20px;margin:0}
main{max-width:800px;margin:auto}.card{background:#151b23;border:1px solid #30363d;border-radius:18px;padding:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.item{background:#0d1117;padding:13px;border-radius:11px}
small{display:block;color:#8b949e}.ok{color:#3fb950}.wait{color:#d29922}.err{color:#f85149}a{color:#58a6ff}
@media(max-width:600px){.grid{grid-template-columns:1fr}}</style></head><body><main><div class="card">
<h2>P2 Player M3U • V5</h2><h1 id="phase">Carregando...</h1>
<div class="grid"><div class="item"><small>Canais</small><b id="live">-</b></div>
<div class="item"><small>Filmes</small><b id="movies">-</b></div>
<div class="item"><small>Séries</small><b id="series">-</b></div>
<div class="item"><small>Episódios</small><b id="eps">-</b></div>
<div class="item"><small>Playlist básica</small><b id="basic">-</b></div>
<div class="item"><small>Playlist completa</small><b id="full">-</b></div></div>
<p id="links"></p><p id="error" class="err"></p></div></main>
<script>
const token=${token};
async function update(){
 try{
  const d=await (await fetch('/status?token='+encodeURIComponent(token),{cache:'no-store'})).json();
  phase.textContent='Fase: '+d.phase;
  phase.className=d.phase==='pronto'?'ok':(d.phase==='erro'?'err':'wait');
  live.textContent=d.live.written+' / '+d.live.total;
  movies.textContent=d.movies.written+' / '+d.movies.total;
  series.textContent=d.series.processed+' / '+d.series.total+' ('+d.seriesPercent+'%)';
  eps.textContent=d.series.episodesWritten;
  basic.textContent=d.basicReady?d.basicMB+' MB • PRONTA':'aguardando';
  full.textContent=d.fullReady?d.fullMB+' MB • PRONTA':'aguardando';
  let x='';
  if(d.basicReady)x='<a href="/playlist-basic?token='+encodeURIComponent(token)+'">TESTAR BÁSICA</a>';
  if(d.fullReady)x+=(x?' • ':'')+'<a href="/playlist?token='+encodeURIComponent(token)+'">TESTAR COMPLETA</a>';
  links.innerHTML=x; error.textContent=d.lastError||'';
 }catch(e){}
}
update();setInterval(update,1500);
</script></body></html>`);
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`[V5] ativo na porta ${PORT}`);
  build();
  setInterval(build,REFRESH_MS);
});
