/**
 * IA11 PRO — LeenScore Engine (single-file)
 * - Web search via Serper (with caching + query shaping)
 * - Safer gatekeeping (configurable frontend bypass)
 * - Stronger scoring (evidence strength, domain trust hints, freshness hints)
 * - Outputs in uiLanguage (fr/en supported; fallback fr)
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
const VERSION = "2.0.0-pro";
const ENGINE = "IA11";

const API_KEY = process.env.IA11_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

// If you REALLY need to allow Lovable without a secret header (not secure),
// set IA11_ALLOW_FRONTEND_BYPASS=true.
// Best practice: keep it FALSE and call IA11 through your server/edge function.
const ALLOW_FRONTEND_BYPASS = String(process.env.IA11_ALLOW_FRONTEND_BYPASS || "false").toLowerCase() === "true";

// Optional: strict allowlist for browser origins when bypass is enabled
const ALLOWED_ORIGINS = (process.env.IA11_ALLOWED_ORIGINS || "lovable.app,leenscore.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Rate limits
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 120);

// Serper settings
const SERPER_NUM = Number(process.env.SERPER_NUM || 8);
const SERPER_GL = (process.env.SERPER_GL || "ca").toLowerCase();

// Cache (saves Serper credits)
const CACHE_TTL_MS = Number(process.env.IA11_CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const CACHE_MAX = Number(process.env.IA11_CACHE_MAX || 300);

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
    searchTips: "Astuce : donne un fait précis + lieu + date pour une vérif béton.",
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
  // Health & info endpoints are public
  if (req.method === "GET") return next();

  const key = safeStr(req.header("x-ia11-key"), 200);

  // If bypass enabled, allow only if request looks like it comes from your frontend domains.
  // WARNING: headers can be spoofed by attackers using curl. Keep bypass OFF for real security.
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
const buckets = new Map(); // key: ip|mode -> {count, resetAt}

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
  // Simple heuristic: this does NOT "guarantee truth", it just nudges confidence.
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
        snippet: safeStr(it?.snippet, 360).trim(),
        domain,
        trust: domainTrust(domain),
      };
    })
    .filter((it) => isValidHttpUrl(it.url));

  // de-dup by url
  const seen = new Set();
  const uniq = [];
  for (const s of cleaned) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    uniq.push(s);
  }

  // prefer higher trust sources at the top (stable UI experience)
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
  // crude eviction
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

// =====================
// Query shaping (PRO)
// =====================
function normalizeQuery(text) {
  // Keep it short + stable for search
  const t = safeStr(text, 2000).replace(/\s+/g, " ").trim();
  // remove super long punctuation runs
  return t.replace(/[^\S\r\n]+/g, " ").slice(0, 260);
}

function buildQueries(text, mode, lang) {
  const base = normalizeQuery(text);
  if (!base) return [];

  // PRO: multiple angles to reduce “one bad query” failures
  if (mode !== "pro") return [base];

  // If it looks like a question/claim about "who/what/when", add an explicit "fact check" angle.
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
  const q2 = looksLikeClaim ? (base + factCheck) : (base + yearHint);
  const q3 = looksLikeClaim ? (base + yearHint) : (base + factCheck);

  // Unique, non-empty
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
    body: JSON.stringify({
      q: query,
      num: SERPER_NUM,
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
// Scoring (PRO)
/// - still heuristic (no hallucination engine here)
/// - score is "credibility signal" based on context + evidence strength
// =====================
function buildHeuristicScore(text, sources) {
  const len = text.trim().length;

  // Evidence strength
  const sCount = sources.length;
  const trustSum = sources.reduce((a, s) => a + (s.trust || 0), 0);

  let score = 50;
  let confidence = 0.55;

  // Context weight
  if (len < 40) {
    score -= 22;
    confidence -= 0.10;
  } else if (len < 90) {
    score -= 10;
    confidence -= 0.04;
  } else if (len > 220) {
    score += 6;
    confidence += 0.03;
  }

  // Sources count weight
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

  // Trust weight
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

  // Clamp
  score = Math.max(5, Math.min(98, Math.round(score)));
  confidence = Math.max(0.1, Math.min(0.98, Number(confidence.toFixed(2))));

  // Risk level
  let riskLevel = "medium";
  if (score >= 80) riskLevel = "low";
  if (score <= 45) riskLevel = "high";

  // Evidence label for reasons
  let evidence = "weak";
  if (sCount >= 3 && trustSum >= 3) evidence = "medium";
  if (sCount >= 5 && trustSum >= 6) evidence = "strong";

  return { score, confidence, riskLevel, evidence, trustSum, sourcesCount: sCount };
}

function makeSummary(lang, mode, score, riskLevel, sourcesCount, evidence) {
  const t = pickT(lang);

  // “WOW” but still safe: short, punchy, not pretending certainty.
  const header = mode === "pro" ? t.proHeader : t.stdHeader;

  const evidenceLine =
    evidence === "strong" ? t.evidenceStrong :
    evidence === "medium" ? t.evidenceMedium :
    t.evidenceWeak;

  const sourcesLine = sourcesCount > 0 ? t.foundSources(sourcesCount) : t.noSources;

  // 5–7 lines vibe: keep it compact
  return [
    `${header} — Score: ${score}/100 — Risque: ${riskLevel.toUpperCase()}.`,
    sourcesLine,
    evidenceLine,
    `${t.conclusion}: si c’est un fait “sensible” (politique, santé, argent), recoupe 2 sources crédibles minimum.`,
    t.verifyDates,
  ].join(" ");
}

function makeReasons(lang, mode, text, sources, searchOk, searchError, evidence) {
  const t = pickT(lang);
  const reasons = [];

  const len = text.trim().length;
  if (len < 40) reasons.push(t.tooShort);
  else reasons.push(t.enoughContext);

  if (!searchOk) {
    reasons.unshift(`${t.webDown}: ${searchError || "unknown"}`);
  } else if (sources.length === 0) {
    reasons.push(t.noSources);
    reasons.push(t.searchTips);
  } else {
    if (evidence === "strong") reasons.push(t.evidenceStrong);
    else if (evidence === "medium") reasons.push(t.evidenceMedium);
    else reasons.push(t.evidenceWeak);

    // a tiny nudge about trust domains without being “too nerd”
    const topDomains = sources
      .slice(0, 5)
      .map((s) => s.domain)
      .filter(Boolean);

    if (topDomains.length) {
      reasons.push(
        (lang === "en" ? "Top domains: " : "Domaines principaux : ") + topDomains.join(", ")
      );
    }
  }

  if (mode === "pro") reasons.push(lang === "en" ? "PRO mode: multi-query search + richer output." : "Mode PRO : recherche multi-angles + sortie plus riche.");
  else reasons.push(lang === "en" ? "Standard mode: short and cautious output." : "Mode Standard : sortie courte et prudente.");

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
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    info: "POST /v1/analyze with {text, mode, uiLanguage} and header x-ia11-key",
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
  const summary = makeSummary(lang, mode, scoring.score, scoring.riskLevel, scoring.sourcesCount, scoring.evidence);
  const reasons = makeReasons(lang, mode, text, sources, searchOk, searchError, scoring.evidence);

  const tookMs = nowMs() - t0;

  return res.json({
    status: "ok",
    requestId,
    engine: ENGINE,
    mode,
    result: {
      score: scoring.score,
      riskLevel: scoring.riskLevel,
      summary,
      reasons,
      confidence: scoring.confidence,
      sources: sources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        domain: s.domain,
      })),
      bestLinks: sources.map((s) => ({ title: s.title, url: s.url })),
      debug: {
        // Keep this lightweight; helpful for you when testing
        queriesUsed,
        trustSum: scoring.trustSum,
        sourcesCount: scoring.sourcesCount,
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
