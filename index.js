/**
 * IA11 PRO — LeenScore Engine (single-file) — UI-compatible
 * - Web search via Serper (with caching + query shaping)
 * - Security gate: x-ia11-key (frontend bypass optional)
 * - Stronger output contract to match Lovable UI expectations:
 *   result.breakdown + result.corroboration + result.articleSummary
 * - Accepts payload variants:
 *   { text | content, mode | analysisType, uiLanguage | language }
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =====================
// Core config
// =====================
const VERSION = "2.1.0-pro-ui";
const ENGINE = "IA11";

const API_KEY = process.env.IA11_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

const ALLOW_FRONTEND_BYPASS =
  String(process.env.IA11_ALLOW_FRONTEND_BYPASS || "false").toLowerCase() === "true";

const ALLOWED_ORIGINS = (process.env.IA11_ALLOWED_ORIGINS || "lovable.app,leenscore.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 120);

const SERPER_NUM = Number(process.env.SERPER_NUM || 8);
const SERPER_GL = (process.env.SERPER_GL || "ca").toLowerCase();

const CACHE_TTL_MS = Number(process.env.IA11_CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const CACHE_MAX = Number(process.env.IA11_CACHE_MAX || 300);

const DEBUG_LOG = String(process.env.IA11_DEBUG_LOG || "false").toLowerCase() === "true";

// =====================
// Utilities
// =====================
function nowMs() {
  return Date.now();
}
function uid() {
  return crypto.randomBytes(12).toString("hex");
}
function safeStr(x, max = 2000) {
  return (x ?? "").toString().slice(0, max);
}

function detectUiLanguage(v) {
  const l = safeStr(v, 10).toLowerCase();
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
    searchTips: "Astuce : donne un fait précis + lieu + date pour une vérif béton.",
    articleSummaryTitle: "Résumé des sources",
    corroborationOk: "Le web fournit des sources cohérentes.",
    corroborationMixed: "Sources présentes, mais cohérence partielle.",
    corroborationWeak: "Peu de corroboration solide.",
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
    searchTips: "Tip: add a precise fact + place + date for a rock-solid check.",
    articleSummaryTitle: "Sources summary",
    corroborationOk: "Web sources look consistent.",
    corroborationMixed: "Sources exist, but only partially consistent.",
    corroborationWeak: "Weak corroboration.",
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
  const hay = `${origin} ${referer}`;
  return ALLOWED_ORIGINS.some((d) => d && hay.includes(d));
}

function requireKey(req, res, next) {
  if (req.method === "GET") return next();

  const key = safeStr(req.header("x-ia11-key"), 200);

  if (ALLOW_FRONTEND_BYPASS && isAllowedBrowser(req)) return next();

  const lang = detectUiLanguage(req.body?.uiLanguage ?? req.body?.language);
  const t = pickT(lang);

  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ status: "error", error: { message: t.unauthorized } });
  }
  next();
}

// =====================
// Rate limiter
// =====================
const buckets = new Map(); // key: ip|mode -> {count, resetAt}

function getClientIp(req) {
  const xff = safeStr(req.headers["x-forwarded-for"], 200);
  if (xff) return xff.split(",")[0].trim();
  return safeStr(req.socket?.remoteAddress, 80) || "unknown";
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);

  // Accept both "mode" and "analysisType"
  const mode =
    req.body?.mode === "pro" || req.body?.analysisType === "pro" ? "pro" : "standard";

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
  if (domain.includes("canada.ca") || domain.includes("who.int") || domain.includes("un.org"))
    return 3;
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
        snippet: safeStr(it?.snippet, 360).trim(),
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

function inferSourceTypes(sources) {
  const types = new Set();
  for (const s of sources) {
    const d = (s.domain || "").toLowerCase();
    if (!d) continue;
    if (d.endsWith(".gov") || d.includes("canada.ca") || d.endsWith(".gc.ca")) types.add("government");
    else if (d.endsWith(".edu")) types.add("education");
    else if (d.includes("who.int") || d.includes("un.org")) types.add("international");
    else if (d.includes("wikipedia.org")) types.add("encyclopedia");
    else if (d.includes("reuters.com") || d.includes("apnews.com") || d.includes("bbc.")) types.add("newswire");
    else types.add("web");
  }
  return Array.from(types).slice(0, 6);
}

// =====================
// Serper cache (in-memory)
// =====================
const cache = new Map(); // key -> {at, data}
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
// Query shaping (PRO)
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
    lower.includes(" is ") ||
    lower.includes(" president") ||
    lower.includes(" président") ||
    lower.includes(" ceo") ||
    lower.includes(" premier ministre") ||
    lower.includes(" prime minister");

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

  const lang = detectUiLanguage(uiLanguage);
  const hl = lang === "en" ? "en" : "fr";
  const gl = SERPER_GL;

  const cacheKey = `serper:${hl}:${gl}:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ok: true, items: cached, error: null, cached: true };

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
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
// Scoring
// =====================
function buildHeuristicScore(text, sources) {
  const len = text.trim().length;

  const sCount = sources.length;
  const trustSum = sources.reduce((a, s) => a + (s.trust || 0), 0);

  let score = 50;
  let confidence = 0.55;

  if (len < 40) {
    score -= 22;
    confidence -= 0.1;
  } else if (len < 90) {
    score -= 10;
    confidence -= 0.04;
  } else if (len > 220) {
    score += 6;
    confidence += 0.03;
  }

  if (sCount >= 6) {
    score += 14;
    confidence += 0.18;
  } else if (sCount >= 3) {
    score += 8;
    confidence += 0.12;
  } else if (sCount >= 1) {
    score += 3;
    confidence += 0.06;
  } else {
    score -= 12;
    confidence -= 0.18;
  }

  if (trustSum >= 6) {
    score += 10;
    confidence += 0.12;
  } else if (trustSum >= 3) {
    score += 6;
    confidence += 0.08;
  } else if (trustSum >= 1) {
    score += 2;
    confidence += 0.03;
  }

  score = Math.max(5, Math.min(98, Math.round(score)));
  confidence = Math.max(0.1, Math.min(0.98, Number(confidence.toFixed(2))));

  let riskLevel = "medium";
  if (score >= 80) riskLevel = "low";
  if (score <= 45) riskLevel = "high";

  let evidence = "weak";
  if (sCount >= 3 && trustSum >= 3) evidence = "medium";
  if (sCount >= 5 && trustSum >= 6) evidence = "strong";

  return { score, confidence, riskLevel, evidence, trustSum, sourcesCount: sCount, len };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function buildBreakdown(lang, scoring, searchOk, sources) {
  const t = pickT(lang);

  // points are "section scores" (0..20 each) used by UI panels
  const contextPoints =
    scoring.len < 40 ? 4 : scoring.len < 90 ? 9 : scoring.len < 220 ? 14 : 17;

  const sourcesPoints = clamp(
    Math.round((scoring.sourcesCount * 3) + (scoring.trustSum * 2)),
    0,
    20
  );

  const factualPoints = searchOk
    ? (scoring.evidence === "strong" ? 18 : scoring.evidence === "medium" ? 13 : 8)
    : 6;

  // "tone" here acts like prudence/caution quality
  const tonePoints =
    scoring.riskLevel === "high" ? 16 : scoring.riskLevel === "medium" ? 13 : 11;

  // transparency: do we show sources + explain limits?
  const transparencyPoints = clamp(
    (sources.length > 0 ? 12 : 6) + (searchOk ? 4 : 0),
    0,
    20
  );

  const sourcesReason =
    sources.length === 0
      ? t.noSources
      : `${t.foundSources(scoring.sourcesCount)} (${sources.slice(0, 3).map(s => s.domain).filter(Boolean).join(", ")})`;

  const factualReason =
    !searchOk
      ? `${t.webDown}`
      : scoring.evidence === "strong"
        ? t.evidenceStrong
        : scoring.evidence === "medium"
          ? t.evidenceMedium
          : t.evidenceWeak;

  const toneReason =
    scoring.riskLevel === "high"
      ? (lang === "en" ? "High-risk claim: be cautious and cross-check." : "Affirmation à risque élevé : prudence et recoupement.")
      : scoring.riskLevel === "medium"
        ? (lang === "en" ? "Some uncertainty: verify key details." : "Incertitude modérée : vérifie les détails clés.")
        : (lang === "en" ? "Lower risk: still verify dates and context." : "Risque plus faible : vérifie quand même dates et contexte.");

  const contextReason =
    scoring.len < 40 ? t.tooShort : t.enoughContext;

  const transparencyReason =
    sources.length > 0
      ? (lang === "en" ? "Sources provided + limitations stated." : "Sources fournies + limites expliquées.")
      : (lang === "en" ? "Few sources: transparency is limited." : "Peu de sources : transparence limitée.");

  return {
    sources: { points: sourcesPoints, reason: sourcesReason },
    factual: { points: factualPoints, reason: factualReason },
    tone: { points: tonePoints, reason: toneReason },
    context: { points: contextPoints, reason: contextReason },
    transparency: { points: transparencyPoints, reason: transparencyReason },
  };
}

function makeSummary(lang, mode, scoring) {
  const t = pickT(lang);
  const header = mode === "pro" ? t.proHeader : t.stdHeader;

  const evidenceLine =
    scoring.evidence === "strong" ? t.evidenceStrong :
    scoring.evidence === "medium" ? t.evidenceMedium :
    t.evidenceWeak;

  return [
    `${header} — Score: ${scoring.score}/100 — Risque: ${scoring.riskLevel.toUpperCase()}.`,
    evidenceLine,
    scoring.riskLevel === "high"
      ? (lang === "en"
          ? "This looks risky or under-sourced. Treat it as unverified until confirmed."
          : "Ça semble risqué ou sous-sourcé. Considère ça comme non confirmé tant que c’est pas recoupé.")
      : (lang === "en"
          ? "Good signals overall, but still cross-check critical facts."
          : "Bons signaux globalement, mais recoupe les faits critiques."),
    t.verifyDates,
  ].join(" ");
}

function buildArticleSummary(lang, text, sources) {
  const t = pickT(lang);
  if (!sources || sources.length === 0) {
    return lang === "en"
      ? "No strong sources were found to summarize."
      : "Aucune source solide à résumer.";
  }

  // lightweight “human-ish” synthesis from snippets (no LLM)
  const top = sources.slice(0, 4);
  const snippetBits = top
    .map((s) => safeStr(s.snippet, 220).trim())
    .filter(Boolean);

  const joined = snippetBits.join(" ");
  const compact = joined.replace(/\s+/g, " ").trim().slice(0, 520);

  return `${t.articleSummaryTitle}: ${compact}${compact.endsWith(".") ? "" : "."}`;
}

function makeReasons(lang, mode, scoring, sources, searchOk, searchError) {
  const t = pickT(lang);
  const reasons = [];

  if (scoring.len < 40) reasons.push(t.tooShort);
  else reasons.push(t.enoughContext);

  if (!searchOk) {
    reasons.unshift(`${t.webDown}: ${searchError || "unknown"}`);
  } else if (sources.length === 0) {
    reasons.push(t.noSources);
    reasons.push(t.searchTips);
  } else {
    if (scoring.evidence === "strong") reasons.push(t.evidenceStrong);
    else if (scoring.evidence === "medium") reasons.push(t.evidenceMedium);
    else reasons.push(t.evidenceWeak);

    const topDomains = sources.slice(0, 5).map((s) => s.domain).filter(Boolean);
    if (topDomains.length) {
      reasons.push((lang === "en" ? "Top domains: " : "Domaines principaux : ") + topDomains.join(", "));
    }
  }

  reasons.push(
    mode === "pro"
      ? (lang === "en" ? "PRO mode: multi-query search + structured breakdown." : "Mode PRO : recherche multi-angles + breakdown structuré.")
      : (lang === "en" ? "Standard mode: short and cautious output." : "Mode Standard : sortie courte et prudente.")
  );

  return reasons.slice(0, 6);
}

function buildCorroboration(lang, scoring, sources, searchOk) {
  const t = pickT(lang);
  const sourceTypes = inferSourceTypes(sources);

  let outcome = "mixed";
  if (!searchOk || sources.length === 0) outcome = "weak";
  else if (scoring.evidence === "strong") outcome = "strong";
  else if (scoring.evidence === "medium") outcome = "mixed";
  else outcome = "weak";

  const summary =
    outcome === "strong"
      ? t.corroborationOk
      : outcome === "mixed"
        ? t.corroborationMixed
        : t.corroborationWeak;

  return {
    outcome,
    sourcesConsulted: sources.length,
    sourceTypes,
    summary,
  };
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
    debugLog: DEBUG_LOG,
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    info:
      "POST /v1/analyze with {text|content, mode|analysisType, uiLanguage|language} and header x-ia11-key",
  });
});

app.post("/v1/analyze", requireKey, rateLimit, async (req, res) => {
  const t0 = nowMs();
  const requestId = uid();

  // Accept payload variants
  const text = safeStr(req.body?.text ?? req.body?.content ?? "", 6000);

  // Accept both mode and analysisType
  const mode =
    req.body?.mode === "pro" || req.body?.analysisType === "pro" ? "pro" : "standard";

  const lang = detectUiLanguage(req.body?.uiLanguage ?? req.body?.language);
  const t = pickT(lang);

  if (!text.trim()) {
    return res.status(400).json({
      status: "error",
      requestId,
      error: { message: t.missingText },
    });
  }

  if (DEBUG_LOG) {
    console.log(`[IA11] req=${requestId} mode=${mode} lang=${lang} len=${text.trim().length}`);
  }

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

  const scoring = buildHeuristicScore(text, sources);
  const breakdown = buildBreakdown(lang, scoring, searchOk, sources);
  const summary = makeSummary(lang, mode, scoring);
  const articleSummary = buildArticleSummary(lang, text, sources);
  const reasons = makeReasons(lang, mode, scoring, sources, searchOk, searchError);
  const corroboration = buildCorroboration(lang, scoring, sources, searchOk);

  const tookMs = nowMs() - t0;

  if (DEBUG_LOG) {
    console.log(
      `[IA11] done req=${requestId} score=${scoring.score} risk=${scoring.riskLevel} sources=${sources.length} ms=${tookMs}`
    );
  }

  return res.json({
    status: "ok",
    requestId,
    engine: ENGINE,
    mode,
    // UI-friendly PRO contract lives inside result (your normalizeAnalysisData uses raw.result)
    result: {
      score: scoring.score,
      riskLevel: scoring.riskLevel,
      analysisType: mode === "pro" ? "pro" : "standard",
      breakdown,
      summary,
      articleSummary,
      reasons,
      confidence: scoring.confidence,
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
        trustSum: scoring.trustSum,
        sourcesCount: scoring.sourcesCount,
        searchOk,
      },
    },
    meta: {
      tookMs,
      version: VERSION,
      webSearchUsed: searchOk && sources.length > 0,
      bypassEnabled: ALLOW_FRONTEND_BYPASS,
      debugLog: DEBUG_LOG,
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
