const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const ORIGIN_BASE = String(process.env.ORIGIN_BASE || "http://ativaronline.pro").replace(/\/+$/, "");
const ORIGIN_STREAM_BASE = String(process.env.ORIGIN_STREAM_BASE || ORIGIN_BASE).replace(/\/+$/, "");
const ORIGIN_USERNAME = String(process.env.ORIGIN_USERNAME || "");
const ORIGIN_PASSWORD = String(process.env.ORIGIN_PASSWORD || "");

const USERS_JSON_URL = String(
  process.env.USERS_JSON_URL || "https://p2playerweb.gamer.gd/usuarios.json"
).trim();

const USERS_CACHE_SECONDS = Math.max(
  5,
  Math.min(300, Number(process.env.USERS_CACHE_SECONDS || 30))
);

const REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.REQUEST_TIMEOUT_MS || 60000)
);

let usersCache = {
  expiresAt: 0,
  usuarios: null,
  lastError: null,
  lastStatus: null,
  lastContentType: null,
  lastPreview: null
};

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, Accept, Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function fetchUsersJson(force = false) {
  const now = Date.now();

  if (
    !force &&
    Array.isArray(usersCache.usuarios) &&
    usersCache.expiresAt > now
  ) {
    return usersCache.usuarios;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(USERS_JSON_URL, {
      method: "GET",
      headers: {
        "accept": "application/json,text/plain,*/*",
        "accept-encoding": "identity",
        "cache-control": "no-cache",
        "user-agent": "Mozilla/5.0 (compatible; P2PlayerXtream/2.0)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const text = await response.text();

    usersCache.lastStatus = response.status;
    usersCache.lastContentType = response.headers.get("content-type") || "";
    usersCache.lastPreview = text.slice(0, 500);

    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `usuarios.json nao retornou JSON valido. HTTP ${response.status}, Content-Type ${usersCache.lastContentType}`
      );
    }

    if (
      !json ||
      !Array.isArray(json.usuarios)
    ) {
      throw new Error("usuarios.json nao possui o campo usuarios em formato de lista.");
    }

    usersCache = {
      ...usersCache,
      expiresAt: now + USERS_CACHE_SECONDS * 1000,
      usuarios: json.usuarios,
      lastError: null
    };

    console.log(
      `[USERS] HTTP ${response.status} | ${usersCache.lastContentType} | usuarios=${json.usuarios.length}`
    );

    return json.usuarios;

  } catch (error) {
    usersCache.lastError = String(error?.message || error);

    console.error(
      "[USERS]",
      usersCache.lastError,
      "| preview:",
      usersCache.lastPreview || "-"
    );

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isExpired(validade) {
  const v = String(validade || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;

  const end = new Date(`${v}T23:59:59-03:00`);
  return Number.isNaN(end.getTime()) || Date.now() > end.getTime();
}

async function validateClient(username, password) {
  const usuarios = await fetchUsersJson();

  const u = String(username || "").trim();
  const p = String(password || "");

  const cliente = usuarios.find(item => {
    if (!item || typeof item !== "object") return false;

    return (
      String(item.usuario || "").toLowerCase() === u.toLowerCase() &&
      String(item.senha || "") === p
    );
  });

  if (!cliente) {
    return {
      ok: false,
      status: "Disabled",
      message: "Usuario ou senha invalidos."
    };
  }

  const status = String(cliente.status || "ativo").trim().toLowerCase();
  const blocked =
    cliente.bloqueado === true ||
    ["bloqueado", "inativo", "suspenso", "desativado"].includes(status);

  if (blocked) {
    return {
      ok: false,
      status: "Disabled",
      message: "Conta bloqueada."
    };
  }

  if (isExpired(cliente.validade)) {
    return {
      ok: false,
      status: "Expired",
      message: "Conta vencida.",
      validade: String(cliente.validade || "")
    };
  }

  return {
    ok: true,
    status: "Active",
    message: "Acesso autorizado.",
    validade: String(cliente.validade || ""),
    nome: String(cliente.nome || ""),
    tipo_conta: String(cliente.tipo_conta || "cliente")
  };
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
    const response = await fetch(
      `${ORIGIN_BASE}/player_api.php?${params.toString()}`,
      {
        headers: {
          "accept": "application/json,*/*",
          "accept-encoding": "identity",
          "user-agent": "Mozilla/5.0 (compatible; P2PlayerXtream/2.0)"
        },
        redirect: "follow",
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(`Origem HTTP ${response.status}`);
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Origem retornou JSON invalido (${text.length} bytes).`);
    }

  } finally {
    clearTimeout(timeout);
  }
}

function disabledLogin(username, password, req, message = "Conta invalida ou vencida.") {
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

function rewriteLoginResponse(originData, username, password, req, client) {
  const now = Math.floor(Date.now() / 1000);
  const originUser = originData?.user_info || {};
  const originServer = originData?.server_info || {};

  let expiry = 0;

  if (client.validade) {
    const dt = new Date(`${client.validade}T23:59:59-03:00`);
    if (!Number.isNaN(dt.getTime())) {
      expiry = Math.floor(dt.getTime() / 1000);
    }
  }

  return {
    ...originData,
    user_info: {
      ...originUser,
      username,
      password,
      message: client.nome ? `P2 Player • ${client.nome}` : "P2 Player",
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

function credentials(req) {
  return {
    username: String(req.query.username || req.params.username || "").trim(),
    password: String(req.query.password || req.params.password || "")
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "P2 Player Xtream Gateway JSON",
    configured: Boolean(
      ORIGIN_BASE &&
      ORIGIN_USERNAME &&
      ORIGIN_PASSWORD &&
      USERS_JSON_URL
    ),
    usersJsonUrl: USERS_JSON_URL,
    usersCache: {
      loaded: Array.isArray(usersCache.usuarios),
      count: Array.isArray(usersCache.usuarios) ? usersCache.usuarios.length : 0,
      lastError: usersCache.lastError,
      lastStatus: usersCache.lastStatus,
      lastContentType: usersCache.lastContentType
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/users-debug", async (_req, res) => {
  try {
    const usuarios = await fetchUsersJson(true);

    return res.json({
      ok: true,
      count: usuarios.length,
      lastStatus: usersCache.lastStatus,
      lastContentType: usersCache.lastContentType
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: usersCache.lastError,
      lastStatus: usersCache.lastStatus,
      lastContentType: usersCache.lastContentType,
      preview: usersCache.lastPreview
    });
  }
});

app.get("/player_api.php", async (req, res) => {
  const { username, password } = credentials(req);
  const action = String(req.query.action || "").trim();

  try {
    const client = await validateClient(username, password);

    if (!client.ok) {
      if (!action) {
        return res.status(200).json(
          disabledLogin(
            username,
            password,
            req,
            client.message || "Conta invalida ou vencida."
          )
        );
      }

      return res.status(401).json([]);
    }

    if (!action) {
      const origin = await originJson("");
      return res.json(
        rewriteLoginResponse(
          origin,
          username,
          password,
          req,
          client
        )
      );
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
      return res.status(400).json({
        error: "Acao nao suportada."
      });
    }

    const extra = {};

    for (const key of [
      "category_id",
      "series_id",
      "vod_id",
      "stream_id",
      "limit",
      "start"
    ]) {
      if (
        req.query[key] !== undefined &&
        req.query[key] !== ""
      ) {
        extra[key] = req.query[key];
      }
    }

    const data = await originJson(action, extra);
    return res.json(data);

  } catch (error) {
    console.error(
      "[player_api]",
      action || "login",
      error?.message || error
    );

    if (!action) {
      return res.status(200).json(
        disabledLogin(
          username,
          password,
          req,
          "Servidor temporariamente indisponivel."
        )
      );
    }

    return res.status(502).json({
      error: "Falha temporaria ao consultar catalogo."
    });
  }
});

app.get("/get.php", async (req, res) => {
  const { username, password } = credentials(req);

  try {
    const client = await validateClient(username, password);

    if (!client.ok) {
      return res.status(401).type("text/plain").send(
        "Conta invalida ou vencida."
      );
    }

    const params = new URLSearchParams({
      username: ORIGIN_USERNAME,
      password: ORIGIN_PASSWORD,
      type: String(req.query.type || "m3u_plus"),
      output: String(req.query.output || "m3u8")
    });

    return res.redirect(
      302,
      `${ORIGIN_BASE}/get.php?${params.toString()}`
    );

  } catch (error) {
    console.error("[get.php]", error?.message || error);

    return res.status(502).type("text/plain").send(
      "Falha temporaria."
    );
  }
});

app.get("/xmltv.php", async (req, res) => {
  const { username, password } = credentials(req);

  try {
    const client = await validateClient(username, password);

    if (!client.ok) {
      return res.status(401).type("text/plain").send(
        "Conta invalida ou vencida."
      );
    }

    const params = new URLSearchParams({
      username: ORIGIN_USERNAME,
      password: ORIGIN_PASSWORD
    });

    return res.redirect(
      302,
      `${ORIGIN_BASE}/xmltv.php?${params.toString()}`
    );

  } catch (error) {
    console.error("[xmltv]", error?.message || error);

    return res.status(502).type("text/plain").send(
      "Falha temporaria."
    );
  }
});

async function streamRedirect(req, res, kind) {
  const { username, password } = credentials(req);

  try {
    const client = await validateClient(username, password);

    if (!client.ok) {
      return res.status(401).type("text/plain").send(
        "Conta invalida ou vencida."
      );
    }

    const id = String(req.params.id || "")
      .replace(/[^0-9A-Za-z_-]/g, "");

    const ext = String(
      req.params.ext ||
      (kind === "live" ? "m3u8" : "mp4")
    ).replace(/[^0-9A-Za-z]/g, "");

    if (!id) {
      return res.status(400).type("text/plain").send(
        "Stream invalido."
      );
    }

    const target =
      `${ORIGIN_STREAM_BASE}/${kind}/` +
      `${encodeURIComponent(ORIGIN_USERNAME)}/` +
      `${encodeURIComponent(ORIGIN_PASSWORD)}/` +
      `${encodeURIComponent(id)}.${ext}`;

    return res.redirect(302, target);

  } catch (error) {
    console.error(
      `[${kind}]`,
      error?.message || error
    );

    return res.status(502).type("text/plain").send(
      "Falha temporaria."
    );
  }
}

app.get(
  "/live/:username/:password/:id.:ext",
  (req, res) => streamRedirect(req, res, "live")
);

app.get(
  "/movie/:username/:password/:id.:ext",
  (req, res) => streamRedirect(req, res, "movie")
);

app.get(
  "/series/:username/:password/:id.:ext",
  (req, res) => streamRedirect(req, res, "series")
);

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Rota nao encontrada."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[server] P2 Player Xtream Gateway JSON ativo na porta ${PORT}`
  );
});
