/**
 * IA11 API (LeenScore) — index.js (Ultra PRO, "living" analysis)
 *
 * Promise:
 * - Same v1 response contract (stable for LeenScore)
 * - Much smarter scoring (multi-signal + claim extraction)
 * - Language-aware output (matches UI / user language)
 * - PRO mode: ready for real web evidence (Bing/SerpAPI later)
 * - Conservative truth assertions: never confidently claim "false" on weak evidence
 *
 * SECURITY / KEY HANDLING (IMPORTANT):
 * - Accepts API key from headers:
 *    1) x-ia11-key: <key>   (preferred)
 *    2) x-api-key: <key>    (fallback)
 *    3) Authorization: Bearer <key> (fallback)
 * - Accepts server-side keys from Render env:
 *    IA11_API_KEY  = "key1"
 *    IA11_API_KEYS = "key1,key2,key3"  (optional rotation / multiple valid keys)
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// --------------------------
// Env
// --------------------------

const ENGINE_NAME = "IA11";
const ENGINE_VERSION = "1.3.0-beton-arme";

const PORT = parseInt(process.env.PORT || "10000", 10);

// Primary key (single)
const IA11_API_KEY_RAW = (process.env.IA11_API_KEY || "").toString();
// Optional multi-keys (comma separated)
const IA11_API_KEYS_RAW = (process.env.IA11_API_KEYS || "").toString();

// Optional keys for future “real web evidence”
const BING_API_KEY = (process.env.BING_API_KEY || "").toString().trim();
const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").toString().trim();
const PROVIDER = ((process.env.WEB_EVIDENCE_PROVIDER || "bing") + "").toLowerCase().trim();

const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);
const RATE_LIMIT_PER_MIN_PRO = parseInt(process.env.RATE_LIMIT_PER_MIN_PRO || "60", 10);

// --------------------------
// App init
// --------------------------

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --------------------------
// Helpers
// --------------------------

function safeTrim(s, max = 20000) {
  const t = (s || "").toString().trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

function normalizeLang(raw) {
  const x = (raw || "").toString().trim().toLowerCase();
  if (!x) return "fr";
  const base = x.split(",")[0].trim().split(";")[0].trim().split("-")[0].trim();
  const allowed = new Set(["fr", "en", "es", "it", "de", "pt", "ru", "uk", "ja"]);
  return allowed.has(base) ? base : "fr";
}

function t(lang, key) {
  const dict = {
    fr: {
      ok: "OK",
      missingText: "Texte manquant.",
      tooShort: "Texte trop court pour être analysé.",
      invalidKey: "Clé API invalide.",
      rateLimited: "Trop de requêtes. Réessaie dans une minute.",
      summary: "Estimation de crédibilité IA11 basée sur signaux du texte et prudence sur les affirmations.",
    },
    en: {
      ok: "OK",
      missingText: "Missing text.",
      tooShort: "Text too short to analyze.",
      invalidKey: "Invalid API key.",
      rateLimited: "Too many requests. Try again in a minute.",
      summary: "IA11 credibility estimate based on text signals and conservative truth assertions.",
    },
    es: {
      ok: "OK",
      missingText: "Falta el texto.",
      tooShort: "Texto demasiado corto para analizar.",
      invalidKey: "Clave API inválida.",
      rateLimited: "Demasiadas solicitudes. Intenta de nuevo en un minuto.",
      summary: "Estimación de credibilidad IA11 basada en señales del texto y prudencia con las afirmaciones.",
    },
    it: {
      ok: "OK",
      missingText: "Testo mancante.",
      tooShort: "Testo troppo corto per essere analizzato.",
      invalidKey: "Chiave API non valida.",
      rateLimited: "Troppe richieste. Riprova tra un minuto.",
      summary: "Stima di credibilità IA11 basata su segnali del testo e prudenza sulle affermazioni.",
    },
    de: {
      ok: "OK",
      missingText: "Text fehlt.",
      tooShort: "Text zu kurz zur Analyse.",
      invalidKey: "Ungültiger API-Schlüssel.",
      rateLimited: "Zu viele Anfragen. Versuche es in einer Minute erneut.",
      summary: "IA11-Glaubwürdigkeits-Schätzung basierend auf Textsignalen und konservativen Aussagen.",
    },
    pt: {
      ok: "OK",
      missingText: "Texto ausente.",
      tooShort: "Texto muito curto para analisar.",
      invalidKey: "Chave de API inválida.",
      rateLimited: "Muitas solicitações. Tente novamente em um minuto.",
      summary: "Estimativa de credibilidade IA11 baseada em sinais do texto e prudência nas afirmações.",
    },
    ru: {
      ok: "ОК",
      missingText: "Текст отсутствует.",
      tooShort: "Текст слишком короткий для анализа.",
      invalidKey: "Неверный API-ключ.",
      rateLimited: "Слишком много запросов. Попробуйте через минуту.",
      summary: "Оценка достоверности IA11 на основе сигналов текста и осторожности в выводах.",
    },
    uk: {
      ok: "ОК",
      missingText: "Текст відсутній.",
      tooShort: "Текст занадто короткий для аналізу.",
      invalidKey: "Недійсний API-ключ.",
      rateLimited: "Забагато запитів. Спробуйте за хвилину.",
      summary: "Оцінка достовірності IA11 на основі сигналів тексту та обережності у висновках.",
    },
    ja: {
      ok: "OK",
      missingText: "テキストがありません。",
      tooShort: "分析するにはテキストが短すぎます。",
      invalidKey: "APIキーが無効です。",
      rateLimited: "リクエストが多すぎます。1分後に再試行してください。",
      summary: "IA11は文章のシグナルをもとに、断定を避けつつ信頼性を推定します。",
    },
  };
  const d = dict[lang] || dict.fr;
  return d[key] || dict.fr[key] || key;
}

function newRequestId() {
  return crypto.randomBytes(12).toString("hex");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function unwrapQuotes(s) {
  const x = (s || "").toString().trim();
  if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) {
    return x.slice(1, -1).trim();
  }
  return x;
}

function parseValidKeys() {
  const keys = [];

  const one = unwrapQuotes(IA11_API_KEY_RAW).trim();
  if (one) keys.push(one);

  const multiRaw = unwrapQuotes(IA11_API_KEYS_RAW);
  if (multiRaw) {
    multiRaw
      .split(",")
      .map((k) => unwrapQuotes(k).trim())
      .filter(Boolean)
      .forEach((k) => keys.push(k));
  }

  // de-dup
  return Array.from(new Set(keys));
}

const VALID_KEYS = parseValidKeys();

if (!VALID_KEYS.length) {
  console.error("❌ Missing env var IA11_API_KEY (or IA11_API_KEYS). Set it in Render > Environment.");
  process.exit(1);
}

function getProvidedKey(req) {
  const k1 = (req.headers["x-ia11-key"] || "").toString().trim();
  if (k1) return k1;

  const k2 = (req.headers["x-api-key"] || "").toString().trim();
  if (k2) return k2;

  const auth = (req.headers["authorization"] || "").toString().trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    const k3 = auth.slice(7).trim();
    if (k3) return k3;
  }

  return "";
}

function isKeyValid(providedKey) {
  if (!providedKey) return false;

  // constant-time compare against each valid key (avoid timing leaks)
  const p = Buffer.from(providedKey);
  for (const k of VALID_KEYS) {
    const kb = Buffer.from(k);
    if (p.length !== kb.length) continue;
    try {
      if (crypto.timingSafeEqual(p, kb)) return true;
    } catch (_) {
      // ignore
    }
  }
  return false;
}

function simpleClaimHints(text) {
  const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const candidates = [];
  for (const l of lines) {
    if (l.length < 18) continue;
    if (
      /(est|sont|was|were|is|are|will be|sera|seront|devient|becomes|président|president|guerre|war|attaque|attack|mort|dead|élu|elected)/i.test(
        l
      )
    ) {
      candidates.push(l.slice(0, 200));
    }
    if (candidates.length >= 6) break;
  }
  return candidates;
}

function scoreSignals(text) {
  const len = text.length;
  const hasUrl = /(https?:\/\/|www\.)/i.test(text);
  const hasNumbers = /\d/.test(text);
  const hasAllCaps = /[A-Z]{10,}/.test(text);
  const hasLotsOfExcl = /!{3,}/.test(text);
  const hasQuestionMarks = /\?{2,}/.test(text);
  const looksLikeRage = /(100%|certain|jamais|toujours|prove|proof|obvious|réveillez-vous)/i.test(text);

  let score = 60;

  if (len < 40) score -= 25;
  else if (len < 80) score -= 12;
  else if (len > 400) score += 6;

  if (text.split("\n").length >= 3) score += 4;
  if (hasNumbers) score += 3;
  if (hasUrl) score += 4;

  if (hasAllCaps) score -= 6;
  if (hasLotsOfExcl) score -= 6;
  if (hasQuestionMarks) score -= 3;
  if (looksLikeRage) score -= 6;

  score = clamp(score, 5, 98);

  const reasons = [];
  reasons.push(len < 80 ? "Texte court: prudence accrue" : "Longueur de texte suffisante");
  if (hasUrl) reasons.push("Présence de lien(s): meilleur contexte potentiel");
  if (hasNumbers) reasons.push("Présence de chiffres: signal de précision (à vérifier)");
  if (hasAllCaps || hasLotsOfExcl || looksLikeRage) reasons.push("Signaux de ton émotionnel / persuasion détectés");

  return { score, reasons };
}

function riskFromScore(score) {
  if (score >= 80) return "low";
  if (score >= 55) return "medium";
  return "high";
}

// --------------------------
// API key middleware
// --------------------------

function requireKey(req, res, next) {
  const provided = getProvidedKey(req);
  const uiLang = normalizeLang(req.headers["x-ui-lang"] || req.headers["accept-language"]);

  if (!isKeyValid(provided)) {
    return res.status(401).json({
      status: "error",
      requestId: newRequestId(),
      engine: ENGINE_NAME,
      mode: "standard",
      result: {
        score: 5,
        riskLevel: "high",
        summary: t(uiLang, "invalidKey"),
        reasons: [],
        confidence: 0.2,
        sources: [],
      },
      meta: { tookMs: 0, version: ENGINE_VERSION },
    });
  }

  next();
}

// --------------------------
// In-memory rate limit (per client + tier)
// --------------------------

const rateStore = new Map();

function getClientId(req) {
  const rawKey = (req.headers["x-client-id"] || "").toString().trim();
  if (rawKey) {
    return "cid:" + crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
  }

  const xff = (req.headers["x-forwarded-for"] || "").toString();
  const ipFromXff = xff.split(",")[0].trim();
  const ip = ipFromXff || req.ip || "unknown";
  return "ip:" + ip;
}

function rateLimitMiddleware(req, res, next) {
  const tier = (req.headers["x-tier"] || "standard").toString().toLowerCase();
  const limit =
    tier === "pro" || tier === "premium" || tier === "premium_plus"
      ? RATE_LIMIT_PER_MIN_PRO
      : RATE_LIMIT_PER_MIN;

  const clientId = getClientId(req);
  const key = `${clientId}:${tier}`;
  const now = Date.now();
  const windowMs = 60_000;

  const entry = rateStore.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count += 1;
  rateStore.set(key, entry);

  if (entry.count > limit) {
    const lang = normalizeLang(req.headers["x-ui-lang"] || req.headers["accept-language"]);
    return res.status(429).json({
      status: "error",
      requestId: newRequestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 5,
        riskLevel: "high",
        summary: t(lang, "rateLimited"),
        reasons: [],
        confidence: 0.2,
        sources: [],
      },
      meta: { tookMs: 0, version: ENGINE_VERSION },
    });
  }

  next();
}

// --------------------------
// Routes
// --------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    time: new Date().toISOString(),
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    hint: "Use POST /v1/analyze with header x-ia11-key (preferred) and JSON { text }",
    authAccepted: ["x-ia11-key", "x-api-key", "authorization: bearer <key>"],
  });
});

app.post("/v1/analyze", requireKey, rateLimitMiddleware, async (req, res) => {
  const started = Date.now();

  const tier = (req.headers["x-tier"] || "standard").toString().toLowerCase();
  const uiLang = normalizeLang(req.headers["x-ui-lang"] || req.headers["accept-language"]);

  const rawText = safeTrim(req.body && req.body.text, 20000);

  if (!rawText) {
    return res.status(400).json({
      status: "error",
      requestId: newRequestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 5,
        riskLevel: "high",
        summary: t(uiLang, "missingText"),
        reasons: [],
        confidence: 0.2,
        sources: [],
      },
      meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
    });
  }

  if (rawText.length < 12) {
    return res.status(400).json({
      status: "error",
      requestId: newRequestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 8,
        riskLevel: "high",
        summary: t(uiLang, "tooShort"),
        reasons: [],
        confidence: 0.25,
        sources: [],
      },
      meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
    });
  }

  const requestId = newRequestId();
  const claims = simpleClaimHints(rawText);
  const signals = scoreSignals(rawText);

  let confidence = 0.6;
  if (signals.score >= 80) confidence = 0.86;
  else if (signals.score >= 55) confidence = 0.72;
  else confidence = 0.58;

  const sources = [];
  const proMode = tier === "pro" || tier === "premium" || tier === "premium_plus";

  const result = {
    score: signals.score,
    riskLevel: riskFromScore(signals.score),
    summary: t(uiLang, "summary"),
    reasons: [
      ...signals.reasons,
      ...(claims.length ? ["Exemples d’affirmations détectées: " + claims.slice(0, 3).join(" | ")] : []),
      proMode
        ? `Mode PRO actif (preuve web: ${PROVIDER}${BING_API_KEY || SERPAPI_KEY ? ", clé détectée" : ", aucune clé fournie"})`
        : "Mode Standard: analyse prudente sans preuve web externe",
    ],
    confidence,
    sources,
  };

  return res.json({
    status: "success",
    requestId,
    engine: ENGINE_NAME,
    mode: proMode ? "pro" : "standard",
    result,
    meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
  });
});

// --------------------------
// Start
// --------------------------

app.listen(PORT, () => {
  console.log(`✅ IA11 API running on port ${PORT} (${ENGINE_NAME} ${ENGINE_VERSION})`);
  console.log(`🔐 IA11 keys loaded: ${VALID_KEYS.length} key(s)`);
});
