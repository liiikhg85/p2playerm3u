const express = require("express");
const { Readable } = require("stream");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const PLAYLIST_BASE = String(process.env.PLAYLIST_BASE || "").replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "");

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

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "P2 Player M3U",
    configured: Boolean(
      PLAYLIST_BASE &&
      ORIGIN_USERNAME &&
      ORIGIN_PASSWORD &&
      ACCESS_TOKEN
    )
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/playlist", async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).type("text/plain").send("Token invalido.");
  }

  if (!PLAYLIST_BASE || !ORIGIN_USERNAME || !ORIGIN_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("Servidor M3U ainda nao configurado.");
  }

  const playlistUrl =
    `${PLAYLIST_BASE}/get.php` +
    `?username=${encodeURIComponent(ORIGIN_USERNAME)}` +
    `&password=${encodeURIComponent(ORIGIN_PASSWORD)}` +
    `&type=m3u_plus` +
    `&output=m3u8`;

  console.log(
    `[playlist] requisicao iniciada para ${PLAYLIST_BASE}/get.php`
  );

  const controller = new AbortController();

  // O timeout é longo porque algumas playlists grandes demoram para terminar.
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  try {
    const upstream = await fetch(playlistUrl, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerM3U/1.0)",
        "accept": "*/*"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!upstream.ok) {
      const preview = await upstream.text().catch(() => "");
      console.error(
        `[playlist] origem HTTP ${upstream.status}: ${preview.slice(0, 160)}`
      );

      return res
        .status(502)
        .type("text/plain")
        .send(`Falha na origem (${upstream.status}).`);
    }

    res.status(200);
    res.setHeader(
      "Content-Type",
      "application/x-mpegURL; charset=utf-8"
    );
    res.setHeader(
      "Content-Disposition",
      'inline; filename="p2player.m3u"'
    );
    res.setHeader(
      "Cache-Control",
      "private, no-store, no-cache, must-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (!upstream.body) {
      return res.end();
    }

    /*
     * Streaming:
     * não espera a M3U inteira terminar de baixar.
     * Os bytes são enviados ao aplicativo conforme chegam da origem.
     */
    const stream = Readable.fromWeb(upstream.body);

    stream.on("error", (error) => {
      console.error("[playlist stream]", error.message);
      if (!res.destroyed) res.destroy(error);
    });

    stream.pipe(res);

  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Tempo limite ao carregar a playlist."
        : "Erro ao acessar a origem.";

    console.error("[playlist]", message, error?.message || error);

    if (!res.headersSent) {
      res.status(502).type("text/plain").send(message);
    } else if (!res.destroyed) {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Rota nao encontrada."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] P2 Player M3U ativo na porta ${PORT}`);
});
