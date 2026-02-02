const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const VERSION = "1.0.1";
const ENGINE = "IA11";
const API_KEY = process.env.IA11_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 120);

function nowMs() {
  return Date.now();
}
function uid() {
  return crypto.randomBytes(12).toString("hex");
}

function requireKey(req, res, next) {
  const key = req.header("x-ia11-key");

  // Allow calls from your Lovable frontend without key
  const origin = req.headers.origin || "";
  if (origin.includes("lovable") || origin.includes("leenscore")) {
    return next();
  }

  // Otherwise require API key (for private/pro use later)
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({
      status: "error",
      error: { message: "Unauthorized" },
    });
  }

  next();
}


// Very simple in-memory rate limiter (good enough for now)
const buckets = new Map(); // key: ip|mode -> {count, resetAt}
function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString();
  const mode = (req.body?.mode === "pro") ? "pro" : "standard";
  const limit = mode === "pro" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const k = `${ip}|${mode}`;
  const t = nowMs();
  let b = buckets.get(k);

  if (!b || t > b.resetAt) {
    b = { count: 0, resetAt: t + 60_000 };
    buckets.set(k, b);
  }

  b.count += 1;

  if (b.count > limit) {
    const retry = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
    res.setHeader("Retry-After", String(retry));
    return res.status(429).json({
      status: "error",
      error: { message: `Rate limit exceeded (${limit}/min). Retry in ${retry}s.` },
    });
  }

  next();
}

// -------- URL sanitizer (fixes "pattern" issues in UI) --------
function isValidHttpUrl(u) {
  if (!u || typeof u !== "string") return false;
  const s = u.trim();
  return s.startsWith("http://") || s.startsWith("https://");
}

function cleanSources(items) {
  // Keep only sources with valid http/https URLs
  const cleaned = (Array.isArray(items) ? items : [])
    .map((it) => ({
      title: (it?.title || "").toString().trim(),
      url: (it?.url || "").toString().trim(),
      snippet: (it?.snippet || "").toString().trim(),
    }))
    .filter((it) => isValidHttpUrl(it.url));

  // De-dup by url
  const seen = new Set();
  const uniq = [];
  for (const s of cleaned) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    uniq.push(s);
  }
  return uniq.slice(0, 8);
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    message: "IA11 is up",
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    info: "POST /v1/analyze with {text, mode} and header x-ia11-key",
  });
});

async function serperSearch(query, uiLanguage) {
  if (!SERPER_API_KEY) {
    return { ok: false, items: [], error: "Missing SERPER_API_KEY" };
  }

  const hl = uiLanguage === "en" ? "en" : "fr"; // keep simple for now
  const gl = "ca";

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY,
    },
    body: JSON.stringify({
      q: query,
      num: 8,
      gl,
      hl,
    }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, items: [], error: `Serper error ${r.status}: ${txt.slice(0, 200)}` };
  }

  const json = await r.json();
  const organic = Array.isArray(json?.organic) ? json.organic : [];

  const items = organic.slice(0, 8).map((it) => ({
    title: it?.title || "",
    url: it?.link || "",
    snippet: it?.snippet || "",
  }));

  return { ok: true, items, error: null };
}

function buildHeuristicScore(text, sourcesCount) {
  const len = text.trim().length;

  let score = 50;
  let confidence = 0.55;

  if (len < 40) score -= 20;
  else if (len < 90) score -= 8;
  else score += 6;

  if (sourcesCount >= 6) { score += 12; confidence += 0.25; }
  else if (sourcesCount >= 3) { score += 6; confidence += 0.15; }
  else if (sourcesCount >= 1) { score += 2; confidence += 0.05; }
  else { score -= 10; confidence -= 0.15; }

  score = Math.max(5, Math.min(98, score));
  confidence = Math.max(0.1, Math.min(0.98, confidence));

  let riskLevel = "medium";
  if (score >= 80) riskLevel = "low";
  if (score <= 45) riskLevel = "high";

  return { score, confidence, riskLevel };
}

function makeSummary(text, sources, mode) {
  const base =
    mode === "pro"
      ? "Analyse PRO : signaux croisés + recherche web."
      : "Analyse Standard : signaux de base + vérification rapide.";

  const sCount = sources.length;

  return `${base} ${sCount > 0 ? `Trouvé ${sCount} source(s) pertinentes.` : "Aucune source solide trouvée."} ` +
    `Conclusion: à valider avec des sources fiables et le contexte complet.`;
}

function makeReasons(text, sources, mode, searchOk, searchError) {
  const reasons = [];

  const len = text.trim().length;
  if (len < 40) reasons.push("Le texte est très court : risque de contexte manquant.");
  else reasons.push("Le texte contient assez de matière pour analyse (contexte minimal).");

  if (!searchOk) {
    reasons.unshift(`Recherche web indisponible: ${searchError || "unknown"}`);
  } else if (sources.length === 0) {
    reasons.push("Aucune source web claire trouvée via Serper (requête trop vague ou info peu documentée).");
  } else {
    reasons.push("Présence de sources web : on peut croiser et comparer.");
    reasons.push("Vérifie la date des sources : les faits évoluent (politique, économie, etc.).");
  }

  if (mode === "pro") {
    reasons.push("Mode PRO : recherche plus structurée + sortie plus détaillée.");
  } else {
    reasons.push("Mode Standard : sortie plus courte et prudente.");
  }

  return reasons.slice(0, 6);
}

app.post("/v1/analyze", requireKey, rateLimit, async (req, res) => {
  const t0 = nowMs();
  const requestId = uid();

  const text = (req.body?.text || "").toString();
  const mode = (req.body?.mode === "pro") ? "pro" : "standard";
  const uiLanguage = (req.body?.uiLanguage || "fr").toString().toLowerCase();

  if (!text.trim()) {
    return res.status(400).json({
      status: "error",
      requestId,
      error: { message: "Missing 'text' in body" },
    });
  }

  // Build a search query: keep it simple and robust
  const q = text.trim().slice(0, 240);

  let rawSources = [];
  let sources = [];
  let searchOk = false;
  let searchError = null;

  try {
    const out = await serperSearch(q, uiLanguage);
    searchOk = out.ok;
    rawSources = out.items || [];
    searchError = out.error || null;
  } catch (e) {
    searchOk = false;
    searchError = e?.message || "Unknown search error";
  }

  // IMPORTANT: sanitize sources to avoid invalid URL patterns that break UI
  sources = cleanSources(rawSources);

  // Score
  const { score, confidence, riskLevel } = buildHeuristicScore(text, sources.length);
  const summary = makeSummary(text, sources, mode);
  const reasons = makeReasons(text, sources, mode, searchOk, searchError);

  const tookMs = nowMs() - t0;

  return res.json({
    status: "ok",
    requestId,
    engine: ENGINE,
    mode,
    result: {
      score,
      riskLevel,
      summary,
      reasons,
      confidence,
      sources,
      // optional helper for UI sections that want "best links"
      bestLinks: sources.map((s) => ({ title: s.title, url: s.url })),
    },
    meta: {
      tookMs,
      version: VERSION,
      webSearchUsed: searchOk && sources.length > 0,
    },
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[IA11] listening on :${port}`);
});
