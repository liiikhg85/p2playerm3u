const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const PLAYLIST_BASE = String(process.env.PLAYLIST_BASE || "").replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "");

const REFRESH_MS = 6 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const LOG_EVERY_BYTES = 5 * 1024 * 1024; // log a cada 5 MB

let cache = null;
let cacheUpdatedAt = null;
let updating = false;
let lastError = null;
let lastAttemptAt = null;

let progress = {
  downloadedBytes: 0,
  totalBytes: null,
  percent: null,
  startedAt: null,
  elapsedSeconds: 0,
  averageBytesPerSecond: 0,
  currentBytesPerSecond: 0,
  lastChunkAt: null
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

function originUrl() {
  return (
    `${PLAYLIST_BASE}/get.php` +
    `?username=${encodeURIComponent(ORIGIN_USERNAME)}` +
    `&password=${encodeURIComponent(ORIGIN_PASSWORD)}` +
    `&type=m3u_plus&output=m3u8`
  );
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function publicStatus() {
  return {
    ok: true,
    cacheReady: Boolean(cache),
    updating,
    cacheBytes: cache ? Buffer.byteLength(cache) : 0,
    cacheMB: cache ? Number(mb(Buffer.byteLength(cache))) : 0,
    cacheUpdatedAt,
    lastAttemptAt,
    lastError,
    progress: {
      downloadedBytes: progress.downloadedBytes,
      downloadedMB: Number(mb(progress.downloadedBytes)),
      totalBytes: progress.totalBytes,
      totalMB: progress.totalBytes ? Number(mb(progress.totalBytes)) : null,
      percent: progress.percent,
      startedAt: progress.startedAt,
      elapsedSeconds: progress.elapsedSeconds,
      averageKBps: Number((progress.averageBytesPerSecond / 1024).toFixed(2)),
      currentKBps: Number((progress.currentBytesPerSecond / 1024).toFixed(2)),
      lastChunkAt: progress.lastChunkAt
    }
  };
}

async function refreshPlaylist() {
  if (updating) return;

  if (!PLAYLIST_BASE || !ORIGIN_USERNAME || !ORIGIN_PASSWORD) {
    lastError = "Variaveis da origem nao configuradas.";
    console.error("[cache]", lastError);
    return;
  }

  updating = true;
  lastError = null;
  lastAttemptAt = new Date().toISOString();

  const startedMs = Date.now();
  let lastSpeedAt = startedMs;
  let lastSpeedBytes = 0;
  let nextLogAt = LOG_EVERY_BYTES;

  progress = {
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    startedAt: new Date(startedMs).toISOString(),
    elapsedSeconds: 0,
    averageBytesPerSecond: 0,
    currentBytesPerSecond: 0,
    lastChunkAt: null
  };

  console.log("[cache] iniciando download da playlist...");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(originUrl(), {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerM3UCache/3.0)",
        "accept": "*/*",
        "accept-encoding": "identity"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Origem respondeu HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    progress.totalBytes = contentLength > 0 ? contentLength : null;

    console.log(
      `[cache] origem HTTP ${response.status}; tamanho informado: ` +
      `${progress.totalBytes ? mb(progress.totalBytes) + " MB" : "desconhecido"}`
    );

    if (!response.body) {
      throw new Error("Origem respondeu sem corpo.");
    }

    const reader = response.body.getReader();
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;

      // Guardamos os chunks, mas só substituímos o cache quando terminar 100%.
      chunks.push(Buffer.from(value));
      progress.downloadedBytes += value.byteLength;
      progress.lastChunkAt = new Date().toISOString();

      const now = Date.now();
      const elapsedMs = Math.max(1, now - startedMs);
      progress.elapsedSeconds = Number((elapsedMs / 1000).toFixed(1));
      progress.averageBytesPerSecond =
        progress.downloadedBytes / (elapsedMs / 1000);

      const speedWindowMs = now - lastSpeedAt;
      if (speedWindowMs >= 1000) {
        progress.currentBytesPerSecond =
          (progress.downloadedBytes - lastSpeedBytes) / (speedWindowMs / 1000);
        lastSpeedAt = now;
        lastSpeedBytes = progress.downloadedBytes;
      }

      if (progress.totalBytes) {
        progress.percent = Number(
          Math.min(
            100,
            (progress.downloadedBytes / progress.totalBytes) * 100
          ).toFixed(2)
        );
      }

      if (progress.downloadedBytes >= nextLogAt) {
        console.log(
          `[cache] ${mb(progress.downloadedBytes)} MB recebidos | ` +
          `media ${(progress.averageBytesPerSecond / 1024).toFixed(1)} KB/s | ` +
          `atual ${(progress.currentBytesPerSecond / 1024).toFixed(1)} KB/s` +
          `${progress.percent !== null ? ` | ${progress.percent}%` : ""}`
        );
        while (nextLogAt <= progress.downloadedBytes) {
          nextLogAt += LOG_EVERY_BYTES;
        }
      }
    }

    const newCache = Buffer.concat(chunks);

    if (newCache.length < 10) {
      throw new Error(`Resposta vazia/incompleta (${newCache.length} bytes).`);
    }

    const preview = newCache.subarray(0, Math.min(4096, newCache.length)).toString("utf8");
    if (!preview.includes("#EXTM3U")) {
      throw new Error("Resposta nao parece ser uma playlist M3U.");
    }

    cache = newCache;
    cacheUpdatedAt = new Date().toISOString();

    progress.elapsedSeconds = Number(((Date.now() - startedMs) / 1000).toFixed(1));
    progress.averageBytesPerSecond =
      progress.downloadedBytes / Math.max(0.001, progress.elapsedSeconds);
    progress.currentBytesPerSecond = 0;
    if (progress.totalBytes) progress.percent = 100;

    console.log(
      `[cache] playlist pronta: ${mb(cache.length)} MB em ` +
      `${progress.elapsedSeconds}s | media ` +
      `${(progress.averageBytesPerSecond / 1024).toFixed(1)} KB/s`
    );
  } catch (error) {
    lastError =
      error?.name === "AbortError"
        ? "Timeout ao baixar playlist."
        : String(error?.message || error);

    console.error(
      `[cache] ERRO apos ${mb(progress.downloadedBytes)} MB: ${lastError}`
    );
  } finally {
    clearTimeout(timeout);
    updating = false;
  }
}

app.get("/", (_req, res) => res.json(publicStatus()));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    cacheReady: Boolean(cache),
    updating
  });
});

app.get("/status", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Token invalido." });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(publicStatus());
});

app.get("/monitor", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const safeToken = JSON.stringify(String(req.query.token || ""));

  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>P2 Player M3U Monitor</title>
<style>
body{font-family:system-ui;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
main{max-width:720px;margin:auto}
.card{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:20px}
h1{font-size:22px;margin-top:0}
.big{font-size:36px;font-weight:800;margin:12px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.item{background:#0d1117;border-radius:10px;padding:12px}
small{display:block;color:#8b949e;margin-bottom:4px}
progress{width:100%;height:22px}
.ok{color:#3fb950}.wait{color:#d29922}.err{color:#f85149}
@media(max-width:560px){.grid{grid-template-columns:1fr}.big{font-size:28px}}
</style>
</head>
<body><main>
<div class="card">
<h1>P2 Player M3U — Monitor</h1>
<div id="state" class="big">Carregando...</div>
<progress id="bar" max="100" value="0"></progress>
<div class="grid" style="margin-top:16px">
<div class="item"><small>Recebido</small><b id="received">-</b></div>
<div class="item"><small>Total informado</small><b id="total">-</b></div>
<div class="item"><small>Progresso</small><b id="percent">-</b></div>
<div class="item"><small>Velocidade atual</small><b id="current">-</b></div>
<div class="item"><small>Velocidade média</small><b id="avg">-</b></div>
<div class="item"><small>Tempo</small><b id="elapsed">-</b></div>
<div class="item"><small>Cache</small><b id="cache">-</b></div>
<div class="item"><small>Último pacote</small><b id="last">-</b></div>
</div>
<div id="error" class="err" style="margin-top:16px"></div>
</div>
<script>
const token=${safeToken};
const fmtTime=s=>{
  s=Math.floor(Number(s)||0);
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;
  return (h?String(h).padStart(2,'0')+':':'')+
    String(m).padStart(2,'0')+':'+String(x).padStart(2,'0');
};
async function update(){
  try{
    const r=await fetch('/status?token='+encodeURIComponent(token),{cache:'no-store'});
    const d=await r.json(),p=d.progress||{};
    const state=document.getElementById('state');
    state.textContent=d.cacheReady?'PRONTO':(d.updating?'BAIXANDO...':'PARADO');
    state.className='big '+(d.cacheReady?'ok':(d.updating?'wait':'err'));
    document.getElementById('received').textContent=(p.downloadedMB??0)+' MB';
    document.getElementById('total').textContent=p.totalMB!=null?p.totalMB+' MB':'não informado';
    document.getElementById('percent').textContent=p.percent!=null?p.percent+'%':'calculando...';
    document.getElementById('current').textContent=(p.currentKBps??0)+' KB/s';
    document.getElementById('avg').textContent=(p.averageKBps??0)+' KB/s';
    document.getElementById('elapsed').textContent=fmtTime(p.elapsedSeconds);
    document.getElementById('cache').textContent=d.cacheReady?(d.cacheMB+' MB pronto'):'ainda não pronto';
    document.getElementById('last').textContent=p.lastChunkAt?new Date(p.lastChunkAt).toLocaleTimeString():'-';
    document.getElementById('bar').value=p.percent??0;
    document.getElementById('error').textContent=d.lastError?('Erro: '+d.lastError):'';
  }catch(e){}
}
update();setInterval(update,1000);
</script>
</main></body></html>`);
});

app.get("/playlist", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }

  if (!cache) {
    refreshPlaylist();
    res.setHeader("Retry-After", "60");
    return res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send("Playlist ainda esta sendo preparada. Tente novamente em alguns minutos.");
  }

  res.status(200);
  res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="p2player.m3u"');
  res.setHeader("Content-Length", cache.length);
  res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(cache);
});

app.post("/refresh", express.json(), (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Token invalido." });
  }
  if (!updating) refreshPlaylist();
  res.status(202).json({ ok: true, updating: true });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Rota nao encontrada." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] P2 Player M3U Cache V3 ativo na porta ${PORT}`);
  refreshPlaylist();
  setInterval(refreshPlaylist, REFRESH_MS);
});
