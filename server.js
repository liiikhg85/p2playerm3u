const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const PLAYLIST_BASE = String(process.env.PLAYLIST_BASE || "").replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "");

const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 horas
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

let cache = null;
let cacheUpdatedAt = null;
let updating = false;
let lastError = null;
let lastAttemptAt = null;

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

  console.log("[cache] iniciando download da playlist...");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(originUrl(), {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerM3UCache/1.0)",
        "accept": "*/*"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Origem respondeu HTTP ${response.status}`);
    }

    const text = await response.text();

    if (!text || text.length < 10 || !text.includes("#EXTM3U")) {
      throw new Error(`Resposta invalida/incompleta (${text.length} bytes)`);
    }

    // Só troca o cache depois que a nova playlist terminou por completo.
    cache = text;
    cacheUpdatedAt = new Date().toISOString();

    console.log(
      `[cache] playlist pronta: ${Buffer.byteLength(cache, "utf8")} bytes`
    );
  } catch (error) {
    lastError =
      error?.name === "AbortError"
        ? "Timeout ao baixar playlist."
        : String(error?.message || error);

    console.error("[cache]", lastError);
  } finally {
    clearTimeout(timeout);
    updating = false;
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "P2 Player M3U Cache",
    cacheReady: Boolean(cache),
    updating,
    cacheBytes: cache ? Buffer.byteLength(cache, "utf8") : 0,
    cacheUpdatedAt,
    lastAttemptAt,
    lastError
  });
});

app.get("/health", (_req, res) => {
  // Health check sempre rápido para o Render não achar que o serviço caiu.
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

  res.json({
    ok: true,
    cacheReady: Boolean(cache),
    updating,
    cacheBytes: cache ? Buffer.byteLength(cache, "utf8") : 0,
    cacheUpdatedAt,
    lastAttemptAt,
    lastError
  });
});

app.get("/playlist", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }

  if (!cache) {
    // Se ainda não existe cache, dispara/garante atualização e informa que está preparando.
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
  res.setHeader("Content-Length", Buffer.byteLength(cache, "utf8"));
  res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(cache);
});

app.post("/refresh", express.json(), (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "Token invalido." });
  }

  if (!updating) refreshPlaylist();

  res.status(202).json({
    ok: true,
    message: updating ? "Atualizacao em andamento." : "Atualizacao iniciada."
  });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Rota nao encontrada." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] P2 Player M3U Cache ativo na porta ${PORT}`);

  // Começa a preparar a lista assim que o serviço sobe.
  refreshPlaylist();

  // Atualiza a cada 6 horas enquanto a instância estiver ativa.
  setInterval(refreshPlaylist, REFRESH_MS);
});
