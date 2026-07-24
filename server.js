const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const ORIGIN_BASE = String(process.env.ORIGIN_BASE || "http://ativaronline.pro").replace(/\/+$/, "");
const ORIGIN_STREAM_BASE = String(process.env.ORIGIN_STREAM_BASE || ORIGIN_BASE).replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");
const AUTH_URL = String(process.env.AUTH_URL || "").trim();
const AUTH_SECRET = String(process.env.AUTH_SECRET || "").trim();

const AUTH_CACHE_SECONDS = Math.max(5, Math.min(300, Number(process.env.AUTH_CACHE_SECONDS || 30)));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 60000));

const authCache = new Map();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, Accept, Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function publicBase(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function cacheKey(username, password) {
  return `${username}\n${password}`;
}

async function validateClient(username, password) {
  username = String(username || "").trim();
  password = String(password || "");

  if (!username || !password) {
    return { ok: false, status: "Disabled", message: "Credenciais ausentes." };
  }

  const key = cacheKey(username, password);
  const now = Date.now();
  const cached = authCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (!AUTH_URL || !AUTH_SECRET) {
    throw new Error("AUTH_URL/AUTH_SECRET não configurados.");
  }

  const url = new URL(AUTH_URL);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "x-p2-auth-secret": AUTH_SECRET,
        "user-agent": "P2Player-Xtream-Gateway/1.0"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const text = await response.text();
    let data = {};
    try {
  data = JSON.parse(text);
} catch {
  console.error(
    "[AUTH RESPONSE]",
    "HTTP:", response.status,
    "Content-Type:", response.headers.get("content-type"),
    "Body:", text.slice(0, 500)
  );

  throw new Error(
    `Auth retornou resposta inválida (${response.status}).`
  );
}

    const value = {
      ok: response.ok && data.ok === true,
      status: String(data.status || (data.ok ? "Active" : "Disabled")),
      message: String(data.message || ""),
      validade: String(data.validade || ""),
      nome: String(data.nome || "")
    };

    authCache.set(key, {
      value,
      expiresAt: now + AUTH_CACHE_SECONDS * 1000
    });

    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function originJson(action = "", extra = {}) {
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${ORIGIN_BASE}/player_api.php?${params.toString()}`, {
      headers: {
        "accept": "application/json,*/*",
        "accept-encoding": "identity",
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerXtream/1.0)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Origem HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Origem retornou JSON inválido (${text.length} bytes).`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function disabledLogin(username, password, req, message = "Conta inválida ou vencida.") {
  const now = Math.floor(Date.now() / 1000);
  return {
    user_info: {
      username: String(username || ""),
      password: String(password || ""),
      message,
      auth: 0,
      status: "Disabled",
      exp_date: "0",
      is_trial: "0",
      active_cons: "0",
      created_at: String(now),
      max_connections: "3",
      allowed_output_formats: ["m3u8", "ts", "rtmp"]
    },
    server_info: {
      url: req.hostname || "",
      port: "443",
      https_port: "443",
      server_protocol: "https",
      rtmp_port: "0",
      timezone: "America/Sao_Paulo",
      timestamp_now: now,
      time_now: new Date().toISOString().replace("T", " ").slice(0, 19)
    }
  };
}

function rewriteLoginResponse(originData, username, password, req, authResult) {
  const now = Math.floor(Date.now() / 1000);
  const originUser = originData?.user_info || {};
  const originServer = originData?.server_info || {};

  let expiry = 0;
  if (authResult.validade) {
    const dt = new Date(`${authResult.validade}T23:59:59-03:00`);
    if (!Number.isNaN(dt.getTime())) expiry = Math.floor(dt.getTime() / 1000);
  }

  return {
    ...originData,
    user_info: {
      ...originUser,
      username,
      password,
      message: authResult.nome ? `P2 Player • ${authResult.nome}` : "P2 Player",
      auth: 1,
      status: "Active",
      exp_date: expiry > 0 ? String(expiry) : String(originUser.exp_date || "0"),
      is_trial: String(originUser.is_trial || "0"),
      active_cons: "0",
      max_connections: "3",
      allowed_output_formats: Array.isArray(originUser.allowed_output_formats)
        ? originUser.allowed_output_formats
        : ["m3u8", "ts", "rtmp"]
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
      time_now: new Date().toISOString().replace("T", " ").slice(0, 19)
    }
  };
}

function extractClientCredentials(req) {
  return {
    username: String(req.query.username || req.params.username || "").trim(),
    password: String(req.query.password || req.params.password || "")
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "P2 Player Xtream Gateway",
    configured: Boolean(
      ORIGIN_BASE &&
      ORIGIN_USERNAME &&
      ORIGIN_PASSWORD &&
      AUTH_URL &&
      AUTH_SECRET
    )
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()) });
});

app.get("/player_api.php", async (req, res) => {
  const { username, password } = extractClientCredentials(req);
  const action = String(req.query.action || "").trim();

  try {
    const client = await validateClient(username, password);

    if (!client.ok) {
      if (!action) {
        return res.status(200).json(
          disabledLogin(username, password, req, client.message || "Conta inválida ou vencida.")
        );
      }
      return res.status(401).json([]);
    }

    if (!action) {
      const origin = await originJson("");
      return res.json(rewriteLoginResponse(origin, username, password, req, client));
    }

    const allowed = new Set([
      "get_live_categories",
      "get_live_streams",
      "get_vod_categories",
      "get_vod_streams",
      "get_vod_info",
      "get_series_categories",
      "get_series",
      "get_series_info",
      "get_short_epg",
      "get_simple_data_table"
    ]);

    if (!allowed.has(action)) {
      return res.status(400).json({ error: "Ação não suportada." });
    }

    const extra = {};
    for (const key of ["category_id","series_id","vod_id","stream_id","limit","start"]) {
      if (req.query[key] !== undefined && req.query[key] !== "") {
        extra[key] = req.query[key];
      }
    }

    const data = await originJson(action, extra);
    return res.json(data);
  } catch (error) {
    console.error("[player_api]", action || "login", error?.message || error);

    if (!action) {
      return res.status(200).json(
        disabledLogin(username, password, req, "Servidor temporariamente indisponível.")
      );
    }

    return res.status(502).json({ error: "Falha temporária ao consultar catálogo." });
  }
});

app.get("/get.php", async (req, res) => {
  const { username, password } = extractClientCredentials(req);

  try {
    const client = await validateClient(username, password);
    if (!client.ok) {
      return res.status(401).type("text/plain").send("Conta inválida ou vencida.");
    }

    const params = new URLSearchParams({
      username: ORIGIN_USERNAME,
      password: ORIGIN_PASSWORD,
      type: String(req.query.type || "m3u_plus"),
      output: String(req.query.output || "m3u8")
    });

    return res.redirect(302, `${ORIGIN_BASE}/get.php?${params.toString()}`);
  } catch (error) {
    console.error("[get.php]", error?.message || error);
    return res.status(502).type("text/plain").send("Falha temporária.");
  }
});

app.get("/xmltv.php", async (req, res) => {
  const { username, password } = extractClientCredentials(req);

  try {
    const client = await validateClient(username, password);
    if (!client.ok) {
      return res.status(401).type("text/plain").send("Conta inválida ou vencida.");
    }

    const params = new URLSearchParams({
      username: ORIGIN_USERNAME,
      password: ORIGIN_PASSWORD
    });

    return res.redirect(302, `${ORIGIN_BASE}/xmltv.php?${params.toString()}`);
  } catch (error) {
    console.error("[xmltv]", error?.message || error);
    return res.status(502).type("text/plain").send("Falha temporária.");
  }
});

async function streamRedirect(req, res, kind) {
  const { username, password } = extractClientCredentials(req);

  try {
    const client = await validateClient(username, password);
    if (!client.ok) {
      return res.status(401).type("text/plain").send("Conta inválida ou vencida.");
    }

    const id = String(req.params.id || "").replace(/[^0-9A-Za-z_-]/g, "");
    const ext = String(req.params.ext || (kind === "live" ? "m3u8" : "mp4"))
      .replace(/[^0-9A-Za-z]/g, "");

    if (!id) {
      return res.status(400).type("text/plain").send("Stream inválido.");
    }

    const target =
      `${ORIGIN_STREAM_BASE}/${kind}/` +
      `${encodeURIComponent(ORIGIN_USERNAME)}/` +
      `${encodeURIComponent(ORIGIN_PASSWORD)}/` +
      `${encodeURIComponent(id)}.${ext}`;

    return res.redirect(302, target);
  } catch (error) {
    console.error(`[${kind}]`, error?.message || error);
    return res.status(502).type("text/plain").send("Falha temporária.");
  }
}

app.get("/live/:username/:password/:id.:ext", (req, res) => streamRedirect(req, res, "live"));
app.get("/movie/:username/:password/:id.:ext", (req, res) => streamRedirect(req, res, "movie"));
app.get("/series/:username/:password/:id.:ext", (req, res) => streamRedirect(req, res, "series"));

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Rota não encontrada." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] P2 Player Xtream Gateway ativo na porta ${PORT}`);
});
