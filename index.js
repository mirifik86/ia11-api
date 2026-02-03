/**
 * IA11 PRO — LeenScore Engine (single-file) — Credible v3.0
 * - Serper web search (multi-query, caching, query shaping)
 * - Evidence-based verdict: confirmed / contradicted / uncertain
 * - Stronger scoring (penalize contradictions hard)
 * - Returns fields that LeenScore UI expects: score, riskLevel, summary, reasons, confidence, sources, bestLinks, breakdown, corroboration, verdict
 * - Logs every request (Render visibility)
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
const VERSION = "3.0.0-pro-credible";
const ENGINE = "IA11";

const API_KEY = process.env.IA11_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

const ALLOW_FRONTEND_BYPASS = String(process.env.IA11_ALLOW_FRONTEND_BYPASS || "false").toLowerCase() === "true";
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
// Utilities
// =====================
function nowMs() { return Date.now(); }
function uid() { return crypto.randomBytes(12).toString("hex"); }
function safeStr(x, max = 2000) { return (x ?? "").toString().slice(0, max); }

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
    evidenceStrong: "Preuves solides (sources crédibles + cohérence).",
    evidenceMedium: "Preuves modérées (sources présentes, recoupe nécessaire).",
    evidenceWeak: "Preuves faibles (peu de sources ou sources fragiles).",
    contradicted: "CONTREDIT par les sources consultées.",
    confirmed: "CONFIRMÉ par les sources consultées.",
    uncertain: "INCERTAIN : pas assez de preuve externe claire.",
    searchTips: "Astuce : donne un fait précis + lieu + date pour une vérif béton.",
    proNote: "Mode PRO : multi-recherche + verdict (confirmé/incertain/contredit).",
    stdNote: "Mode Standard : sortie courte et prudente.",
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
    evidenceStrong: "Strong evidence (credible sources + consistency).",
    evidenceMedium: "Moderate evidence (sources exist, cross-check needed).",
    evidenceWeak: "Weak evidence (few sources or fragile sources).",
    contradicted: "CONTRADICTED by consulted sources.",
    confirmed: "CONFIRMED by consulted sources.",
    uncertain: "UNCERTAIN: not enough clear external evidence.",
    searchTips: "Tip: add a precise fact + place + date for a rock-solid check.",
    proNote: "PRO mode: multi-query search + verdict (confirmed/uncertain/contradicted).",
    stdNote: "Standard mode: short and cautious output.",
  },
};

function tPick(lang) { return I18N[lang] || I18N.fr; }

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

  if (!API_KEY || key !== API_KEY) {
    const lang = detectUiLanguage(req.body?.uiLanguage);
    const t = tPick(lang);
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
  const mode = req.body?.mode === "pro" || req.body?.analysisType === "pro" ? "pro" : "standard";
  const limit = mode === "pro" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const k = `${ip}|${mode}`;
  const time = nowMs();
  let b = buckets.get(k);

  if (!b || time > b.resetAt) {
    b = { count: 0, resetAt: time + 60_000 };
    buckets.set(k, b);
  }
  b.count += 1;

  if (b.count > limit) {
    const retry = Math.max(1, Math.ceil((b.resetAt - time) / 1000));
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
  if (domain.includes("who.int") || domain.includes("un.org") || domain.includes("canada.ca")) return 3;
  if (domain.includes("reuters.com") || domain.includes("apnews.com")) return 2;
  if (domain.includes("bbc.co.uk") || domain.includes("bbc.com")) return 2;
  if (domain.includes("wikipedia.org")) return 1;
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

  uniq.sort((a, b) => (b.trust - a.trust));
  return uniq.slice(0, 8);
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
    lower.includes(" is ") ||
    lower.includes(" président") ||
    lower.includes(" president") ||
    lower.includes(" capitale") ||
    lower.includes(" capital") ||
    lower.includes(" ville") ||
    lower.includes(" city") ||
    lower.includes(" pays") ||
    lower.includes(" country");

  const factCheck = lang === "en" ? " fact check" : " vérification";
  const define = lang === "en" ? " is a country or city" : " est un pays ou une ville";
  const currentYear = new Date().getFullYear();
  const yearHint = ` ${currentYear}`;

  const q1 = base;
  const q2 = looksLikeClaim ? (base + factCheck) : (base + yearHint);
  const q3 = looksLikeClaim ? (base + define) : (base + factCheck);

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
    error: okCount > 0 ? null : (lastError || "Unknown search error"),
    queries,
  };
}

// =====================
// Evidence-based verdict (confirmed / contradicted / uncertain)
// =====================

// Light claim parsing for common patterns (FR/EN)
function extractClaimShape(text) {
  const s = normalizeQuery(text);
  const lower = s.toLowerCase();

  // FR: "X est une ville de Y" / "X est un pays" / "X est la capitale de Y"
  let m = lower.match(/^(.+?)\s+est\s+une\s+ville\s+de\s+(.+?)\.?$/i);
  if (m) return { type: "is_city_of", a: m[1].trim(), b: m[2].trim(), lang: "fr" };

  m = lower.match(/^(.+?)\s+est\s+la\s+capitale\s+de\s+(.+?)\.?$/i);
  if (m) return { type: "is_capital_of", a: m[1].trim(), b: m[2].trim(), lang: "fr" };

  m = lower.match(/^(.+?)\s+est\s+un\s+pays\.?$/i);
  if (m) return { type: "is_country", a: m[1].trim(), b: null, lang: "fr" };

  // EN: "X is a city of Y" / "X is the capital of Y" / "X is a country"
  m = lower.match(/^(.+?)\s+is\s+a\s+city\s+of\s+(.+?)\.?$/i);
  if (m) return { type: "is_city_of", a: m[1].trim(), b: m[2].trim(), lang: "en" };

  m = lower.match(/^(.+?)\s+is\s+the\s+capital\s+of\s+(.+?)\.?$/i);
  if (m) return { type: "is_capital_of", a: m[1].trim(), b: m[2].trim(), lang: "en" };

  m = lower.match(/^(.+?)\s+is\s+a\s+country\.?$/i);
  if (m) return { type: "is_country", a: m[1].trim(), b: null, lang: "en" };

  return { type: "generic", a: null, b: null, lang: null };
}

function snippetContainsAll(snippet, words) {
  const s = (snippet || "").toLowerCase();
  return words.every((w) => w && s.includes(w.toLowerCase()));
}

function evidenceScan(text, sources, lang) {
  const claim = extractClaimShape(text);
  const combined = sources.map((x) => `${x.title} ${x.snippet}`.toLowerCase());

  // Evidence counters
  let confirmHits = 0;
  let contradictHits = 0;

  // Higher trust = higher weight
  function weight(src) { return 1 + (src.trust || 0) * 0.6; }

  let confirmWeight = 0;
  let contradictWeight = 0;

  // Generic helpers
  const A = (claim.a || "").toLowerCase();
  const B = (claim.b || "").toLowerCase();

  // If we can parse a claim, we try to confirm/contradict it from snippets
  if (claim.type !== "generic" && A) {
    for (const src of sources) {
      const blob = `${src.title} ${src.snippet}`.toLowerCase();

      if (claim.type === "is_city_of" && B) {
        // Confirm patterns: "A is a city in B" OR "A, a city in B"
        const confirmPatterns = lang === "en"
          ? [[A, "city", B], [A, "city in", B]]
          : [[A, "ville", B], [A, "ville de", B], [A, "ville en", B]];

        const contradictPatterns = lang === "en"
          ? [[A, "country"], [A, "sovereign state"], [A, "nation"]]
          : [[A, "pays"], [A, "état"], [A, "nation"]];

        const cOk = confirmPatterns.some((w) => snippetContainsAll(blob, w));
        const xOk = contradictPatterns.some((w) => snippetContainsAll(blob, w));

        if (cOk) { confirmHits += 1; confirmWeight += weight(src); }
        if (xOk) { contradictHits += 1; contradictWeight += weight(src); }
      }

      if (claim.type === "is_country") {
        const confirmPatterns = lang === "en"
          ? [[A, "country"], [A, "sovereign state"], [A, "nation"]]
          : [[A, "pays"], [A, "état"], [A, "nation"]];

        const contradictPatterns = lang === "en"
          ? [[A, "city"], [A, "town"], [A, "village"]]
          : [[A, "ville"], [A, "municipalité"], [A, "village"]];

        const cOk = confirmPatterns.some((w) => snippetContainsAll(blob, w));
        const xOk = contradictPatterns.some((w) => snippetContainsAll(blob, w));

        if (cOk) { confirmHits += 1; confirmWeight += weight(src); }
        if (xOk) { contradictHits += 1; contradictWeight += weight(src); }
      }

      if (claim.type === "is_capital_of" && B) {
        const confirmPatterns = lang === "en"
          ? [[A, "capital", B]]
          : [[A, "capitale", B]];

        const cOk = confirmPatterns.some((w) => snippetContainsAll(blob, w));
        if (cOk) { confirmHits += 1; confirmWeight += weight(src); }
      }
    }
  }

  // Verdict decision
  // Contradiction wins if it has decent weight and beats confirmation.
  let verdict = "uncertain";
  if (contradictWeight >= 2.2 && contradictWeight > confirmWeight * 1.15) verdict = "contradicted";
  else if (confirmWeight >= 2.2 && confirmWeight > contradictWeight * 1.15) verdict = "confirmed";
  else verdict = "uncertain";

  return {
    verdict,
    claim,
    confirmHits,
    contradictHits,
    confirmWeight: Number(confirmWeight.toFixed(2)),
    contradictWeight: Number(contradictWeight.toFixed(2)),
  };
}

// =====================
// Scoring (credible)
// =====================
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function buildScore(text, sources, scan, mode) {
  const len = text.trim().length;
  const sCount = sources.length;
  const trustSum = sources.reduce((a, s) => a + (s.trust || 0), 0);

  // Base score depends on verdict
  let scoreBase = 55; // neutral
  if (scan.verdict === "confirmed") scoreBase = 78;
  if (scan.verdict === "contradicted") scoreBase = 22;

  // Context influence
  let ctxBonus = 0;
  if (len < 40) ctxBonus -= 12;
  else if (len < 90) ctxBonus -= 6;
  else if (len > 220) ctxBonus += 6;

  // Evidence influence
  let evBonus = 0;
  if (sCount >= 6) evBonus += 10;
  else if (sCount >= 3) evBonus += 6;
  else if (sCount >= 1) evBonus += 2;
  else evBonus -= 10;

  // Trust influence
  let trBonus = 0;
  if (trustSum >= 6) trBonus += 8;
  else if (trustSum >= 3) trBonus += 4;
  else if (trustSum >= 1) trBonus += 1;

  // PRO has slightly wider spread
  const proSpread = mode === "pro" ? 1.15 : 1.0;

  let score = Math.round((scoreBase + ctxBonus + evBonus + trBonus) * proSpread);

  // Hard rules: contradiction should not be "moderate"
  if (scan.verdict === "contradicted") score = clamp(score, 5, 35);
  if (scan.verdict === "confirmed") score = clamp(score, 65, 98);

  // General clamp
  score = clamp(score, 5, 98);

  // Confidence 0..1
  let confidence = 0.55;
  if (scan.verdict === "confirmed") confidence = 0.82;
  if (scan.verdict === "contradicted") confidence = 0.80;
  if (scan.verdict === "uncertain") confidence = 0.48;

  // Confidence rises with trust + count
  confidence += Math.min(0.12, (trustSum * 0.02));
  confidence += Math.min(0.10, (Math.max(0, sCount - 1) * 0.02));
  if (len < 40) confidence -= 0.08;

  confidence = clamp(Number(confidence.toFixed(2)), 0.15, 0.98);

  // Risk
  let riskLevel = "medium";
  if (score >= 80) riskLevel = "low";
  if (score <= 45) riskLevel = "high";

  // Evidence label
  let evidence = "weak";
  if (sCount >= 3 && trustSum >= 3) evidence = "medium";
  if (sCount >= 5 && trustSum >= 6) evidence = "strong";

  // Breakdown points (0..20 each)
  // (Simple but useful for UI)
  const breakdown = {
    sources: {
      points: clamp(Math.round((sCount / 8) * 20), 0, 20),
      reason: `Sources: ${sCount}/8`,
    },
    factual: {
      points: scan.verdict === "confirmed" ? 18 : scan.verdict === "contradicted" ? 4 : 10,
      reason: `Verdict: ${scan.verdict}`,
    },
    tone: {
      points: 12,
      reason: "Style: prudent (no certainty without proof).",
    },
    context: {
      points: clamp(len < 40 ? 6 : len < 90 ? 10 : len < 220 ? 14 : 17, 0, 20),
      reason: `Length: ${len} chars`,
    },
    transparency: {
      points: clamp(Math.round((Math.min(8, sCount) / 8) * 20), 0, 20),
      reason: "Links provided for verification.",
    },
  };

  // Corroboration object (UI-friendly)
  const corroboration = {
    outcome: scan.verdict,
    sourcesConsulted: sCount,
    sourceTypes: Array.from(new Set(sources.map((s) => {
      const d = s.domain || "";
      if (d.endsWith(".gov") || d.endsWith(".gc.ca")) return "government";
      if (d.endsWith(".edu")) return "education";
      if (d.includes("wikipedia.org")) return "reference";
      if (s.trust >= 2) return "major-media";
      return "web";
    }))),
    summary: `confirmWeight=${scan.confirmWeight}, contradictWeight=${scan.contradictWeight}`,
  };

  return { score, confidence, riskLevel, evidence, trustSum, sourcesCount: sCount, breakdown, corroboration };
}

// =====================
// Summary + reasons + verdict block
// =====================
function makeSummary(lang, mode, scoring, scan, sourcesCount) {
  const t = tPick(lang);
  const header = mode === "pro" ? t.proHeader : t.stdHeader;

  const evidenceLine =
    scoring.evidence === "strong" ? t.evidenceStrong :
    scoring.evidence === "medium" ? t.evidenceMedium :
    t.evidenceWeak;

  const sourcesLine = sourcesCount > 0 ? t.foundSources(sourcesCount) : t.noSources;

  const verdictLine =
    scan.verdict === "confirmed" ? t.confirmed :
    scan.verdict === "contradicted" ? t.contradicted :
    t.uncertain;

  return [
    `${header} — Score: ${scoring.score}/100 — Risque: ${scoring.riskLevel.toUpperCase()}.`,
    verdictLine,
    sourcesLine,
    evidenceLine,
    `${t.conclusion}: si c’est un fait “sensible” (politique, santé, argent), recoupe 2 sources crédibles minimum.`,
    t.verifyDates,
  ].join(" ");
}

function makeReasons(lang, mode, text, sources, searchOk, searchError, scoring, scan) {
  const t = tPick(lang);
  const reasons = [];

  const len = text.trim().length;
  if (len < 40) reasons.push(t.tooShort);
  else reasons.push(t.enoughContext);

  if (!searchOk) {
    reasons.unshift(`${t.webDown}: ${searchError || "unknown"}`);
    reasons.push(t.searchTips);
  } else if (sources.length === 0) {
    reasons.push(t.noSources);
    reasons.push(t.searchTips);
  } else {
    if (scan.verdict === "contradicted") reasons.push(t.contradicted);
    if (scan.verdict === "confirmed") reasons.push(t.confirmed);
    if (scan.verdict === "uncertain") reasons.push(t.uncertain);

    if (scoring.evidence === "strong") reasons.push(t.evidenceStrong);
    else if (scoring.evidence === "medium") reasons.push(t.evidenceMedium);
    else reasons.push(t.evidenceWeak);

    const topDomains = sources.slice(0, 5).map((s) => s.domain).filter(Boolean);
    if (topDomains.length) {
      reasons.push((lang === "en" ? "Top domains: " : "Domaines principaux : ") + topDomains.join(", "));
    }
  }

  reasons.push(mode === "pro" ? t.proNote : t.stdNote);
  return reasons.slice(0, 6);
}

function buildVerdictBlock(scan) {
  // UI can map these to “Confirmé / Incertain / Contredit”
  const out = {
    confirmed: [],
    uncertain: [],
    contradicted: [],
  };

  const claim = scan.claim?.type && scan.claim.type !== "generic"
    ? `${scan.claim.a}${scan.claim.b ? " -> " + scan.claim.b : ""} (${scan.claim.type})`
    : "generic";

  if (scan.verdict === "confirmed") out.confirmed.push(claim);
  else if (scan.verdict === "contradicted") out.contradicted.push(claim);
  else out.uncertain.push(claim);

  return out;
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    message: "IA11 PRO credible is up",
    bypassEnabled: ALLOW_FRONTEND_BYPASS,
    allowedOrigins: ALLOWED_ORIGINS,
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    info: "POST /v1/analyze with {text|content, mode|analysisType, uiLanguage} and header x-ia11-key",
  });
});

app.post("/v1/analyze", requireKey, rateLimit, async (req, res) => {
  const t0 = nowMs();
  const requestId = uid();

  // Accept multiple frontend shapes
  const text = safeStr(req.body?.text ?? req.body?.content ?? "", 6000);
  const mode = (req.body?.mode === "pro" || req.body?.analysisType === "pro") ? "pro" : "standard";
  const lang = detectUiLanguage(req.body?.uiLanguage);

  const t = tPick(lang);

  if (!text.trim()) {
    return res.status(400).json({
      status: "error",
      requestId,
      error: { message: t.missingText },
    });
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

  // Evidence scan + credible scoring
  const scan = evidenceScan(text, sources, lang);
  const scoring = buildScore(text, sources, scan, mode);

  const summary = makeSummary(lang, mode, scoring, scan, scoring.sourcesCount);
  const reasons = makeReasons(lang, mode, text, sources, searchOk, searchError, scoring, scan);

  const tookMs = nowMs() - t0;

  // Render logs (the thing you were missing)
  console.log(
    `[IA11] requestId=${requestId} mode=${mode} lang=${lang} score=${scoring.score} verdict=${scan.verdict} sources=${scoring.sourcesCount} trustSum=${scoring.trustSum} tookMs=${tookMs} queries=${JSON.stringify(queriesUsed)}`
  );

  return res.json({
    status: "ok",
    requestId,
    engine: ENGINE,
    mode,
    analysisType: mode === "pro" ? "pro" : "standard", // UI-friendly
    result: {
      score: scoring.score,
      riskLevel: scoring.riskLevel,
      summary,
      reasons,
      confidence: scoring.confidence,

      // UI needs these
      breakdown: scoring.breakdown,
      corroboration: scoring.corroboration,
      verdict: buildVerdictBlock(scan),

      // Sources + links
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
        confirmWeight: scan.confirmWeight,
        contradictWeight: scan.contradictWeight,
        confirmHits: scan.confirmHits,
        contradictHits: scan.contradictHits,
        claim: scan.claim,
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
