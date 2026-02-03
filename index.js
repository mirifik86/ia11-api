/**
 * IA11 PRO — LeenScore Engine (single-file) — v2.2.1
 * GOAL: credible outputs (contradiction-aware) + real score range + UI-ready breakdown.
 *
 * INPUT  (POST /v1/analyze):
 *  { text: string, mode?: "standard"|"pro", uiLanguage?: "fr"|"en" }
 *
 * OUTPUT:
 *  { status:"ok", requestId, engine, mode, result:{ score, riskLevel, summary, reasons, confidence, breakdown, corroboration, sources, bestLinks, debug }, meta:{...} }
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ---- fetch safety (Render/Node compatibility) ----
let _fetch = global.fetch;
if (!_fetch) {
  try {
    _fetch = require("node-fetch");
  } catch (e) {
    // If fetch is missing AND node-fetch is not installed, Serper will fail gracefully.
    _fetch = null;
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// =====================
// Core config
// =====================
const VERSION = "2.2.1-pro";
const ENGINE = "IA11";

const API_KEY = process.env.IA11_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

// IMPORTANT: you said you want KEY security (world project).
// Keep bypass OFF by default. If you ever enable it, it is still constrained by allowed origins.
const ALLOW_FRONTEND_BYPASS =
  String(process.env.IA11_ALLOW_FRONTEND_BYPASS || "false").toLowerCase() === "true";

// Put ONLY domains here (no protocol). Example: lovable.app, leenscore.com
const ALLOWED_ORIGINS = (process.env.IA11_ALLOWED_ORIGINS || "lovable.app,leenscore.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 120);

const SERPER_NUM = Number(process.env.SERPER_NUM || 8);
const SERPER_GL = (process.env.SERPER_GL || "ca").toLowerCase();

const CACHE_TTL_MS = Number(process.env.IA11_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX = Number(process.env.IA11_CACHE_MAX || 300);

// =====================
// CORS (PRO + stable for browser + Lovable)
// =====================
// We allow only configured origins AND allow the custom header x-ia11-key.
function originAllowed(origin) {
  if (!origin) return true; // server-to-server or curl
  try {
    const u = new URL(origin);
    const host = (u.hostname || "").toLowerCase();
    // allow if hostname ends with any allowed domain (lovable.app covers *.lovable.app)
    return ALLOWED_ORIGINS.some((d) => d && (host === d || host.endsWith("." + d)));
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (originAllowed(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-ia11-key"],
    credentials: false,
    maxAge: 86400,
  })
);

// Preflight must return OK
app.options("*", cors());

// =====================
// Utilities
// =====================
function nowMs() {
  return Date.now();
}
function uid() {
  return crypto.randomBytes(12).toString("hex");
}
function safeStr(x, max = 5000) {
  return (x ?? "").toString().slice(0, max);
}
function detectUiLanguage(uiLanguage) {
  const l = safeStr(uiLanguage, 10).toLowerCase();
  if (l.startsWith("en")) return "en";
  return "fr";
}

const I18N = {
  fr: {
    unauthorized: "Unauthorized",
    missingText: "Missing 'text' in body",
    missingSerper: "Missing SERPER_API_KEY",
    webDown: "Recherche web indisponible",
    proHeader: "Analyse PRO",
    stdHeader: "Analyse Standard",
    foundSources: (n) => `Trouvé ${n} source(s) pertinente(s).`,
    noSources: "Aucune source solide trouvée.",
    conclusion: "Conclusion",
    verifyDates: "Vérifie les dates (politique/économie évoluent vite).",
    tooShort: "Texte très court : contexte faible, risque élevé.",
    enoughContext: "Texte assez long : contexte minimal présent.",
    evidenceStrong: "Preuves solides (plusieurs sources crédibles).",
    evidenceMedium: "Preuves moyennes (sources présentes mais à recouper).",
    evidenceWeak: "Preuves faibles (peu de sources ou sources fragiles).",
    contradicted: "Contredit par des sources fiables.",
    uncertain: "Incertitude : sources mixtes ou insuffisantes.",
    confirmed: "Confirmé par des sources crédibles cohérentes.",
    tip: "Astuce : ajoute un fait précis + lieu + date pour une vérif béton.",
    outcomeConfirmed: "confirmé",
    outcomeUncertain: "incertain",
    outcomeContradicted: "contredit",
  },
  en: {
    unauthorized: "Unauthorized",
    missingText: "Missing 'text' in body",
    missingSerper: "Missing SERPER_API_KEY",
    webDown: "Web search unavailable",
    proHeader: "PRO analysis",
    stdHeader: "Standard analysis",
    foundSources: (n) => `Found ${n} relevant source(s).`,
    noSources: "No solid sources found.",
    conclusion: "Conclusion",
    verifyDates: "Check dates (politics/economy change fast).",
    tooShort: "Very short text: weak context, higher risk.",
    enoughContext: "Text long enough: minimal context present.",
    evidenceStrong: "Strong evidence (multiple credible sources).",
    evidenceMedium: "Medium evidence (sources exist, still cross-check).",
    evidenceWeak: "Weak evidence (few sources or fragile sources).",
    contradicted: "Contradicted by credible sources.",
    uncertain: "Uncertain: mixed or insufficient sources.",
    confirmed: "Confirmed by consistent credible sources.",
    tip: "Tip: add a precise fact + place + date for a rock-solid check.",
    outcomeConfirmed: "confirmed",
    outcomeUncertain: "uncertain",
    outcomeContradicted: "contradicted",
  },
};

function pickT(lang) {
  return I18N[lang] || I18N.fr;
}

// =====================
// Security gate
// =====================
function isAllowedBrowser(req) {
  const origin = safeStr(req.headers.origin, 300).toLowerCase();
  const referer = safeStr(req.headers.referer, 500).toLowerCase();
  // If bypass enabled, we still require the browser to come from allowed origins.
  // This is a fallback only. For "world" security, keep bypass = false.
  const hay = `${origin} ${referer}`;
  return ALLOWED_ORIGINS.some((d) => d && hay.includes(d));
}

function requireKey(req, res, next) {
  if (req.method === "GET") return next();

  const key = safeStr(req.header("x-ia11-key"), 200);

  // Bypass is OFF by default. If ever ON, it is origin-limited.
  if (ALLOW_FRONTEND_BYPASS && isAllowedBrowser(req)) return next();

  if (!API_KEY || key !== API_KEY) {
    const lang = detectUiLanguage(req.body?.uiLanguage);
    const t = pickT(lang);
    return res.status(401).json({
      status: "error",
      error: { message: t.unauthorized },
    });
  }
  next();
}

// =====================
// Rate limiter
// =====================
const buckets = new Map();

function getClientIp(req) {
  const xff = safeStr(req.headers["x-forwarded-for"], 200);
  if (xff) return xff.split(",")[0].trim();
  return safeStr(req.socket?.remoteAddress, 80) || "unknown";
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const mode = req.body?.mode === "pro" ? "pro" : "standard";
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

// =====================
// Sources sanitation + trust hints
// =====================
function isValidHttpUrl(u) {
  if (!u || typeof u !== "string") return false;
  const s = u.trim();
  return s.startsWith("http://") || s.startsWith("https://");
}

function getDomain(url) {
  try {
    const u = new URL(url);
    return (u.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function domainTrust(domain) {
  if (!domain) return 0;
  if (domain.endsWith(".gov") || domain.endsWith(".gc.ca")) return 3;
  if (domain.endsWith(".edu")) return 2;
  if (domain.includes("wikipedia.org")) return 1;
  if (domain.includes("reuters.com") || domain.includes("apnews.com")) return 2;
  if (domain.includes("bbc.co.uk") || domain.includes("bbc.com")) return 2;
  if (domain.includes("canada.ca") || domain.includes("who.int") || domain.includes("un.org")) return 3;
  return 0;
}

function cleanSources(items) {
  const cleaned = (Array.isArray(items) ? items : [])
    .map((it) => {
      const url = safeStr(it?.url, 1000).trim();
      const domain = getDomain(url);
      return {
        title: safeStr(it?.title, 220).trim(),
        url,
        snippet: safeStr(it?.snippet, 420).trim(),
        domain,
        trust: domainTrust(domain),
      };
    })
    .filter((it) => isValidHttpUrl(it.url));

  const seen = new Set();
  const uniq = [];
  for (const s of cleaned) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    uniq.push(s);
  }

  uniq.sort((a, b) => b.trust - a.trust);
  return uniq.slice(0, 8);
}

// =====================
// Serper cache
// =====================
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (nowMs() - v.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { at: nowMs(), data });
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

// =====================
// Query shaping
// =====================
function normalizeQuery(text) {
  const t = safeStr(text, 2000).replace(/\s+/g, " ").trim();
  return t.replace(/[^\S\r\n]+/g, " ").slice(0, 260);
}

function buildQueries(text, mode, lang) {
  const base = normalizeQuery(text);
  if (!base) return [];

  if (mode !== "pro") return [base];

  const lower = base.toLowerCase();
  const looksLikeClaim =
    lower.includes(" est ") ||
    lower.includes(" est un ") ||
    lower.includes(" est une ") ||
    lower.includes(" is ") ||
    lower.includes(" is a ") ||
    lower.includes(" president") ||
    lower.includes(" président") ||
    lower.includes(" prime minister") ||
    lower.includes(" premier ministre");

  const factCheck = lang === "en" ? " fact check" : " vérification";
  const currentYear = new Date().getFullYear();
  const yearHint = ` ${currentYear}`;

  const q1 = base;
  const q2 = looksLikeClaim ? base + factCheck : base + yearHint;
  const q3 = looksLikeClaim ? base + yearHint : base + factCheck;

  const qs = [q1, q2, q3].map((q) => q.trim()).filter(Boolean);
  return [...new Set(qs)].slice(0, 3);
}

// =====================
// Serper search
// =====================
async function serperSearch(query, uiLanguage) {
  if (!SERPER_API_KEY) {
    return { ok: false, items: [], error: "Missing SERPER_API_KEY" };
  }
  if (!_fetch) {
    return { ok: false, items: [], error: "Missing fetch runtime (node-fetch not installed)" };
  }

  const lang = detectUiLanguage(uiLanguage);
  const hl = lang === "en" ? "en" : "fr";
  const gl = SERPER_GL;

  const cacheKey = `serper:${hl}:${gl}:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ok: true, items: cached, error: null, cached: true };

  const r = await _fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY,
    },
    body: JSON.stringify({ q: query, num: SERPER_NUM, gl, hl }),
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

  cacheSet(cacheKey, items);
  return { ok: true, items, error: null, cached: false };
}

async function serperMultiSearch(text, mode, uiLanguage) {
  const lang = detectUiLanguage(uiLanguage);
  const queries = buildQueries(text, mode, lang);

  let all = [];
  let okCount = 0;
  let lastError = null;

  for (const q of queries) {
    try {
      const out = await serperSearch(q, lang);
      if (out.ok) {
        okCount += 1;
        all = all.concat(out.items || []);
      } else {
        lastError = out.error || lastError;
      }
    } catch (e) {
      lastError = e?.message || lastError || "Unknown search error";
    }
  }

  return {
    ok: okCount > 0,
    items: all,
    error: okCount > 0 ? null : lastError || "Unknown search error",
    queries,
  };
}

// =====================
// CONTRADICTION CHECK (lightweight but effective for obvious lies)
// =====================
function normalizeTextForMatch(s) {
  return safeStr(s, 2000).toLowerCase().replace(/\s+/g, " ").trim();
}

function extractSimpleClaim(text, lang) {
  const t = safeStr(text, 800).trim();
  const lower = t.toLowerCase();

  if (lang === "fr") {
    const m = lower.match(/^(.{2,60})\s+est\s+(une|un)\s+(.{2,80})$/i);
    if (m) return { subject: m[1].trim(), object: m[3].trim(), kind: "is-a" };
  }

  if (lang === "en") {
    const m = lower.match(/^(.{2,60})\s+is\s+(a|an)\s+(.{2,80})$/i);
    if (m) return { subject: m[1].trim(), object: m[3].trim(), kind: "is-a" };
  }

  return null;
}

const TYPE_GROUPS = {
  city: ["city", "town", "ville", "municipalité"],
  country: ["country", "nation", "pays", "état", "state"],
};

function typeFromObject(objLower) {
  const o = objLower;
  for (const k of Object.keys(TYPE_GROUPS)) {
    if (TYPE_GROUPS[k].some((w) => o.includes(w))) return k;
  }
  return null;
}

function snippetSaysType(subjectLower, snippetLower, typeKey) {
  const words = TYPE_GROUPS[typeKey] || [];
  if (!snippetLower.includes(subjectLower)) return false;
  return words.some((w) => snippetLower.includes(w));
}

function assessContradiction(text, sources, lang) {
  const claim = extractSimpleClaim(text, lang);
  if (!claim) return { detected: false, strength: 0, note: null };

  const subject = claim.subject;
  const object = claim.object;

  const subjL = subject.toLowerCase();
  const objL = object.toLowerCase();

  const claimedType = typeFromObject(objL);
  if (!claimedType) return { detected: false, strength: 0, note: null };

  const snippets = sources.map((s) => normalizeTextForMatch(`${s.title} ${s.snippet}`));

  let support = 0;
  let oppose = 0;

  for (const sn of snippets) {
    if (snippetSaysType(subjL, sn, claimedType)) support += 1;

    if (claimedType === "city" && snippetSaysType(subjL, sn, "country")) oppose += 1;
    if (claimedType === "country" && snippetSaysType(subjL, sn, "city")) oppose += 1;
  }

  if (oppose >= 2 && support === 0) {
    return {
      detected: true,
      strength: 3,
      note: `${subject} vs type mismatch: claim "${claimedType}" but sources strongly show opposite.`,
      support,
      oppose,
    };
  }

  if (oppose > support) {
    return {
      detected: true,
      strength: 2,
      note: `${subject} seems inconsistent with sources.`,
      support,
      oppose,
    };
  }

  return { detected: false, strength: 0, note: null, support, oppose };
}

// =====================
// SCORING + BREAKDOWN (UI-ready)
// =====================
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function computeEvidence(sources) {
  const sCount = sources.length;
  const trustSum = sources.reduce((a, s) => a + (s.trust || 0), 0);

  let label = "weak";
  if (sCount >= 3 && trustSum >= 3) label = "medium";
  if (sCount >= 5 && trustSum >= 6) label = "strong";

  return { sCount, trustSum, label };
}

function buildBreakdown(lang, evidence, textLen, contradiction) {
  const t = pickT(lang);

  let sourcesPts = 0;
  if (evidence.label === "strong") sourcesPts = 18;
  else if (evidence.label === "medium") sourcesPts = 12;
  else if (evidence.sCount >= 1) sourcesPts = 7;
  else sourcesPts = 2;

  let factualPts = 10;
  if (contradiction.detected && contradiction.strength >= 2) factualPts = 2;
  else if (contradiction.detected) factualPts = 6;

  let contextPts = textLen >= 220 ? 16 : textLen >= 90 ? 12 : textLen >= 40 ? 8 : 4;

  let tonePts = 12;
  if (contradiction.detected) tonePts = 14;
  if (evidence.label === "strong" && !contradiction.detected) tonePts = 10;

  let transparencyPts = evidence.sCount >= 3 ? 14 : evidence.sCount >= 1 ? 10 : 6;

  return {
    sources: { points: sourcesPts, reason: evidence.sCount ? t.foundSources(evidence.sCount) : t.noSources },
    factual: {
      points: factualPts,
      reason: contradiction.detected ? t.contradicted : (evidence.label === "strong" ? t.confirmed : t.uncertain),
    },
    tone: { points: tonePts, reason: t.verifyDates },
    context: { points: contextPts, reason: textLen < 40 ? t.tooShort : t.enoughContext },
    transparency: { points: transparencyPts, reason: t.tip },
  };
}

function scoreFromSignals(textLen, evidence, contradiction, mode) {
  let score = 60;

  if (textLen < 40) score -= 20;
  else if (textLen < 90) score -= 10;
  else if (textLen > 220) score += 6;

  if (evidence.label === "strong") score += 18;
  else if (evidence.label === "medium") score += 10;
  else if (evidence.sCount >= 1) score += 3;
  else score -= 18;

  if (evidence.trustSum >= 6) score += 8;
  else if (evidence.trustSum >= 3) score += 4;
  else if (evidence.trustSum >= 1) score += 1;

  if (contradiction.detected && contradiction.strength >= 3) score = Math.min(score, 22);
  else if (contradiction.detected && contradiction.strength >= 2) score = Math.min(score, 32);
  else if (contradiction.detected) score = Math.min(score, 45);

  if (mode === "pro" && evidence.label === "weak") score -= 6;

  score = clamp(Math.round(score), 5, 98);

  let confidence = 0.55;
  if (evidence.label === "strong") confidence += 0.25;
  if (evidence.label === "medium") confidence += 0.15;
  if (evidence.sCount === 0) confidence -= 0.20;
  if (textLen < 40) confidence -= 0.10;
  if (contradiction.detected) confidence += 0.05;
  confidence = clamp(Number(confidence.toFixed(2)), 0.1, 0.95);

  let riskLevel = "medium";
  if (score >= 80) riskLevel = "low";
  if (score <= 45) riskLevel = "high";

  let outcome = "uncertain";
  if (contradiction.detected && contradiction.strength >= 2) outcome = "contradicted";
  else if (!contradiction.detected && evidence.label === "strong") outcome = "confirmed";

  return { score, confidence, riskLevel, outcome };
}

function makeSummary(lang, mode, score, riskLevel, evidenceLabel, outcome, sourcesCount) {
  const t = pickT(lang);

  const header = mode === "pro" ? t.proHeader : t.stdHeader;

  const evidenceLine =
    evidenceLabel === "strong" ? t.evidenceStrong :
    evidenceLabel === "medium" ? t.evidenceMedium :
    t.evidenceWeak;

  const sourcesLine = sourcesCount > 0 ? t.foundSources(sourcesCount) : t.noSources;

  const outcomeLine =
    outcome === "confirmed" ? t.confirmed :
    outcome === "contradicted" ? t.contradicted :
    t.uncertain;

  return [
    `${header} — Score: ${score}/100 — Risque: ${riskLevel.toUpperCase()}.`,
    outcomeLine,
    sourcesLine,
    evidenceLine,
    `${t.conclusion}: si c’est un fait “sensible” (politique, santé, argent), recoupe 2 sources crédibles minimum.`,
    t.verifyDates,
  ].join(" ");
}

function makeReasons(lang, mode, textLen, evidence, searchOk, searchError, contradiction) {
  const t = pickT(lang);
  const reasons = [];

  if (!searchOk) reasons.push(`${t.webDown}: ${searchError || "unknown"}`);

  if (textLen < 40) reasons.push(t.tooShort);
  else reasons.push(t.enoughContext);

  if (contradiction.detected) reasons.push(t.contradicted);

  if (evidence.label === "strong") reasons.push(t.evidenceStrong);
  else if (evidence.label === "medium") reasons.push(t.evidenceMedium);
  else reasons.push(t.evidenceWeak);

  if (evidence.sCount === 0) reasons.push(t.tip);

  reasons.push(
    mode === "pro"
      ? (lang === "en" ? "PRO mode: multi-query web search + contradiction checks." : "Mode PRO : recherche multi-angles + détection de contradictions.")
      : (lang === "en" ? "Standard mode: cautious output." : "Mode Standard : sortie prudente.")
  );

  return reasons.slice(0, 6);
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    message: "IA11 PRO is up",
    bypassEnabled: ALLOW_FRONTEND_BYPASS,
    allowedOrigins: ALLOWED_ORIGINS,
    hasSerper: Boolean(SERPER_API_KEY),
    hasApiKey: Boolean(API_KEY),
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    info: "POST /v1/analyze with {text, mode, uiLanguage} (and header x-ia11-key unless bypass enabled)",
  });
});

app.post("/v1/analyze", requireKey, rateLimit, async (req, res) => {
  const t0 = nowMs();
  const requestId = uid();

  const text = safeStr(req.body?.text, 6000);
  const mode = req.body?.mode === "pro" ? "pro" : "standard";
  const lang = detectUiLanguage(req.body?.uiLanguage);
  const t = pickT(lang);

  if (!text.trim()) {
    return res.status(400).json({
      status: "error",
      requestId,
      error: { message: t.missingText },
    });
  }

  console.log(`[IA11] req=${requestId} mode=${mode} lang=${lang} len=${text.trim().length}`);

  let rawSources = [];
  let sources = [];
  let searchOk = false;
  let searchError = null;
  let queriesUsed = [];

  try {
    const out = await serperMultiSearch(text, mode, lang);
    searchOk = out.ok;
    rawSources = out.items || [];
    searchError = out.error || null;
    queriesUsed = out.queries || [];
  } catch (e) {
    searchOk = false;
    searchError = e?.message || "Unknown search error";
  }

  sources = cleanSources(rawSources);
  const evidence = computeEvidence(sources);

  const contradiction = assessContradiction(text, sources, lang);

  const textLen = text.trim().length;
  const scored = scoreFromSignals(textLen, evidence, contradiction, mode);

  const breakdown = buildBreakdown(lang, evidence, textLen, contradiction);
  const summary = makeSummary(lang, mode, scored.score, scored.riskLevel, evidence.label, scored.outcome, evidence.sCount);
  const reasons = makeReasons(lang, mode, textLen, evidence, searchOk, searchError, contradiction);

  const tookMs = nowMs() - t0;

  const corroboration = {
    outcome:
      scored.outcome === "confirmed" ? t.outcomeConfirmed :
      scored.outcome === "contradicted" ? t.outcomeContradicted :
      t.outcomeUncertain,
    sourcesConsulted: evidence.sCount,
    sourceTypes: ["web"],
    summary:
      scored.outcome === "confirmed" ? t.confirmed :
      scored.outcome === "contradicted" ? t.contradicted :
      t.uncertain,
  };

  return res.json({
    status: "ok",
    requestId,
    engine: ENGINE,
    mode,
    result: {
      score: scored.score,
      riskLevel: scored.riskLevel,
      summary,
      reasons,
      confidence: scored.confidence,
      breakdown,
      corroboration,
      sources: sources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        domain: s.domain,
      })),
      bestLinks: sources.map((s) => ({ title: s.title, url: s.url })),
      debug: {
        queriesUsed,
        trustSum: evidence.trustSum,
        sourcesCount: evidence.sCount,
        evidence: evidence.label,
        contradictionDetected: Boolean(contradiction.detected),
        contradictionStrength: contradiction.strength || 0,
        support: contradiction.support ?? null,
        oppose: contradiction.oppose ?? null,
        note: contradiction.note || null,
      },
    },
    meta: {
      tookMs,
      version: VERSION,
      webSearchUsed: searchOk && sources.length > 0,
      bypassEnabled: ALLOW_FRONTEND_BYPASS,
    },
  });
});

// =====================
// Start
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[IA11 PRO] listening on :${port} | version ${VERSION}`);
});
