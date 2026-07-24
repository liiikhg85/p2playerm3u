const express = require("express");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const PLAYLIST_BASE = String(process.env.PLAYLIST_BASE || "").replace(/\/+$/, "");
const STREAM_BASE_ENV = String(process.env.STREAM_BASE || "").replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "");

const REFRESH_MS = 6 * 60 * 60 * 1000;
const API_TIMEOUT_MS = 60 * 1000;
const SERIES_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.SERIES_CONCURRENCY || 8)));

const DATA_DIR = "/tmp/p2player-m3u";
const BASIC_FILE = path.join(DATA_DIR, "playlist-basic.m3u");
const FULL_FILE = path.join(DATA_DIR, "playlist-full.m3u");
const BUILD_FILE = path.join(DATA_DIR, "playlist-building.m3u");

fs.mkdirSync(DATA_DIR, { recursive: true });

let state = {
  building: false,
  basicReady: false,
  fullReady: false,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  streamBase: null,

  live: { total: 0, written: 0 },
  movies: { total: 0, written: 0 },
  series: {
    total: 0,
    processed: 0,
    failed: 0,
    episodesWritten: 0
  },

  basicBytes: 0,
  fullBytes: 0
};

app.disable("x-powered-by");
app.set("trust proxy", true);

function authorized(req) {
  if (!ACCESS_TOKEN) return true;

  const token =
    req.query.token ||
    req.get("x-access-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");

  return token === ACCESS_TOKEN;
}

function apiUrl(action = "", extra = {}) {
  const params = new URLSearchParams({
    username: ORIGIN_USERNAME,
    password: ORIGIN_PASSWORD
  });

  if (action) params.set("action", action);

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  return `${PLAYLIST_BASE}/player_api.php?${params.toString()}`;
}

async function fetchJson(action = "", extra = {}, tries = 2) {
  let lastError;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(apiUrl(action, extra), {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; P2PlayerM3U/4.0)",
          "accept": "application/json,*/*",
          "accept-encoding": "identity"
        },
        redirect: "follow",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);
      clearTimeout(timeout);
      return data;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < tries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw lastError || new Error("Falha na API Xtream.");
}

function safe(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'");
}

function categoriesMap(items) {
  const map = new Map();

  if (Array.isArray(items)) {
    for (const item of items) {
      map.set(String(item.category_id ?? ""), safe(item.category_name || "Sem categoria"));
    }
  }

  return map;
}

function extinf({ name, logo = "", group = "", tvgId = "" }) {
  return `#EXTINF:-1 tvg-id="${safe(tvgId)}" tvg-name="${safe(name)}" tvg-logo="${safe(logo)}" group-title="${safe(group)}",${safe(name)}\n`;
}

function getStreamBase(authData) {
  if (STREAM_BASE_ENV) return STREAM_BASE_ENV;

  const info = authData?.server_info || {};
  const protocol = String(info.server_protocol || "http").replace(":", "");
  const host = String(info.url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");

  if (!host) return PLAYLIST_BASE;

  const port =
    protocol === "https"
      ? String(info.https_port || info.port || "")
      : String(info.port || "");

  const defaultPort =
    (protocol === "http" && port === "80") ||
    (protocol === "https" && port === "443");

  return `${protocol}://${host}${port && !defaultPort ? `:${port}` : ""}`;
}

function liveUrl(base, stream) {
  const id = stream.stream_id;
  const ext = safe(stream.container_extension || "m3u8");
  return `${base}/live/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${id}.${ext}`;
}

function movieUrl(base, stream) {
  const id = stream.stream_id;
  const ext = safe(stream.container_extension || "mp4");
  return `${base}/movie/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${id}.${ext}`;
}

function episodeUrl(base, episode) {
  const id = episode.id;
  const ext = safe(episode.container_extension || "mp4");
  return `${base}/series/${encodeURIComponent(ORIGIN_USERNAME)}/${encodeURIComponent(ORIGIN_PASSWORD)}/${id}.${ext}`;
}

function writeLine(stream, text) {
  return new Promise((resolve, reject) => {
    if (stream.write(text)) {
      resolve();
    } else {
      stream.once("drain", resolve);
      stream.once("error", reject);
    }
  });
}

function flattenEpisodes(info) {
  const result = [];
  const episodes = info?.episodes;

  if (!episodes || typeof episodes !== "object") return result;

  for (const [seasonKey, seasonEpisodes] of Object.entries(episodes)) {
    if (!Array.isArray(seasonEpisodes)) continue;

    for (const episode of seasonEpisodes) {
      result.push({
        ...episode,
        __season: seasonKey
      });
    }
  }

  return result;
}

async function processSeriesQueue(seriesList, seriesCategories, streamBase, out) {
  let cursor = 0;

  async function worker(workerId) {
    while (true) {
      const index = cursor++;
      if (index >= seriesList.length) return;

      const series = seriesList[index];

      try {
        const info = await fetchJson("get_series_info", {
          series_id: series.series_id
        });

        const episodes = flattenEpisodes(info);
        const category = seriesCategories.get(String(series.category_id ?? "")) || "Séries";
        const seriesName = safe(series.name || `Série ${series.series_id}`);
        const logo = safe(series.cover || series.stream_icon || "");

        for (const ep of episodes) {
          const season =
            ep.season ??
            ep.__season ??
            ep.info?.season ??
            "";

          const episodeNum =
            ep.episode_num ??
            ep.info?.episode_num ??
            "";

          const title =
            safe(ep.title || ep.info?.title || `Episódio ${episodeNum}`);

          const fullName =
            `${seriesName}` +
            `${season !== "" ? ` S${String(season).padStart(2, "0")}` : ""}` +
            `${episodeNum !== "" ? `E${String(episodeNum).padStart(2, "0")}` : ""}` +
            ` - ${title}`;

          await writeLine(
            out,
            extinf({
              name: fullName,
              logo,
              group: category
            }) + episodeUrl(streamBase, ep) + "\n"
          );

          state.series.episodesWritten++;
        }
      } catch (error) {
        state.series.failed++;
        console.error(
          `[series] falha series_id=${series.series_id}: ${error?.message || error}`
        );
      } finally {
        state.series.processed++;

        if (
          state.series.processed % 25 === 0 ||
          state.series.processed === state.series.total
        ) {
          console.log(
            `[series] ${state.series.processed}/${state.series.total} processadas | ` +
            `${state.series.episodesWritten} episodios | ${state.series.failed} falhas`
          );
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < SERIES_CONCURRENCY; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);
}

async function buildPlaylist() {
  if (state.building) return;

  if (!PLAYLIST_BASE || !ORIGIN_USERNAME || !ORIGIN_PASSWORD) {
    state.lastError = "Variaveis obrigatorias nao configuradas.";
    console.error("[build]", state.lastError);
    return;
  }

  state = {
    ...state,
    building: true,
    basicReady: false,
    fullReady: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    live: { total: 0, written: 0 },
    movies: { total: 0, written: 0 },
    series: { total: 0, processed: 0, failed: 0, episodesWritten: 0 },
    basicBytes: 0,
    fullBytes: 0
  };

  try {
    console.log("[build] consultando Xtream API...");

    const [
      auth,
      liveCategoriesRaw,
      movieCategoriesRaw,
      seriesCategoriesRaw,
      liveStreams,
      movieStreams,
      seriesList
    ] = await Promise.all([
      fetchJson(""),
      fetchJson("get_live_categories"),
      fetchJson("get_vod_categories"),
      fetchJson("get_series_categories"),
      fetchJson("get_live_streams"),
      fetchJson("get_vod_streams"),
      fetchJson("get_series")
    ]);

    if (auth?.user_info?.auth !== 1 && String(auth?.user_info?.status || "").toLowerCase() !== "active") {
      throw new Error("Conta Xtream nao esta ativa/autorizada.");
    }

    const streamBase = getStreamBase(auth);
    state.streamBase = streamBase;

    const liveCategories = categoriesMap(liveCategoriesRaw);
    const movieCategories = categoriesMap(movieCategoriesRaw);
    const seriesCategories = categoriesMap(seriesCategoriesRaw);

    const lives = Array.isArray(liveStreams) ? liveStreams : [];
    const movies = Array.isArray(movieStreams) ? movieStreams : [];
    const series = Array.isArray(seriesList) ? seriesList : [];

    state.live.total = lives.length;
    state.movies.total = movies.length;
    state.series.total = series.length;

    console.log(
      `[build] live=${lives.length} filmes=${movies.length} series=${series.length}`
    );
    console.log(`[build] stream base: ${streamBase}`);

    // ---------- BASIC: canais + filmes ----------
    const basicOut = fs.createWriteStream(BASIC_FILE, { encoding: "utf8" });
    await writeLine(basicOut, "#EXTM3U\n");

    for (const item of lives) {
      const name = item.name || `Canal ${item.stream_id}`;
      const group =
        liveCategories.get(String(item.category_id ?? "")) || "Canais";

      await writeLine(
        basicOut,
        extinf({
          name,
          logo: item.stream_icon || "",
          group,
          tvgId: item.epg_channel_id || ""
        }) + liveUrl(streamBase, item) + "\n"
      );

      state.live.written++;
    }

    for (const item of movies) {
      const name = item.name || `Filme ${item.stream_id}`;
      const group =
        movieCategories.get(String(item.category_id ?? "")) || "Filmes";

      await writeLine(
        basicOut,
        extinf({
          name,
          logo: item.stream_icon || "",
          group
        }) + movieUrl(streamBase, item) + "\n"
      );

      state.movies.written++;
    }

    basicOut.end();
    await new Promise((resolve, reject) => {
      basicOut.on("finish", resolve);
      basicOut.on("error", reject);
    });

    state.basicBytes = fs.statSync(BASIC_FILE).size;
    state.basicReady = true;

    console.log(
      `[build] playlist basica pronta: ${(state.basicBytes / 1024 / 1024).toFixed(2)} MB`
    );

    // ---------- FULL: copia basic e acrescenta episódios ----------
    await fs.promises.copyFile(BASIC_FILE, BUILD_FILE);
    const fullOut = fs.createWriteStream(BUILD_FILE, {
      flags: "a",
      encoding: "utf8"
    });

    console.log(
      `[build] iniciando episodios com concorrencia=${SERIES_CONCURRENCY}`
    );

    await processSeriesQueue(series, seriesCategories, streamBase, fullOut);

    fullOut.end();
    await new Promise((resolve, reject) => {
      fullOut.on("finish", resolve);
      fullOut.on("error", reject);
    });

    await fs.promises.rename(BUILD_FILE, FULL_FILE);

    state.fullBytes = fs.statSync(FULL_FILE).size;
    state.fullReady = true;
    state.finishedAt = new Date().toISOString();

    console.log(
      `[build] playlist completa pronta: ${(state.fullBytes / 1024 / 1024).toFixed(2)} MB | ` +
      `${state.series.episodesWritten} episodios`
    );
  } catch (error) {
    state.lastError = String(error?.message || error);
    console.error("[build]", state.lastError);
  } finally {
    state.building = false;
  }
}

function serveFile(res, file, stage) {
  if (!fs.existsSync(file)) {
    return res.status(503).type("text/plain").send("Playlist ainda nao esta pronta.");
  }

  const stat = fs.statSync(file);

  res.status(200);
  res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="p2player.m3u"');
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
  res.setHeader("X-P2-Playlist-Stage", stage);
  res.setHeader("X-Content-Type-Options", "nosniff");

  fs.createReadStream(file).pipe(res);
}

function statusJson() {
  const seriesPercent =
    state.series.total > 0
      ? Number(((state.series.processed / state.series.total) * 100).toFixed(2))
      : 0;

  return {
    ok: true,
    ...state,
    basicMB: Number((state.basicBytes / 1024 / 1024).toFixed(2)),
    fullMB: Number((state.fullBytes / 1024 / 1024).toFixed(2)),
    seriesPercent,
    concurrency: SERIES_CONCURRENCY
  };
}

app.get("/", (_req, res) => {
  res.json(statusJson());
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    building: state.building,
    basicReady: state.basicReady,
    fullReady: state.fullReady
  });
});

app.get("/status", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Token invalido." });
  }

  res.setHeader("Cache-Control", "no-store");
  res.json(statusJson());
});

app.get("/monitor", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }

  const token = JSON.stringify(String(req.query.token || ""));

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>P2 Player M3U V4</title>
<style>
body{margin:0;background:#0b0f14;color:#e6edf3;font-family:system-ui;padding:22px}
main{max-width:850px;margin:auto}.card{background:#151b23;border:1px solid #30363d;border-radius:18px;padding:20px}
h1{margin-top:0}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.item{background:#0d1117;border-radius:11px;padding:13px}
small{display:block;color:#8b949e;margin-bottom:4px}.big{font-size:28px;font-weight:800}.ok{color:#3fb950}.wait{color:#d29922}.err{color:#f85149}
progress{width:100%;height:22px;margin:12px 0}
a{color:#58a6ff}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
</style></head>
<body><main><div class="card">
<h1>P2 Player M3U • Xtream V4</h1>
<div id="state" class="big">Carregando...</div>
<progress id="bar" max="100" value="0"></progress>
<div class="grid">
<div class="item"><small>Canais</small><b id="live">-</b></div>
<div class="item"><small>Filmes</small><b id="movies">-</b></div>
<div class="item"><small>Séries processadas</small><b id="series">-</b></div>
<div class="item"><small>Episódios adicionados</small><b id="episodes">-</b></div>
<div class="item"><small>Falhas em séries</small><b id="failed">-</b></div>
<div class="item"><small>Playlist básica</small><b id="basic">-</b></div>
<div class="item"><small>Playlist completa</small><b id="full">-</b></div>
<div class="item"><small>Stream base</small><b id="base">-</b></div>
</div>
<p id="links"></p><div id="error" class="err"></div>
</div></main>
<script>
const token=${token};
async function update(){
 try{
  const r=await fetch('/status?token='+encodeURIComponent(token),{cache:'no-store'});
  const d=await r.json();
  const st=document.getElementById('state');
  st.textContent=d.fullReady?'COMPLETA PRONTA':(d.basicReady?'BÁSICA PRONTA • PROCESSANDO SÉRIES':(d.building?'CARREGANDO API...':'PARADO'));
  st.className='big '+(d.fullReady?'ok':(d.building?'wait':'err'));
  document.getElementById('live').textContent=d.live.written+' / '+d.live.total;
  document.getElementById('movies').textContent=d.movies.written+' / '+d.movies.total;
  document.getElementById('series').textContent=d.series.processed+' / '+d.series.total+' ('+d.seriesPercent+'%)';
  document.getElementById('episodes').textContent=d.series.episodesWritten;
  document.getElementById('failed').textContent=d.series.failed;
  document.getElementById('basic').textContent=d.basicReady?d.basicMB+' MB pronta':'não pronta';
  document.getElementById('full').textContent=d.fullReady?d.fullMB+' MB pronta':'processando';
  document.getElementById('base').textContent=d.streamBase||'-';
  document.getElementById('bar').value=d.seriesPercent||0;
  document.getElementById('error').textContent=d.lastError?('Erro: '+d.lastError):'';
  let html='';
  if(d.basicReady)html+='<a href="/playlist-basic?token='+encodeURIComponent(token)+'">Testar canais + filmes</a>';
  if(d.fullReady)html+=(html?' • ':'')+'<a href="/playlist?token='+encodeURIComponent(token)+'">Testar playlist completa</a>';
  document.getElementById('links').innerHTML=html;
 }catch(e){}
}
update();setInterval(update,1500);
</script></body></html>`);
});

app.get("/playlist-basic", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }
  serveFile(res, BASIC_FILE, "basic");
});

app.get("/playlist", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }
  serveFile(res, FULL_FILE, "full");
});

app.post("/refresh", express.json(), (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Token invalido." });
  }

  if (!state.building) buildPlaylist();

  res.status(202).json({
    ok: true,
    message: state.building ? "Build em andamento." : "Build iniciado."
  });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Rota nao encontrada." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] P2 Player M3U Xtream V4 ativo na porta ${PORT}`);
  buildPlaylist();
  setInterval(buildPlaylist, REFRESH_MS);
});
