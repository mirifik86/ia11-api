/**
 * IA11 API (LeenScore) — index.js (Ultra PRO, "living" analysis)
 *
 * Promise:
 * - Same v1 response contract (stable for LeenScore)
 * - Much smarter scoring (multi-signal + claim extraction)
 * - PRO can optionally corroborate claims with real web sources (Bing v7)
 * - If external search is OFF, IA11 stays conservative (never “declares” facts)
 * - Output language matches detected language
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// fetch() for Node (Render can run different Node versions)
// - Uses native fetch when available (Node 18+)
// - Falls back to dynamic node-fetch import when needed
const fetch = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/* -------------------------------
   Config
-------------------------------- */
const app = express();
const PORT = process.env.PORT || 3000;

const ENGINE_NAME = "IA11";
const VERSION = "2.2.1";

const IA11_API_KEY = (process.env.IA11_API_KEY || "").trim();

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 6000);
const JSON_LIMIT = process.env.JSON_LIMIT || "1mb";

// CORS allowlist (comma-separated). If empty => allow all.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Cache
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS || 600);

// Optional shared storage (recommended when you scale to multiple instances)
// If not set, IA11 falls back to in-memory cache/rate-limit (works fine for early stage)
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

// Rate limits (per minute)
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 12);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

// External web verification (PRO only)
const WEB_PROVIDER = String(process.env.WEB_PROVIDER || "").trim().toLowerCase(); // "bing"
const BING_API_KEY = (process.env.BING_API_KEY || "").trim(); // Azure Bing Search v7
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 7000);
const WEB_MAX_RESULTS = Number(process.env.WEB_MAX_RESULTS || 6);

// “Living” behavior tuning (safe defaults)
const MAX_CLAIMS = Number(process.env.MAX_CLAIMS || 3);
const MIN_CLAIM_CHARS = Number(process.env.MIN_CLAIM_CHARS || 14);
const NOW_YEAR = Number(process.env.NOW_YEAR || new Date().getUTCFullYear());

/* -------------------------------
   Middleware
-------------------------------- */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!CORS_ORIGINS.length) return cb(null, true);
      return cb(null, CORS_ORIGINS.includes(origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: JSON_LIMIT }));

app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "IA11");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* -------------------------------
   Health / Info
-------------------------------- */
app.get("/", (req, res) => {
  res.json({ status: "ok", engine: ENGINE_NAME, version: VERSION });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: VERSION,
    contract: "v1",
    endpoints: { post: "/v1/analyze" },
  });
});

/* -------------------------------
   POST /v1/analyze
-------------------------------- */
app.post("/v1/analyze", async (req, res) => {
  const t0 = nowMs();
  const requestId = makeId();

  // Auth
  const key = String(req.headers["x-ia11-key"] || "").trim();
  if (!IA11_API_KEY || key !== IA11_API_KEY) {
    return res.status(401).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: "standard",
      error: "Unauthorized",
      meta: { tookMs: nowMs() - t0, version: VERSION },
    });
  }

  // Input
  const rawText = req.body?.text;
  const text = safeTrimText(rawText || "");
  const mode = String(req.body?.mode || "standard").toLowerCase();
  const isPro = isProbablyProMode(mode);

  // Rate limit
  const rl = await rateLimitCheck(req, isPro);
  res.setHeader("X-RateLimit-Limit", String(rl.limit));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetMs / 1000)));

  if (!rl.ok) {
    return res.status(429).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: isPro ? "pro" : "standard",
      error: "Rate limit exceeded",
      meta: {
        tookMs: nowMs() - t0,
        version: VERSION,
        retryAfterSeconds: Math.max(1, Math.ceil((rl.resetMs - nowMs()) / 1000)),
      },
    });
  }

  if (!text) {
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      error: "Missing 'text' in request body",
      meta: { tookMs: nowMs() - t0, version: VERSION },
    });
  }

  if (text.length > MAX_TEXT_CHARS) {
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      error: `Text too long (max ${MAX_TEXT_CHARS} chars)`,
      meta: { tookMs: nowMs() - t0, version: VERSION },
    });
  }

  const lang = detectLangVerySimple(text);

  // Cache (lang + mode included because output text changes)
  const cacheKey = `${isPro ? "pro" : "standard"}::${lang}::${text}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return res.json({
      ...cached,
      requestId,
      meta: { ...(cached.meta || {}), tookMs: nowMs() - t0, version: VERSION, cached: true },
    });
  }

  // Analyze
  const externalSearchEnabled = isPro && isExternalSearchEnabled();
  const provider = externalSearchEnabled ? WEB_PROVIDER : "";

  const result = isPro
    ? await analyzePro(text, lang, { externalSearchEnabled, provider })
    : await analyzeStandard(text, lang);

  const response = {
    status: "ok",
    requestId,
    engine: ENGINE_NAME,
    mode: isPro ? "pro" : "standard",
    result,
    meta: {
      tookMs: nowMs() - t0,
      version: VERSION,
      externalSearchEnabled: !!externalSearchEnabled,
      provider: provider || undefined,
      cached: false,
    },
  };

  await cacheSet(cacheKey, response);
  return res.json(response);
});

/* =========================================================
   ANALYSIS — Standard (conservative: no web facts)
========================================================= */
async function analyzeStandard(text, lang) {
  const msg = t(lang);
  const s = computeSignals(text, lang);

  // Standard = “quality of writing + risk profile”
  const base = 60;

  const score = clamp(
    Math.round(
      base +
        s.deltaCoherence +
        s.deltaNuance +
        s.deltaEvidenceHints -
        s.deltaSensational -
        s.deltaUnsafe -
        s.deltaContradictionRisk -
        s.deltaLowInfo
    ),
    5,
    98
  );

  const riskLevel = score >= 82 ? "low" : score >= 58 ? "medium" : "high";

  // Confidence: capped because Standard does NOT verify facts
  const confidence = clamp(0.62 + s.confBoost - s.confPenalty, 0.14, 0.86);

  return {
    score,
    riskLevel,
    summary: msg.standardSummary,
    reasons: buildReasonsStandard(s, lang),
    confidence,
    sources: [],
  };
}

/* =========================================================
   ANALYSIS — PRO (claim extraction + optional web corroboration)
========================================================= */
async function analyzePro(text, lang, ctx) {
  const s = computeSignals(text, lang);

  // 1) Extract claims (the “living brain” part)
  const claims = extractClaims(text, lang)
    .filter((c) => c.length >= MIN_CLAIM_CHARS)
    .slice(0, MAX_CLAIMS);

  const timeSensitive = isTimeSensitive(text, lang);

  // 2) If web is enabled, corroborate each claim
  let evidence = {
    enabled: false,
    coverage: 0, // 0..1
    corroboration: 0, // 0..1
    contradiction: 0, // 0..1
    quality: 0, // 0..1
    sources: [],
  };

  if (ctx.externalSearchEnabled && ctx.provider === "bing" && BING_API_KEY) {
    evidence.enabled = true;

    const allSources = [];
    let supported = 0;
    let contradicted = 0;
    let checked = 0;

    for (const claim of claims.length ? claims : [makeFallbackClaim(text)]) {
      const q = buildSearchQuery(claim, lang);
      const r = await bingSearch(q, WEB_MAX_RESULTS).catch(() => ({ results: [] }));

      const judged = judgeSearchResultsAgainstClaim(claim, r.results, lang);
      checked += 1;
      if (judged.supported) supported += 1;
      if (judged.contradicted) contradicted += 1;

      for (const src of judged.sources || []) allSources.push(src);
    }

    const uniq = uniqSources(allSources);

    evidence.sources = uniq;
    evidence.coverage = checked ? clamp(uniq.length / (checked * 2), 0, 1) : 0;
    evidence.corroboration = checked ? clamp(supported / checked, 0, 1) : 0;
    evidence.contradiction = checked ? clamp(contradicted / checked, 0, 1) : 0;
    evidence.quality = scoreSourceQuality(uniq);
  }

  // 3) Score logic
  const base = 62;

  // Evidence bonus/penalties (only if enabled)
  const evidenceBoost = evidence.enabled
    ? Math.round(16 * evidence.corroboration + 10 * evidence.quality + 6 * evidence.coverage)
    : 0;

  const contradictionPenalty = evidence.enabled ? Math.round(22 * evidence.contradiction) : 0;

  // If time-sensitive AND no web verification => be conservative
  const timePenalty = timeSensitive && !evidence.enabled ? 10 : 0;

  const score = clamp(
    Math.round(
      base +
        s.deltaCoherence +
        s.deltaNuance +
        s.deltaEvidenceHints -
        s.deltaSensational -
        s.deltaUnsafe -
        s.deltaContradictionRisk -
        s.deltaLowInfo +
        evidenceBoost -
        contradictionPenalty -
        timePenalty
    ),
    5,
    98
  );

  const riskLevel = score >= 84 ? "low" : score >= 60 ? "medium" : "high";

  // Confidence
  let confidence = 0.68 + s.confBoost - s.confPenalty;
  if (evidence.enabled) {
    confidence += 0.14 * evidence.corroboration + 0.08 * evidence.quality - 0.18 * evidence.contradiction;
  } else if (timeSensitive) {
    confidence -= 0.18; // avoid strong claims about “right now” without web
  }
  confidence = clamp(confidence, 0.12, 0.94);

  // 4) Messaging
  const msg = t(lang);
  const summary = evidence.enabled
    ? msg.proSummaryVerified
    : timeSensitive
      ? msg.proSummaryTimeSensitiveNoWeb
      : msg.proSummaryNoWeb;

  const reasons = buildReasonsPro(s, lang, {
    claims,
    timeSensitive,
    evidence,
    score,
  });

  return {
    score,
    riskLevel,
    summary,
    reasons,
    confidence,
    sources: (evidence.sources || []).slice(0, 8),
  };
}

/* =========================================================
   WEB — Bing v7
========================================================= */
async function bingSearch(query, maxResults) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);

  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults || 6));
  url.searchParams.set("responseFilter", "Webpages");
  url.searchParams.set("textDecorations", "false");
  url.searchParams.set("textFormat", "Raw");

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Ocp-Apim-Subscription-Key": BING_API_KEY,
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(to));

  if (!r.ok) {
    return { results: [] };
  }

  const j = await r.json().catch(() => null);
  const items = j?.webPages?.value || [];

  const results = items
    .map((it) => ({
      name: safeShort(it.name || "", 160),
      snippet: safeShort(it.snippet || "", 260),
      url: normalizeUrl(it.url || ""),
      displayUrl: safeShort(it.displayUrl || "", 120),
    }))
    .filter((x) => x.url);

  return { results };
}

/* =========================================================
   CLAIMS + EVIDENCE JUDGEMENT (heuristics)
========================================================= */
function judgeSearchResultsAgainstClaim(claim, results, lang) {
  const lowerClaim = String(claim || "").toLowerCase();
  const tokens = claimTokens(lowerClaim);

  let supported = false;
  let contradicted = false;

  const sources = [];

  for (const r of results || []) {
    if (!r || !r.url) continue;

    // Reject generic homepages / category pages when possible
    if (isLowValueLandingUrl(r.url)) continue;

    const lower = (String(r.name || "") + " " + String(r.snippet || "")).toLowerCase();

    // Score match strength
    const overlap = tokenOverlap(tokens, claimTokens(lower));
    const hasNegation = containsNegation(lower, lang);
    const claimHasNegation = containsNegation(lowerClaim, lang);

    // Simple decision:
    // - If strong overlap and negation matches => support
    // - If strong overlap and negation conflicts => contradiction
    if (overlap >= 0.42) {
      if (claimHasNegation === hasNegation) supported = true;
      else contradicted = true;
    }

    sources.push({
      title: r.name,
      url: r.url,
      snippet: r.snippet,
      confidence: sourceConfidenceFromOverlap(overlap),
      quality: sourceQualityTier(r.url),
    });
  }

  return {
    supported,
    contradicted,
    sources: sources.slice(0, 8),
  };
}

/* =========================================================
   Signals + scoring helpers
========================================================= */
function computeSignals(text, lang) {
  const lower = String(text || "").toLowerCase();

  // Coherence (sentence structure)
  const sentences = splitSentences(text);
  const wc = wordCount(text);
  const avgLen = wc / Math.max(1, sentences.length);

  const deltaCoherence = clamp(Math.round((avgLen - 8) * 0.8), -10, 12);

  // Nuance (hedging / cautious language)
  const nuanceHits = countMatches(lower, langKeywords(lang, "nuance"));
  const deltaNuance = clamp(nuanceHits * 2, 0, 10);

  // Evidence hints (links, citations, data-ish)
  const evidenceHits =
    (/(https?:\/\/)/i.test(text) ? 2 : 0) +
    (/\b(according to|source|study|report|data)\b/i.test(text) ? 2 : 0) +
    (/\b(selon|source|étude|rapport|données)\b/i.test(text) ? 2 : 0);
  const deltaEvidenceHints = clamp(evidenceHits, 0, 10);

  // Sensationalism
  const sensationalHits = countMatches(lower, langKeywords(lang, "sensational"));
  const deltaSensational = clamp(sensationalHits * 2, 0, 14);

  // Unsafe or scammy cues
  const unsafeHits = countMatches(lower, langKeywords(lang, "unsafe"));
  const deltaUnsafe = clamp(unsafeHits * 3, 0, 16);

  // Contradiction risk (absolutes, too bold, etc.)
  const boldHits = countMatches(lower, langKeywords(lang, "bold"));
  const deltaContradictionRisk = clamp(boldHits * 2, 0, 12);

  // Low-info penalty (very short or vague)
  const deltaLowInfo = wc < 12 ? 12 : wc < 24 ? 7 : 0;

  // Confidence shaping
  const confBoost = clamp((deltaCoherence + deltaNuance + deltaEvidenceHints) / 60, 0, 0.22);
  const confPenalty = clamp((deltaSensational + deltaUnsafe + deltaContradictionRisk + deltaLowInfo) / 50, 0, 0.36);

  return {
    deltaCoherence,
    deltaNuance,
    deltaEvidenceHints,
    deltaSensational,
    deltaUnsafe,
    deltaContradictionRisk,
    deltaLowInfo,
    confBoost,
    confPenalty,
    meta: { wc, sentences: sentences.length },
  };
}

function buildReasonsStandard(s, lang) {
  const msg = t(lang);

  const reasons = [];

  reasons.push({
    label: msg.reasonWritingQuality,
    detail:
      s.deltaCoherence >= 5
        ? msg.detailCoherent
        : s.deltaCoherence <= -5
          ? msg.detailIncoherent
          : msg.detailNeutral,
  });

  reasons.push({
    label: msg.reasonNuance,
    detail: s.deltaNuance >= 6 ? msg.detailNuanced : s.deltaNuance >= 2 ? msg.detailSomeNuance : msg.detailNoNuance,
  });

  reasons.push({
    label: msg.reasonEvidence,
    detail: s.deltaEvidenceHints >= 6 ? msg.detailEvidenceStrong : s.deltaEvidenceHints >= 2 ? msg.detailEvidenceSome : msg.detailEvidenceNone,
  });

  reasons.push({
    label: msg.reasonRisk,
    detail:
      s.deltaUnsafe >= 9
        ? msg.detailUnsafeHigh
        : s.deltaSensational >= 8
          ? msg.detailSensational
          : s.deltaContradictionRisk >= 8
            ? msg.detailBold
            : msg.detailRiskLow,
  });

  return reasons;
}

function buildReasonsPro(s, lang, ctx) {
  const msg = t(lang);
  const reasons = [];

  if (ctx.timeSensitive) {
    reasons.push({
      label: msg.reasonTimeSensitive,
      detail: ctx.evidence.enabled ? msg.detailTimeVerified : msg.detailTimeNoWeb,
    });
  }

  if (ctx.claims && ctx.claims.length) {
    reasons.push({
      label: msg.reasonClaims,
      detail: msg.detailClaims + " " + ctx.claims.map((c) => `“${safeShort(c, 60)}”`).join(", "),
    });
  }

  reasons.push({
    label: msg.reasonWritingQuality,
    detail:
      s.deltaCoherence >= 5
        ? msg.detailCoherent
        : s.deltaCoherence <= -5
          ? msg.detailIncoherent
          : msg.detailNeutral,
  });

  reasons.push({
    label: msg.reasonNuance,
    detail: s.deltaNuance >= 6 ? msg.detailNuanced : s.deltaNuance >= 2 ? msg.detailSomeNuance : msg.detailNoNuance,
  });

  if (ctx.evidence.enabled) {
    reasons.push({
      label: msg.reasonWebVerification,
      detail: msg.detailWebVerified({
        corroboration: ctx.evidence.corroboration,
        contradiction: ctx.evidence.contradiction,
        quality: ctx.evidence.quality,
      }),
    });
  } else {
    reasons.push({
      label: msg.reasonWebVerification,
      detail: msg.detailWebDisabled,
    });
  }

  reasons.push({
    label: msg.reasonRisk,
    detail:
      s.deltaUnsafe >= 9
        ? msg.detailUnsafeHigh
        : s.deltaSensational >= 8
          ? msg.detailSensational
          : s.deltaContradictionRisk >= 8
            ? msg.detailBold
            : msg.detailRiskLow,
  });

  return reasons;
}

/* =========================================================
   Claim extraction
========================================================= */
function extractClaims(text, lang) {
  const sentences = splitSentences(text);

  // Heuristic: keep sentences that “sound like claims” (contain verbs, numbers, named entities)
  const out = [];

  for (const s of sentences) {
    const lower = s.toLowerCase();

    // Skip tiny fragments
    if (s.length < MIN_CLAIM_CHARS) continue;

    // Looks like a claim
    const hasVerb =
      /\b(is|are|was|were|has|have|will|won't|can't|does|did)\b/i.test(s) ||
      /\b(est|sont|était|étaient|a|ont|sera|seront|peut|doit)\b/i.test(s) ||
      /\b(es|son|fue|fueron|tiene|tienen|será)\b/i.test(s);

    const hasNumber = /\d/.test(s);
    const hasProper = /\b[A-Z][a-z]{2,}\b/.test(s);

    // Slight boost for time-sensitive entities (politics, finance)
    const topicCue = topicMatch(lower, lang, langKeywords(lang, "topics_politics")) || topicMatch(lower, lang, langKeywords(lang, "topics_finance"));

    if (hasVerb || hasNumber || hasProper || topicCue) {
      out.push(cleanClaim(s));
    }
  }

  // Fallback: take a compact chunk of the text
  if (!out.length) {
    return [makeFallbackClaim(text)];
  }

  return uniqStrings(out);
}

function cleanClaim(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^[\-–•\s]+/, "")
    .trim();
}

function makeFallbackClaim(text) {
  const clean = normalizeSpaces(text);
  return safeShort(clean, 140);
}

/* =========================================================
   Time sensitivity detection
========================================================= */
function isTimeSensitive(text, lang) {
  const lower = String(text || "").toLowerCase();

  // “current” cues
  const nowCues = [
    "today",
    "right now",
    "currently",
    "this year",
    "this month",
    "now",
    "aujourd",
    "actuellement",
    "en ce moment",
    "cette année",
    "maintenant",
    "hoy",
    "ahora",
    "actualmente",
    "este año",
    "oggi",
    "adesso",
    "attualmente",
    "quest'anno",
    "jetzt",
    "heute",
    "aktuell",
    "dieses jahr",
    "agora",
    "hoje",
    "atualmente",
    "este ano",
    "сейчас",
    "сегодня",
    "в этом году",
    "現在",
    "今日",
    "今年",
  ];

  // Year mention close to NOW_YEAR
  const yearMatch = lower.match(/\b(19\d{2}|20\d{2})\b/g) || [];
  const years = yearMatch.map((y) => Number(y)).filter((n) => !Number.isNaN(n));
  const nearNow = years.some((y) => Math.abs(y - NOW_YEAR) <= 1);

  // Roles that change with time
  const roleCues = langKeywords(lang, "roles_politics");

  const cuesHit = countMatches(lower, nowCues) > 0 || countMatches(lower, roleCues) > 0;

  return cuesHit || nearNow;
}

/* =========================================================
   Search query builder
========================================================= */
function buildSearchQuery(claim, lang) {
  const clean = normalizeSpaces(claim);

  // For “living” political roles, add extra context
  const lower = clean.toLowerCase();
  const isPolitics = topicMatch(lower, lang, langKeywords(lang, "topics_politics"));

  if (isPolitics) {
    return `${clean} official sources`;
  }

  return clean;
}

/* =========================================================
   Source ranking & cleaning
========================================================= */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // strip tracking params
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return "";
  }
}

function isLowValueLandingUrl(url) {
  // Filters pages that are often useless as “proof links” (homepages, broad category pages)
  const u = String(url || "").toLowerCase();

  // Homepages (very short paths)
  try {
    const p = new URL(u).pathname || "/";
    if (p === "/" || p.length <= 2) return true;
  } catch {}

  // Known “section” patterns
  const bad = [
    "/news",
    "/latest",
    "/home",
    "/frontpage",
    "/index",
    "/category",
    "/categories",
    "/topics",
    "/tag/",
    "/tags/",
    "/search",
  ];

  return bad.some((b) => u.includes(b));
}

function uniqSources(sources) {
  const out = [];
  const seen = new Set();

  for (const s of sources || []) {
    const url = normalizeUrl(s.url || "");
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    out.push({
      title: safeShort(s.title || "", 160),
      url,
      snippet: safeShort(s.snippet || "", 260),
      confidence: clamp(Number(s.confidence || 0), 0, 1),
      quality: String(s.quality || "unknown"),
    });
  }

  // Sort: quality tier then confidence
  out.sort((a, b) => {
    const qa = qualityRank(a.quality);
    const qb = qualityRank(b.quality);
    if (qa !== qb) return qb - qa;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  return out;
}

function sourceQualityTier(url) {
  const u = String(url || "").toLowerCase();

  if (/\.(gov|gc\.ca)\b/.test(u)) return "gov";
  if (/\.(edu|ac\.uk)\b/.test(u)) return "edu";

  // High-trust news
  const high = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "nytimes.com",
    "wsj.com",
    "ft.com",
    "theguardian.com",
    "cbc.ca",
    "radio-canada.ca",
    "lemonde.fr",
    "france24.com",
    "dw.com",
    "derstandard.at",
    "elpais.com",
    "corriere.it",
  ];
  if (high.some((d) => u.includes(d))) return "news_high";

  // Mid-trust news/blogs
  const mid = [
    "wikipedia.org",
    "investopedia.com",
    "britannica.com",
    "bloomberg.com",
    "cnbc.com",
    "forbes.com",
    "theconversation.com",
  ];
  if (mid.some((d) => u.includes(d))) return "news_mid";

  return "unknown";
}

function qualityRank(tier) {
  switch (tier) {
    case "gov":
      return 5;
    case "edu":
      return 4;
    case "news_high":
      return 3;
    case "news_mid":
      return 2;
    default:
      return 1;
  }
}

function scoreSourceQuality(sources) {
  if (!sources || !sources.length) return 0;
  const ranks = sources.map((s) => qualityRank(s.quality)).sort((a, b) => b - a);
  const top = ranks.slice(0, 4);
  const avg = top.reduce((a, b) => a + b, 0) / Math.max(1, top.length);
  return clamp((avg - 1) / 4, 0, 1); // 1..5 -> 0..1
}

function sourceConfidenceFromOverlap(overlap) {
  return clamp(overlap, 0, 1);
}

/* =========================================================
   Token overlap + negation
========================================================= */
function claimTokens(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = t.split(" ").filter(Boolean);

  // Remove short words
  return parts.filter((w) => w.length >= 3).slice(0, 24);
}

function tokenOverlap(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  let hits = 0;
  for (const x of b) if (A.has(x)) hits += 1;
  return hits / Math.max(a.length, b.length);
}

function containsNegation(lowerText, lang) {
  const lower = String(lowerText || "").toLowerCase();
  const neg = langKeywords(lang, "negation");
  return neg.some((w) => lower.includes(String(w).toLowerCase()));
}

/* =========================================================
   Language detection (simple + safer)
========================================================= */
function detectLangVerySimple(text) {
  const t = String(text || "");

  if (/[ぁ-ゟ゠-ヿ一-龯]/.test(t)) return "ja";
  if (/[А-Яа-яЁёІіЇїЄє]/.test(t)) return "ru";

  const lower = t.toLowerCase();

  const frHits = countMatches(lower, [" le ", " la ", " les ", " des ", " une ", " un ", " que ", " quoi ", " est ", " pas ", " pour ", " avec ", " sur ", " dans "]);
  const enHits = countMatches(lower, [" the ", " and ", " is ", " are ", " was ", " were ", " what ", " why ", " with ", " for ", " not ", " this ", " that "]);
  const esHits = countMatches(lower, [" el ", " la ", " los ", " las ", " que ", " es ", " son ", " por ", " para ", " con ", " no "]);
  const itHits = countMatches(lower, [" il ", " lo ", " la ", " che ", " è ", " sono ", " per ", " con ", " non "]);
  const deHits = countMatches(lower, [" der ", " die ", " das ", " und ", " ist ", " sind ", " nicht ", " mit ", " für "]);
  const ptHits = countMatches(lower, [" o ", " a ", " os ", " as ", " que ", " é ", " são ", " para ", " com ", " não "]);

  const best = [
    ["fr", frHits],
    ["en", enHits],
    ["es", esHits],
    ["it", itHits],
    ["de", deHits],
    ["pt", ptHits],
  ].sort((a, b) => b[1] - a[1])[0];

  return best && best[1] >= 2 ? best[0] : "en";
}

/* =========================================================
   Language dictionaries
========================================================= */
function t(lang) {
  const L = String(lang || "en").toLowerCase();

  const dict = {
    en: {
      standardSummary: "Standard analysis: writing quality and risk profile (no external verification).",
      proSummaryVerified: "PRO analysis: multi-signal + web corroboration (stronger confidence when sources agree).",
      proSummaryNoWeb: "PRO analysis: multi-signal + claim extraction (web verification disabled).",
      proSummaryTimeSensitiveNoWeb: "PRO analysis: time-sensitive content detected. Without web verification, results remain cautious.",
      reasonWritingQuality: "Writing quality",
      reasonNuance: "Nuance & caution",
      reasonEvidence: "Evidence hints",
      reasonWebVerification: "Web verification (PRO)",
      reasonClaims: "Main claims extracted",
      reasonTimeSensitive: "Time sensitivity",
      reasonRisk: "Risk profile",
      detailCoherent: "The text is structured and reasonably coherent.",
      detailIncoherent: "The text feels fragmented or unclear.",
      detailNeutral: "The structure is acceptable.",
      detailNuanced: "The language shows nuance and avoids over-absolute statements.",
      detailSomeNuance: "Some nuance is present.",
      detailNoNuance: "The wording is quite absolute.",
      detailEvidenceStrong: "The text includes explicit evidence cues (sources/data/links).",
      detailEvidenceSome: "Some evidence cues are present.",
      detailEvidenceNone: "Few or no evidence cues are present.",
      detailUnsafeHigh: "The content contains strong scam/unsafe signals.",
      detailSensational: "The content is quite sensational.",
      detailBold: "The content uses strong absolute claims (higher contradiction risk).",
      detailRiskLow: "No major risk cues detected.",
      detailClaims: "Key statements identified:",
      detailTimeVerified: "The topic may change over time; web verification was used.",
      detailTimeNoWeb: "The topic may change over time; without web verification we stay conservative.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Sources: corroboration ${(corroboration * 100).toFixed(0)}%, contradiction ${(contradiction * 100).toFixed(0)}%, source quality ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "External search is disabled (or missing API key), so no fact-check sources were used.",
    },
    fr: {
      standardSummary: "Analyse Standard : qualité d’écriture et profil de risque (sans vérification externe).",
      proSummaryVerified: "Analyse PRO : multi-signaux + corroboration web (confiance plus forte si les sources concordent).",
      proSummaryNoWeb: "Analyse PRO : multi-signaux + extraction de claims (vérification web désactivée).",
      proSummaryTimeSensitiveNoWeb:
        "Analyse PRO : contenu sensible au temps détecté. Sans vérification web, le résultat reste prudent.",
      reasonWritingQuality: "Qualité d’écriture",
      reasonNuance: "Nuance & prudence",
      reasonEvidence: "Indices de preuves",
      reasonWebVerification: "Vérification web (PRO)",
      reasonClaims: "Claims principaux extraits",
      reasonTimeSensitive: "Sensibilité au temps",
      reasonRisk: "Profil de risque",
      detailCoherent: "Le texte est structuré et plutôt cohérent.",
      detailIncoherent: "Le texte semble fragmenté ou peu clair.",
      detailNeutral: "La structure est acceptable.",
      detailNuanced: "Le langage montre de la nuance et évite les affirmations trop absolues.",
      detailSomeNuance: "Un peu de nuance est présente.",
      detailNoNuance: "Le wording est assez absolu.",
      detailEvidenceStrong: "Le texte contient des indices clairs de preuves (sources/données/liens).",
      detailEvidenceSome: "Quelques indices de preuves sont présents.",
      detailEvidenceNone: "Peu ou pas d’indices de preuves.",
      detailUnsafeHigh: "Le contenu contient de forts signaux d’arnaque / danger.",
      detailSensational: "Le contenu est assez sensationnaliste.",
      detailBold: "Le contenu utilise des affirmations très fortes (risque de contradiction).",
      detailRiskLow: "Aucun gros signal de risque détecté.",
      detailClaims: "Énoncés clés identifiés :",
      detailTimeVerified: "Le sujet peut changer avec le temps ; une vérification web a été utilisée.",
      detailTimeNoWeb: "Le sujet peut changer avec le temps ; sans vérification web on reste prudent.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Sources : corroboration ${(corroboration * 100).toFixed(0)}%, contradiction ${(contradiction * 100).toFixed(0)}%, qualité ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "La recherche externe est désactivée (ou clé API manquante), donc aucune source n’a été utilisée.",
    },
    es: {
      standardSummary: "Análisis estándar: calidad de escritura y perfil de riesgo (sin verificación externa).",
      proSummaryVerified: "Análisis PRO: multi-señales + corroboración web (más confianza si las fuentes coinciden).",
      proSummaryNoWeb: "Análisis PRO: multi-señales + extracción de claims (verificación web desactivada).",
      proSummaryTimeSensitiveNoWeb:
        "Análisis PRO: contenido sensible al tiempo detectado. Sin verificación web, el resultado es prudente.",
      reasonWritingQuality: "Calidad de escritura",
      reasonNuance: "Matices y prudencia",
      reasonEvidence: "Indicadores de evidencia",
      reasonWebVerification: "Verificación web (PRO)",
      reasonClaims: "Claims principales extraídos",
      reasonTimeSensitive: "Sensibilidad al tiempo",
      reasonRisk: "Perfil de riesgo",
      detailCoherent: "El texto está estructurado y es razonablemente coherente.",
      detailIncoherent: "El texto parece fragmentado o poco claro.",
      detailNeutral: "La estructura es aceptable.",
      detailNuanced: "El lenguaje muestra matices y evita afirmaciones absolutas.",
      detailSomeNuance: "Hay algunos matices.",
      detailNoNuance: "El texto es bastante absoluto.",
      detailEvidenceStrong: "El texto contiene señales claras de evidencia (fuentes/datos/enlaces).",
      detailEvidenceSome: "Hay algunas señales de evidencia.",
      detailEvidenceNone: "Hay pocas o ninguna señal de evidencia.",
      detailUnsafeHigh: "El contenido tiene señales fuertes de estafa o riesgo.",
      detailSensational: "El contenido es sensacionalista.",
      detailBold: "El contenido usa afirmaciones muy fuertes (riesgo de contradicción).",
      detailRiskLow: "No se detectan señales fuertes de riesgo.",
      detailClaims: "Afirmaciones clave identificadas:",
      detailTimeVerified: "El tema puede cambiar con el tiempo; se usó verificación web.",
      detailTimeNoWeb: "El tema puede cambiar con el tiempo; sin verificación web, somos prudentes.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Fuentes: corroboración ${(corroboration * 100).toFixed(0)}%, contradicción ${(contradiction * 100).toFixed(0)}%, calidad ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "La búsqueda externa está desactivada (o falta la clave API), sin fuentes.",
    },
    it: {
      standardSummary: "Analisi Standard: qualità della scrittura e profilo di rischio (senza verifica esterna).",
      proSummaryVerified: "Analisi PRO: multi-segnali + corroborazione web (più fiducia se le fonti concordano).",
      proSummaryNoWeb: "Analisi PRO: multi-segnali + estrazione dei claim (verifica web disattivata).",
      proSummaryTimeSensitiveNoWeb:
        "Analisi PRO: contenuto sensibile al tempo rilevato. Senza verifica web, risultato prudente.",
      reasonWritingQuality: "Qualità della scrittura",
      reasonNuance: "Nuance e prudenza",
      reasonEvidence: "Indizi di prove",
      reasonWebVerification: "Verifica web (PRO)",
      reasonClaims: "Claim principali estratti",
      reasonTimeSensitive: "Sensibilità al tempo",
      reasonRisk: "Profilo di rischio",
      detailCoherent: "Il testo è strutturato e abbastanza coerente.",
      detailIncoherent: "Il testo sembra frammentato o poco chiaro.",
      detailNeutral: "La struttura è accettabile.",
      detailNuanced: "Il linguaggio mostra nuance ed evita affermazioni troppo assolute.",
      detailSomeNuance: "C'è un po' di nuance.",
      detailNoNuance: "Il testo è piuttosto assoluto.",
      detailEvidenceStrong: "Il testo contiene chiari indizi di prove (fonti/dati/link).",
      detailEvidenceSome: "Alcuni indizi di prove sono presenti.",
      detailEvidenceNone: "Pochi o nessun indizio di prove.",
      detailUnsafeHigh: "Il contenuto contiene forti segnali di rischio/truffa.",
      detailSensational: "Il contenuto è sensazionalista.",
      detailBold: "Il contenuto usa claim molto forti (rischio di contraddizione).",
      detailRiskLow: "Nessun segnale di rischio importante rilevato.",
      detailClaims: "Affermazioni chiave identificate:",
      detailTimeVerified: "Il tema può cambiare nel tempo; è stata usata verifica web.",
      detailTimeNoWeb: "Il tema può cambiare nel tempo; senza verifica web restiamo prudenti.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Fonti: corroborazione ${(corroboration * 100).toFixed(0)}%, contraddizione ${(contradiction * 100).toFixed(0)}%, qualità ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "Ricerca esterna disattivata (o chiave API mancante), nessuna fonte.",
    },
    de: {
      standardSummary: "Standard-Analyse: Schreibqualität und Risikoprofil (ohne externe Verifizierung).",
      proSummaryVerified: "PRO-Analyse: Multi-Signale + Web-Korroboration (mehr Vertrauen bei Quellen-Konsens).",
      proSummaryNoWeb: "PRO-Analyse: Multi-Signale + Claim-Extraktion (Web-Verifizierung deaktiviert).",
      proSummaryTimeSensitiveNoWeb:
        "PRO-Analyse: zeitabhängiger Inhalt erkannt. Ohne Web-Verifizierung bleibt das Ergebnis vorsichtig.",
      reasonWritingQuality: "Schreibqualität",
      reasonNuance: "Nuancen & Vorsicht",
      reasonEvidence: "Hinweise auf Belege",
      reasonWebVerification: "Web-Verifizierung (PRO)",
      reasonClaims: "Extrahierte Haupt-Claims",
      reasonTimeSensitive: "Zeitabhängigkeit",
      reasonRisk: "Risikoprofil",
      detailCoherent: "Der Text ist strukturiert und weitgehend kohärent.",
      detailIncoherent: "Der Text wirkt fragmentiert oder unklar.",
      detailNeutral: "Die Struktur ist akzeptabel.",
      detailNuanced: "Die Sprache ist differenziert und vermeidet absolute Aussagen.",
      detailSomeNuance: "Einige Nuancen sind vorhanden.",
      detailNoNuance: "Die Formulierungen sind recht absolut.",
      detailEvidenceStrong: "Der Text enthält deutliche Hinweise auf Belege (Quellen/Daten/Links).",
      detailEvidenceSome: "Einige Hinweise auf Belege sind vorhanden.",
      detailEvidenceNone: "Wenig oder keine Hinweise auf Belege.",
      detailUnsafeHigh: "Der Inhalt zeigt starke Scam-/Risikosignale.",
      detailSensational: "Der Inhalt ist sensationell formuliert.",
      detailBold: "Der Inhalt nutzt sehr starke Claims (Widerspruchsrisiko).",
      detailRiskLow: "Keine großen Risikosignale erkannt.",
      detailClaims: "Wichtige Aussagen identifiziert:",
      detailTimeVerified: "Das Thema kann sich zeitlich ändern; Web-Verifizierung wurde genutzt.",
      detailTimeNoWeb: "Das Thema kann sich zeitlich ändern; ohne Web-Verifizierung bleiben wir vorsichtig.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Quellen: Bestätigung ${(corroboration * 100).toFixed(0)}%, Widerspruch ${(contradiction * 100).toFixed(0)}%, Qualität ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "Externe Suche deaktiviert (oder API-Key fehlt), keine Quellen genutzt.",
    },
    pt: {
      standardSummary: "Análise Standard: qualidade de escrita e perfil de risco (sem verificação externa).",
      proSummaryVerified: "Análise PRO: multi-sinais + corroborção web (mais confiança quando fontes concordam).",
      proSummaryNoWeb: "Análise PRO: multi-sinais + extração de claims (verificação web desativada).",
      proSummaryTimeSensitiveNoWeb:
        "Análise PRO: conteúdo sensível ao tempo detectado. Sem verificação web, o resultado permanece cauteloso.",
      reasonWritingQuality: "Qualidade da escrita",
      reasonNuance: "Nuance e cautela",
      reasonEvidence: "Indícios de evidência",
      reasonWebVerification: "Verificação web (PRO)",
      reasonClaims: "Claims principais extraídos",
      reasonTimeSensitive: "Sensibilidade ao tempo",
      reasonRisk: "Perfil de risco",
      detailCoherent: "O texto é estruturado e razoavelmente coerente.",
      detailIncoherent: "O texto parece fragmentado ou pouco claro.",
      detailNeutral: "A estrutura é aceitável.",
      detailNuanced: "A linguagem mostra nuance e evita afirmações absolutas.",
      detailSomeNuance: "Alguma nuance está presente.",
      detailNoNuance: "O texto é bastante absoluto.",
      detailEvidenceStrong: "O texto contém sinais claros de evidência (fontes/dados/links).",
      detailEvidenceSome: "Alguns sinais de evidência estão presentes.",
      detailEvidenceNone: "Poucos ou nenhum sinal de evidência.",
      detailUnsafeHigh: "O conteúdo contém fortes sinais de risco/golpe.",
      detailSensational: "O conteúdo é sensacionalista.",
      detailBold: "O conteúdo usa claims muito fortes (risco de contradição).",
      detailRiskLow: "Nenhum grande sinal de risco detectado.",
      detailClaims: "Afirmações-chave identificadas:",
      detailTimeVerified: "O tema pode mudar com o tempo; verificação web foi usada.",
      detailTimeNoWeb: "O tema pode mudar com o tempo; sem verificação web ficamos cautelosos.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Fontes: corroborção ${(corroboration * 100).toFixed(0)}%, contradição ${(contradiction * 100).toFixed(0)}%, qualidade ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "Busca externa desativada (ou chave API ausente), sem fontes.",
    },
    ru: {
      standardSummary: "Стандартный анализ: качество текста и профиль риска (без внешней проверки).",
      proSummaryVerified: "PRO-анализ: мульти-сигналы + веб-подтверждение (выше уверенность при согласии источников).",
      proSummaryNoWeb: "PRO-анализ: мульти-сигналы + извлечение claims (веб-проверка отключена).",
      proSummaryTimeSensitiveNoWeb:
        "PRO-анализ: обнаружен контент, зависящий от времени. Без веб-проверки результат осторожный.",
      reasonWritingQuality: "Качество текста",
      reasonNuance: "Нюансы и осторожность",
      reasonEvidence: "Признаки доказательств",
      reasonWebVerification: "Веб-проверка (PRO)",
      reasonClaims: "Основные claims",
      reasonTimeSensitive: "Зависимость от времени",
      reasonRisk: "Профиль риска",
      detailCoherent: "Текст структурирован и достаточно связный.",
      detailIncoherent: "Текст выглядит фрагментарным или неясным.",
      detailNeutral: "Структура приемлемая.",
      detailNuanced: "Формулировки аккуратные и не слишком абсолютные.",
      detailSomeNuance: "Некоторые нюансы присутствуют.",
      detailNoNuance: "Формулировки довольно абсолютные.",
      detailEvidenceStrong: "Есть явные признаки доказательств (источники/данные/ссылки).",
      detailEvidenceSome: "Есть некоторые признаки доказательств.",
      detailEvidenceNone: "Мало или нет признаков доказательств.",
      detailUnsafeHigh: "Есть сильные сигналы риска/мошенничества.",
      detailSensational: "Контент выглядит сенсационным.",
      detailBold: "Слишком сильные утверждения (риск противоречий).",
      detailRiskLow: "Сильных сигналов риска не обнаружено.",
      detailClaims: "Ключевые утверждения:",
      detailTimeVerified: "Тема может меняться со временем; использована веб-проверка.",
      detailTimeNoWeb: "Тема может меняться со временем; без веб-проверки мы осторожны.",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `Источники: подтверждение ${(corroboration * 100).toFixed(0)}%, противоречие ${(contradiction * 100).toFixed(0)}%, качество ${(quality * 100).toFixed(0)}%.`,
      detailWebDisabled: "Внешний поиск отключён (или нет API-ключа), источники не использованы.",
    },
    ja: {
      standardSummary: "標準分析：文章の質とリスク傾向（外部検証なし）。",
      proSummaryVerified: "PRO分析：複数シグナル + Web照合（情報源が一致するほど信頼度UP）。",
      proSummaryNoWeb: "PRO分析：複数シグナル + 主張抽出（Web検証オフ）。",
      proSummaryTimeSensitiveNoWeb: "PRO分析：時間依存の内容を検出。Web検証がないため慎重に評価します。",
      reasonWritingQuality: "文章の質",
      reasonNuance: "ニュアンスと慎重さ",
      reasonEvidence: "根拠のヒント",
      reasonWebVerification: "Web検証（PRO）",
      reasonClaims: "抽出した主張",
      reasonTimeSensitive: "時間依存性",
      reasonRisk: "リスク傾向",
      detailCoherent: "文章は構造的で概ね一貫しています。",
      detailIncoherent: "文章が断片的で不明瞭に見えます。",
      detailNeutral: "構造は許容範囲です。",
      detailNuanced: "断定を避け、慎重な表現が見られます。",
      detailSomeNuance: "一定の慎重さが見られます。",
      detailNoNuance: "断定的な表現が多いです。",
      detailEvidenceStrong: "根拠の手がかり（出典/データ/リンク）が明確です。",
      detailEvidenceSome: "一部根拠の手がかりがあります。",
      detailEvidenceNone: "根拠の手がかりが少ないです。",
      detailUnsafeHigh: "詐欺/危険性の強いシグナルがあります。",
      detailSensational: "煽り気味の表現があります。",
      detailBold: "強い断定が多く、矛盾リスクが上がります。",
      detailRiskLow: "大きなリスクシグナルは見られません。",
      detailClaims: "主要な主張：",
      detailTimeVerified: "時間で変わる可能性があるため、Web検証を使用しました。",
      detailTimeNoWeb: "時間で変わる可能性があるため、Web検証なしでは慎重に扱います。",
      detailWebVerified: ({ corroboration, contradiction, quality }) =>
        `出典：一致 ${(corroboration * 100).toFixed(0)}%、矛盾 ${(contradiction * 100).toFixed(0)}%、品質 ${(quality * 100).toFixed(0)}%。`,
      detailWebDisabled: "外部検索が無効（またはAPIキーなし）のため、出典は使用していません。",
    },
  };

  return dict[L] || dict.en;
}

/* =========================================================
   Keywords per language
========================================================= */
function langKeywords(lang, topic) {
  const L = String(lang || "en").toLowerCase();

  const dict = {
    nuance: {
      en: ["maybe", "likely", "possibly", "it seems", "could", "might", "approximately", "reportedly"],
      fr: ["peut-être", "probablement", "possiblement", "il semble", "pourrait", "environ", "selon"],
      es: ["quizás", "probablemente", "posiblemente", "parece", "podría", "aprox"],
      it: ["forse", "probabilmente", "possibilmente", "sembra", "potrebbe", "circa"],
      de: ["vielleicht", "wahrscheinlich", "möglicherweise", "scheint", "könnte", "ungefähr"],
      pt: ["talvez", "provavelmente", "possivelmente", "parece", "poderia", "aprox"],
      ru: ["возможно", "вероятно", "похоже", "может", "примерно", "сообщается"],
      ja: ["たぶん", "おそらく", "可能性", "〜かもしれない", "約", "報道"],
    },
    sensational: {
      en: ["shocking", "unbelievable", "insane", "everyone is talking", "secret", "exposed", "100%"],
      fr: ["choquant", "incroyable", "dingue", "tout le monde en parle", "secret", "révélé", "100%"],
      es: ["impactante", "increíble", "loco", "secreto", "revelado", "100%"],
      it: ["scioccante", "incredibile", "pazzo", "segreto", "rivelato", "100%"],
      de: ["schockierend", "unglaublich", "wahnsinn", "geheim", "enthüllt", "100%"],
      pt: ["chocante", "inacreditável", "louco", "segredo", "revelado", "100%"],
      ru: ["шок", "невероятно", "безумно", "секрет", "разоблачено", "100%"],
      ja: ["衝撃", "信じられない", "やばい", "秘密", "暴露", "100%"],
    },
    unsafe: {
      en: ["guaranteed profit", "send money", "wire", "crypto giveaway", "free bitcoin", "urgent", "limited time"],
      fr: ["profit garanti", "envoie de l'argent", "virement", "giveaway crypto", "bitcoin gratuit", "urgent", "temps limité"],
      es: ["ganancia garantizada", "envía dinero", "transferencia", "regalo cripto", "bitcoin gratis", "urgente", "tiempo limitado"],
      it: ["profitto garantito", "invia denaro", "bonifico", "giveaway crypto", "bitcoin gratis", "urgente", "tempo limitato"],
      de: ["garantierter gewinn", "geld senden", "überweisung", "krypto giveaway", "gratis bitcoin", "dringend", "begrenzte zeit"],
      pt: ["lucro garantido", "envie dinheiro", "transferência", "giveaway cripto", "bitcoin grátis", "urgente", "tempo limitado"],
      ru: ["гарантированная прибыль", "переведи деньги", "перевод", "раздача крипто", "бесплатный биткоин", "срочно", "ограниченное время"],
      ja: ["確実に儲かる", "送金", "振込", "仮想通貨プレゼント", "無料ビットコイン", "緊急", "期間限定"],
    },
    bold: {
      en: ["always", "never", "everyone", "no doubt", "definitely", "prove", "must"],
      fr: ["toujours", "jamais", "tout le monde", "aucun doute", "certainement", "prouve", "doit"],
      es: ["siempre", "nunca", "todos", "sin duda", "definitivamente", "prueba", "debe"],
      it: ["sempre", "mai", "tutti", "senza dubbio", "definitivamente", "prova", "deve"],
      de: ["immer", "nie", "jeder", "ohne zweifel", "definitiv", "beweist", "muss"],
      pt: ["sempre", "nunca", "todos", "sem dúvida", "definitivamente", "prova", "deve"],
      ru: ["всегда", "никогда", "все", "без сомнений", "точно", "доказывает", "должен"],
      ja: ["絶対", "必ず", "みんな", "疑いなく", "確実", "証明", "〜すべき"],
    },
    negation: {
      en: [" not ", " never ", " no ", " isn't ", " aren't ", " can't ", " cannot ", " won't "],
      fr: [" ne ", " pas ", " jamais ", " aucun ", " n'est ", " n’a ", " n'a ", " ne peut "],
      es: [" no ", " nunca ", " jamás ", " ninguno ", " no es "],
      it: [" non ", " mai ", " nessun ", " non è "],
      de: [" nicht ", " nie ", " kein ", " ist nicht "],
      pt: [" não ", " nunca ", " jamais ", " nenhum ", " não é "],
      ru: [" не ", " никогда ", " нет ", " нельзя "],
      ja: ["ない", "ではない", "できない", "無理"],
    },
    roles_politics: {
      en: ["president", "prime minister", "chancellor", "first lady", "governor", "minister"],
      fr: ["président", "premier ministre", "chancelier", "première dame", "gouverneur", "ministre"],
      es: ["presidente", "primer ministro", "canciller", "primera dama", "gobernador", "ministro"],
      it: ["presidente", "primo ministro", "cancelliere", "first lady", "governatore", "ministro"],
      de: ["präsident", "kanzler", "ministerpräsident", "first lady", "gouverneur", "minister"],
      pt: ["presidente", "primeiro-ministro", "chanceler", "primeira-dama", "governador", "ministro"],
      ru: ["президент", "премьер-министр", "канцлер", "первая леди", "губернатор", "министр"],
      ja: ["大統領", "首相", "首相", "ファーストレディ", "知事", "大臣"],
    },
    topics_politics: {
      en: ["president", "election", "government", "senate", "white house", "ukraine", "russia", "parliament"],
      fr: ["président", "élection", "gouvernement", "sénat", "maison blanche", "ukraine", "russie", "parlement"],
      es: ["presidente", "elección", "gobierno", "senado", "casa blanca", "ucrania", "rusia", "parlamento"],
      it: ["presidente", "elezione", "governo", "senato", "casa bianca", "ucraina", "russia", "parlamento"],
      de: ["präsident", "wahl", "regierung", "senat", "weißes haus", "ukraine", "russland", "parlament"],
      pt: ["presidente", "eleição", "governo", "senado", "casa branca", "ucrânia", "rússia", "parlamento"],
      ru: ["президент", "выборы", "правительство", "сенат", "белый дом", "украина", "россия", "парламент"],
      ja: ["大統領", "選挙", "政府", "上院", "ホワイトハウス", "ウクライナ", "ロシア", "議会"],
    },
    topics_finance: {
      en: ["bitcoin", "stock", "profit", "investment", "market", "bank", "rate"],
      fr: ["bitcoin", "action", "profit", "investissement", "marché", "banque", "taux"],
      es: ["bitcoin", "acciones", "ganancia", "inversión", "mercado", "banco", "tasa"],
      it: ["bitcoin", "azioni", "profitto", "investimento", "mercato", "banca", "tasso"],
      de: ["bitcoin", "aktien", "gewinn", "investition", "markt", "bank", "zins"],
      pt: ["bitcoin", "ações", "lucro", "investimento", "mercado", "banco", "taxa"],
      ru: ["биткоин", "акции", "прибыль", "инвестиции", "рынок", "банк", "ставка"],
      ja: ["ビットコイン", "株", "利益", "投資", "市場", "銀行", "金利"],
    },
  };

  return (dict[topic] && (dict[topic][L] || dict[topic].en)) || [];
}

/* =========================================================
   Cache + Rate limiting
   - In-memory fallback (works for 1 instance)
   - Optional shared storage via Upstash Redis REST (multi-instance safe)
========================================================= */

function hasUpstash() {
  return !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
}

async function upstash(cmd, ...args) {
  // Upstash REST: POST {url}/{command}/{arg1}/{arg2}...
  // We keep it simple and use /pipeline when we need atomic multi-ops.
  const url =
    UPSTASH_REDIS_REST_URL.replace(/\/+$/, "") +
    "/" +
    encodeURIComponent(cmd.toLowerCase()) +
    (args.length ? "/" + args.map((a) => encodeURIComponent(String(a))).join("/") : "");

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
  }).catch(() => null);

  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  return j;
}

async function upstashPipeline(commands) {
  const url = UPSTASH_REDIS_REST_URL.replace(/\/+$/, "") + "/pipeline";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commands }),
  }).catch(() => null);

  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  return j;
}

/* ------------------------------
   Cache (LRU-ish fallback)
------------------------------ */
const CACHE = new Map(); // key -> { value, exp, last }

async function cacheGet(key) {
  // Shared cache (Upstash) if configured
  if (hasUpstash()) {
    const j = await upstash("get", key);
    const raw = j && j.result;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Fallback: in-memory
  const it = CACHE.get(key);
  if (!it) return null;
  if (it.exp < nowMs()) {
    CACHE.delete(key);
    return null;
  }
  it.last = nowMs();
  return it.value;
}

async function cacheSet(key, value) {
  // Shared cache (Upstash) if configured
  if (hasUpstash()) {
    const ttlSec = Math.max(1, Math.round(CACHE_TTL_MS / 1000));
    // SET key value EX ttl
    await upstash("set", key, JSON.stringify(value), "ex", ttlSec);
    return;
  }

  // Fallback: in-memory LRU-ish
  const exp = nowMs() + CACHE_TTL_MS;
  CACHE.set(key, { value, exp, last: nowMs() });
  if (CACHE.size <= CACHE_MAX_ITEMS) return;

  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, v] of CACHE.entries()) {
    if (v.last < oldest) {
      oldest = v.last;
      oldestKey = k;
    }
  }
  if (oldestKey) CACHE.delete(oldestKey);
}

/* ------------------------------
   Rate limiting (per IP, per minute)
------------------------------ */
const RATE = new Map(); // fallback key -> { count, resetMs }

async function rateLimitCheck(req, isPro) {
  const ip = getIp(req);
  const limit = isPro ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const bucket = Math.floor(nowMs() / 60000);
  const resetMs = (bucket + 1) * 60000;

  // Shared rate-limit (Upstash) if configured (multi-instance safe)
  if (hasUpstash()) {
    // One key per ip/bucket/tier
    const key = `rl:${ip}:${bucket}:${isPro ? "pro" : "std"}`;
    const ttlSec = Math.max(2, Math.ceil((resetMs - nowMs()) / 1000));

    // Atomic-ish: INCR then EXPIRE (in a pipeline)
    const pipe = await upstashPipeline([
      ["INCR", key],
      ["EXPIRE", key, ttlSec],
    ]);

    const incrRes = pipe && pipe[0] && pipe[0].result;
    const count = Number(incrRes || 0);

    const remaining = Math.max(0, limit - count);
    return { ok: count <= limit, limit, remaining, resetMs };
  }

  // Fallback: in-memory (single instance)
  const key = `${ip}:${bucket}:${isPro ? "pro" : "std"}`;
  const cur = RATE.get(key) || { count: 0, resetMs };
  cur.count += 1;
  cur.resetMs = resetMs;
  RATE.set(key, cur);

  const remaining = Math.max(0, limit - cur.count);
  return { ok: cur.count <= limit, limit, remaining, resetMs };
}

/* =========================================================
   Utilities
========================================================= */
function nowMs() {
  return Date.now();
}
function makeId() {
  return crypto.randomBytes(12).toString("hex");
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
function safeTrimText(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}
function normalizeSpaces(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}
function wordCount(t) {
  const w = normalizeSpaces(t).split(" ").filter(Boolean);
  return w.length;
}
function countMatches(lowerText, patterns) {
  if (!patterns || !patterns.length) return 0;
  let c = 0;
  for (const p of patterns) {
    if (!p) continue;
    const needle = String(p).toLowerCase();
    if (!needle) continue;
    if (lowerText.includes(needle)) c += 1;
  }
  return c;
}
function splitSentences(text) {
  const clean = normalizeSpaces(text);
  if (!clean) return [];
  const parts = clean
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [clean];
}
function topicMatch(lowerText, lang, keywords) {
  if (!keywords || !keywords.length) return false;
  for (const w of keywords) {
    if (!w) continue;
    if (lowerText.includes(String(w).toLowerCase())) return true;
  }
  return false;
}
function safeShort(s, max) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}
function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const a of arr || []) {
    const s = String(a || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function simpleSignature(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 16);
}
function isProbablyProMode(mode) {
  return String(mode || "").toLowerCase().includes("pro");
}
function getIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xf || req.socket?.remoteAddress || "unknown";
  return ip.replace("::ffff:", "");
}

function isExternalSearchEnabled() {
  // PRO web search is enabled if provider + API key are set
  if (WEB_PROVIDER === "bing" && BING_API_KEY) return true;
  return false;
}

function normalizeMode(mode) {
  const m = String(mode || "standard").toLowerCase();
  return m.includes("pro") ? "pro" : "standard";
}

/* -------------------------------
   Start server
-------------------------------- */
app.listen(PORT, () => {
  console.log(`[IA11] listening on port ${PORT} | version=${VERSION}`);
});
