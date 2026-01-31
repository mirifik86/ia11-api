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

/* -------------------------------
   Config
-------------------------------- */
const app = express();
const PORT = process.env.PORT || 3000;

const ENGINE_NAME = "IA11";
const VERSION = "2.2.0";

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
  const rl = rateLimitCheck(req, isPro);
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
  const cached = cacheGet(cacheKey);
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

  cacheSet(cacheKey, response);
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

      const cleaned = cleanAndDedupeSources(r.results || []);
      if (cleaned.length) checked += 1;

      // Evaluate each claim vs snippets
      const evald = evaluateEvidenceForClaim(claim, cleaned, lang);
      supported += evald.supported;
      contradicted += evald.contradicted;

      for (const it of cleaned) allSources.push(it);

      // Gentle pacing: keep fast + stable
      if (allSources.length >= 10) break;
    }

    const sources = cleanAndDedupeSources(allSources);
    evidence.sources = sources;

    evidence.coverage = claims.length ? clamp(checked / claims.length, 0, 1) : (checked ? 0.5 : 0);
    evidence.corroboration = clamp(supported / Math.max(1, claims.length), 0, 1);
    evidence.contradiction = clamp(contradicted / Math.max(1, claims.length), 0, 1);
    evidence.quality = clamp(estimateSourceQuality(sources), 0, 1);
  }

  // 3) Score synthesis (this is where “WOW” is felt)
  const base = 64;

  // Penalty for time-sensitive claims WITHOUT web verification:
  const missingWebPenalty = !evidence.enabled && timeSensitive ? 8 : 0;

  const evidenceBoost = evidence.enabled
    ? Math.round(14 * evidence.corroboration + 6 * evidence.quality - 10 * evidence.contradiction)
    : 0;

  const score = clamp(
    Math.round(
      base +
        s.deltaCoherence +
        s.deltaNuance +
        s.deltaEvidenceHints -
        s.deltaSensational -
        s.deltaUnsafe -
        s.deltaContradictionRisk -
        s.deltaLowInfo -
        missingWebPenalty +
        evidenceBoost
    ),
    5,
    98
  );

  const riskLevel = score >= 84 ? "low" : score >= 60 ? "medium" : "high";

  // Confidence is “earned” by evidence; without evidence, stay humble.
  const confidence = clamp(
    0.66 +
      s.confBoost -
      s.confPenalty +
      (evidence.enabled ? 0.18 * evidence.coverage + 0.18 * evidence.quality + 0.18 * evidence.corroboration : -0.08) -
      (evidence.enabled ? 0.22 * evidence.contradiction : 0),
    0.12,
    0.95
  );

  // 4) Build reasons + summary (human-feeling, but safe)
  const reasons = buildReasonsPro({ s, evidence, claims, timeSensitive }, lang);
  const summary = buildProSummary({ score, evidence, timeSensitive }, lang);

  return {
    score,
    riskLevel,
    summary,
    reasons,
    confidence,
    sources: evidence.sources || [],
  };
}

/* =========================================================
   “Living” Intelligence — Claims, Evidence, Scoring signals
========================================================= */
function extractClaims(text, lang) {
  const clean = normalizeSpaces(String(text || ""));
  const sentences = splitSentences(clean);

  const scored = sentences
    .map((s) => ({ s: s.trim(), w: scoreClaimCandidate(s, lang) }))
    .filter((x) => x.s.length >= MIN_CLAIM_CHARS)
    .sort((a, b) => b.w - a.w);

  const out = [];
  const seen = new Set();
  for (const item of scored) {
    const key = simpleSignature(item.s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.s);
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

function scoreClaimCandidate(sentence, lang) {
  const s = sentence.trim();
  const lower = s.toLowerCase();

  let w = 0;

  if (/( is | are | was | were | has | have | announced | says | said | claims | confirmed )/i.test(s)) w += 3;
  if (/\b(19\d{2}|20\d{2}|21\d{2})\b/.test(s)) w += 3;
  if (/\d/.test(s)) w += 2;

  const caps = (s.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;
  if (caps >= 1) w += Math.min(4, caps);

  if (topicMatch(lower, lang, topicKeywords(lang, "politics"))) w += 2;
  if (topicMatch(lower, lang, topicKeywords(lang, "health"))) w += 2;
  if (topicMatch(lower, lang, topicKeywords(lang, "finance"))) w += 2;

  if (/\?$/.test(s)) w -= 2;
  if (s.length < 28) w -= 2;

  return w;
}

function makeFallbackClaim(text) {
  const clean = normalizeSpaces(text);
  return clean.length <= 180 ? clean : clean.slice(0, 180);
}

function buildSearchQuery(claim, lang) {
  const msg = t(lang);
  const c = normalizeSpaces(claim).replace(/[“”"]/g, '"');
  const booster = msg.searchBooster || "official source";
  return `${c} ${booster}`.trim();
}

function evaluateEvidenceForClaim(claim, sources, lang) {
  if (!Array.isArray(sources) || !sources.length) return { supported: 0, contradicted: 0 };

  const cTokens = bagOfWords(claim, lang);
  const negWords = contradictionWords(lang);

  let supportHits = 0;
  let contraHits = 0;

  for (const it of sources) {
    const snippet = String(it.snippet || "");
    const title = String(it.title || "");
    const text = `${title} ${snippet}`.toLowerCase();

    const sTokens = bagOfWords(text, lang);
    const overlap = tokenOverlapRatio(cTokens, sTokens);

    const contraCue = negWords.some((w) => text.includes(w));

    if (overlap >= 0.18 && !contraCue) supportHits += 1;
    if (overlap >= 0.12 && contraCue) contraHits += 1;
  }

  return {
    supported: supportHits >= 1 ? 1 : 0,
    contradicted: contraHits >= 1 ? 1 : 0,
  };
}

function estimateSourceQuality(sources) {
  if (!Array.isArray(sources) || !sources.length) return 0;

  const good = new Set([
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "theguardian.com",
    "nytimes.com",
    "washingtonpost.com",
    "wsj.com",
    "ft.com",
    "nature.com",
    "science.org",
    "who.int",
    "cdc.gov",
    "gov",
    "gc.ca",
    "canada.ca",
    "europa.eu",
    "un.org",
    "sec.gov",
  ]);

  let score = 0;
  for (const it of sources) {
    const host = hostFromUrl(it.url || "");
    if (!host) continue;
    if (good.has(host)) score += 1.0;
    else if (host.endsWith(".gov") || host.endsWith(".int")) score += 0.9;
    else if (host.includes("wikipedia.org")) score += 0.5;
    else score += 0.35;
  }
  return clamp(score / Math.max(1, sources.length), 0, 1);
}

function isTimeSensitive(text, lang) {
  const s = String(text || "");
  const years = (s.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/g) || []).map((y) => Number(y)).filter(Boolean);
  const hasFutureYear = years.some((y) => y >= NOW_YEAR);

  const lower = s.toLowerCase();
  const msg = t(lang);

  const officeWords = msg.officeWords || ["president", "prime minister", "chancellor", "king", "queen"];
  const hasOffice = officeWords.some((w) => lower.includes(w));

  const nowWords = msg.nowWords || ["current", "today", "right now", "currently"];
  const hasNow = nowWords.some((w) => lower.includes(w));

  return hasFutureYear || (hasOffice && hasNow) || (hasOffice && years.length);
}

function computeSignals(text, lang) {
  const clean = normalizeSpaces(String(text || ""));
  const len = clean.length;

  const hasNumbers = /\d/.test(clean);
  const hasLinks = /(https?:\/\/|www\.)/i.test(clean);
  const hasQuotes = /["“”'’]/.test(clean);

  const wc = wordCount(clean);
  const lowInfo = len < 70 || wc < 12;

  const lower = clean.toLowerCase();

  const sensational = countMatches(lower, sensationalWords(lang));
  const certainty = countMatches(lower, certaintyWords(lang));
  const hedge = countMatches(lower, hedgeWords(lang));

  const sentences = Math.max(1, splitSentences(clean).length);
  const avgSentenceLen = Math.max(1, Math.round(wc / sentences));

  const topicPolitics = topicMatch(lower, lang, topicKeywords(lang, "politics"));
  const topicHealth = topicMatch(lower, lang, topicKeywords(lang, "health"));
  const topicFinance = topicMatch(lower, lang, topicKeywords(lang, "finance"));

  const unsafe = countMatches(lower, unsafeWords(lang));

  let deltaEvidenceHints = 0;
  if (hasLinks) deltaEvidenceHints += 4;
  if (hasNumbers) deltaEvidenceHints += 2;
  if (hasQuotes) deltaEvidenceHints += 2;

  let deltaCoherence = 0;
  if (!lowInfo) deltaCoherence += 8;
  if (avgSentenceLen >= 6 && avgSentenceLen <= 28) deltaCoherence += 5;
  if (sentences >= 2) deltaCoherence += 2;

  let deltaNuance = 0;
  if (hedge >= 1) deltaNuance += Math.min(6, hedge * 2);
  if (certainty >= 3 && !hasLinks) deltaNuance -= 3;

  let deltaSensational = 0;
  if (sensational >= 1) deltaSensational += Math.min(14, sensational * 3);

  let deltaUnsafe = 0;
  if (unsafe >= 1) deltaUnsafe += Math.min(14, unsafe * 4);

  let deltaContradictionRisk = 0;
  if (certainty >= 2 && !hasLinks) deltaContradictionRisk += 4;
  if ((topicPolitics || topicHealth || topicFinance) && certainty >= 1 && !hasLinks) deltaContradictionRisk += 4;

  let deltaLowInfo = 0;
  if (lowInfo) deltaLowInfo += 12;

  let confBoost = 0;
  let confPenalty = 0;

  if (!lowInfo) confBoost += 0.05;
  if (hasLinks) confBoost += 0.06;
  if (hasNumbers) confBoost += 0.02;
  if (hedge >= 1) confBoost += 0.03;

  if (sensational >= 2) confPenalty += 0.06;
  if (unsafe >= 1) confPenalty += 0.08;
  if (certainty >= 3 && !hasLinks) confPenalty += 0.05;
  if (topicHealth && certainty >= 1 && !hasLinks) confPenalty += 0.05;
  if (topicPolitics && certainty >= 1 && !hasLinks) confPenalty += 0.04;

  return {
    len,
    wc,
    lowInfo,
    hasNumbers,
    hasLinks,
    sensational,
    certainty,
    hedge,
    topicPolitics,
    topicHealth,
    topicFinance,
    unsafe,
    deltaCoherence,
    deltaNuance,
    deltaEvidenceHints,
    deltaSensational,
    deltaUnsafe,
    deltaContradictionRisk,
    deltaLowInfo,
    confBoost,
    confPenalty,
  };
}

/* =========================================================
   Reasons & Summary (language-aware, premium tone)
========================================================= */
function buildReasonsStandard(s, lang) {
  const msg = t(lang);
  const out = [];

  if (s.lowInfo) out.push(msg.r_lowInfo);
  if (!s.lowInfo) out.push(msg.r_structured);

  if (s.sensational >= 1) out.push(msg.r_sensational);
  if (s.unsafe >= 1) out.push(msg.r_unsafe);

  if (s.hasLinks) out.push(msg.r_hasLinks);
  else out.push(msg.r_noLinks);

  if (s.hedge >= 1) out.push(msg.r_nuance);

  out.push(msg.r_standardLimit);

  return uniqStrings(out).slice(0, 6);
}

function buildReasonsPro({ s, evidence, claims, timeSensitive }, lang) {
  const msg = t(lang);
  const out = [];

  if (s.lowInfo) out.push(msg.r_lowInfo);
  if (!s.lowInfo) out.push(msg.r_structured);

  if (s.sensational >= 1) out.push(msg.r_sensational);
  if (s.unsafe >= 1) out.push(msg.r_unsafe);

  if (s.hasLinks) out.push(msg.r_hasLinks);
  else out.push(msg.r_noLinks);

  if (s.hedge >= 1) out.push(msg.r_nuance);

  if (claims && claims.length) {
    out.push(msg.r_claimsPicked + " " + claims.map((c) => "• " + safeShort(c, 120)).join(" "));
  }

  if (evidence.enabled) {
    out.push(msg.r_webOn);
    if (evidence.coverage < 0.5) out.push(msg.r_lowCoverage);
    if (evidence.corroboration >= 0.67) out.push(msg.r_corroborated);
    if (evidence.contradiction >= 0.34) out.push(msg.r_contradictions);
    if (evidence.quality >= 0.6) out.push(msg.r_goodSources);
  } else {
    out.push(msg.r_webOff);
    if (timeSensitive) out.push(msg.r_timeSensitiveNeedsWeb);
  }

  return uniqStrings(out).slice(0, 8);
}

function buildProSummary({ score, evidence, timeSensitive }, lang) {
  const msg = t(lang);

  if (!evidence.enabled) {
    return timeSensitive ? msg.proSummaryNoWebTime : msg.proSummaryNoWeb;
  }

  if (score >= 84 && evidence.corroboration >= 0.67 && evidence.contradiction < 0.34) return msg.proSummaryStrong;
  if (evidence.contradiction >= 0.34) return msg.proSummaryMixed;
  if (evidence.coverage < 0.5) return msg.proSummaryPartial;
  return msg.proSummaryModerate;
}

/* =========================================================
   External web provider (Bing)
========================================================= */
function isExternalSearchEnabled() {
  if (!WEB_PROVIDER) return false;
  if (WEB_PROVIDER === "bing" && BING_API_KEY) return true;
  return false;
}

async function bingSearch(query, maxResults) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);

  try {
    const url =
      "https://api.bing.microsoft.com/v7.0/search?q=" +
      encodeURIComponent(query) +
      "&count=" +
      clamp(maxResults, 1, 10);

    const r = await fetch(url, {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
      signal: controller.signal,
    });

    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data?.webPages?.value) ? data.webPages.value : [];

    const results = items.slice(0, maxResults).map((it) => ({
      title: it.name || "",
      url: it.url || "",
      snippet: it.snippet || "",
      source: hostFromUrl(it.url || ""),
    }));

    return { results };
  } finally {
    clearTimeout(to);
  }
}

function cleanAndDedupeSources(items) {
  const out = [];
  const seen = new Set();

  for (const it of items || []) {
    const url = String(it.url || "").trim();
    if (!url) continue;

    if (looksLikeHomepage(url)) continue;

    const key = normalizeUrlForDedupe(url);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      title: safeShort(String(it.title || ""), 140),
      url,
      snippet: safeShort(String(it.snippet || ""), 220),
      source: safeShort(String(it.source || hostFromUrl(url)), 64),
    });

    if (out.length >= 10) break;
  }

  return out;
}

/* =========================================================
   Language + templates (FR/EN/ES/IT/DE/PT/RU/JA + fallback)
========================================================= */
function detectLangVerySimple(text) {
  const t = String(text || "");

  if (/[ぁ-ゟ゠-ヿ一-龯]/.test(t)) return "ja";
  if (/[А-Яа-яЁёІіЇїЄє]/.test(t)) return "ru";

  const lower = t.toLowerCase();

  const frHits = countMatches(lower, [" le ", " la ", " les ", " des ", " une ", " un ", " que ", " quoi ", " est "]);
  const enHits = countMatches(lower, [" the ", " and ", " is ", " are ", " was ", " were ", " what ", " why "]);
  const esHits = countMatches(lower, [" el ", " la ", " los ", " las ", " que ", " es ", " son ", " por "]);
  const itHits = countMatches(lower, [" il ", " lo ", " la ", " che ", " è ", " sono ", " per "]);
  const deHits = countMatches(lower, [" der ", " die ", " das ", " und ", " ist ", " sind "]);
  const ptHits = countMatches(lower, [" o ", " a ", " os ", " as ", " que ", " é ", " são ", " para "]);

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

function t(lang) {
  return TEMPLATES[lang] || TEMPLATES.en;
}

const TEMPLATES = {
  fr: {
    standardSummary:
      "Analyse Standard : estimation prudente basée sur la cohérence, le style et les signaux de risque. Pas de vérification web.",
    proSummaryNoWeb:
      "Analyse PRO : lecture avancée (cohérence + signaux), mais vérification web désactivée — prudence sur les faits.",
    proSummaryNoWebTime:
      "Analyse PRO : contenu potentiellement sensible au temps (dates / fonctions publiques). Sans vérification web, je reste prudent.",
    proSummaryStrong:
      "Analyse PRO : plusieurs sources crédibles semblent corroborer les points clés. Risque faible, bonne fiabilité.",
    proSummaryModerate:
      "Analyse PRO : signaux plutôt bons, et des sources vont dans le même sens. Quelques zones à vérifier.",
    proSummaryPartial:
      "Analyse PRO : peu de couverture web sur les affirmations clés. Résultat utile, mais preuves partielles.",
    proSummaryMixed:
      "Analyse PRO : signaux mixtes — certaines sources semblent contredire ou nuancer des points importants.",
    searchBooster: "source officielle",
    officeWords: ["président", "premier ministre", "chancelier", "roi", "reine"],
    nowWords: ["actuel", "aujourd'hui", "en ce moment", "présentement"],
    r_lowInfo: "Texte trop court / trop vague : difficile d’évaluer sérieusement.",
    r_structured: "Structure globale cohérente (phrases, contexte, continuité).",
    r_sensational: "Présence de formulations sensationnalistes : risque de surinterprétation.",
    r_unsafe: "Présence de signaux “arnaque / manipulation” (urgence, promesses extrêmes).",
    r_hasLinks: "Présence d’indices de preuve (liens / chiffres / citations).",
    r_noLinks: "Peu d’indices de preuve (pas de lien / source explicite).",
    r_nuance: "Langage nuancé (prudence) : souvent plus crédible qu’une certitude totale.",
    r_standardLimit:
      "Standard : je n’affirme aucun fait sans vérification externe — c’est volontaire pour rester fiable.",
    r_claimsPicked: "Affirmations clés détectées :",
    r_webOn: "Vérification web PRO activée : recherche de corroborations / contradictions.",
    r_webOff: "Vérification web PRO désactivée : score basé sur les signaux internes uniquement.",
    r_lowCoverage: "Couverture web limitée : peu de résultats directement pertinents.",
    r_corroborated: "Plusieurs signaux de corroboration détectés via sources.",
    r_contradictions: "Signaux de contradiction/débunk détectés : prudence.",
    r_goodSources: "Qualité de sources globalement solide (domaines reconnus / institutionnels).",
    r_timeSensitiveNeedsWeb:
      "Contenu sensible au temps : idéalement activer la vérification web pour éviter les erreurs “président/année”.",
  },
  en: {
    standardSummary:
      "Standard analysis: conservative estimate based on coherence, style, and risk signals. No web verification.",
    proSummaryNoWeb:
      "PRO analysis: advanced reading (coherence + signals), but web verification is OFF — stay cautious on facts.",
    proSummaryNoWebTime:
      "PRO analysis: time-sensitive content (dates / public roles). Without web verification, I stay conservative.",
    proSummaryStrong:
      "PRO analysis: multiple credible sources appear to support the key claims. Low risk, strong reliability.",
    proSummaryModerate:
      "PRO analysis: solid signals and some sources align. A few points still worth double-checking.",
    proSummaryPartial:
      "PRO analysis: limited web coverage for the key claims. Useful, but evidence is partial.",
    proSummaryMixed:
      "PRO analysis: mixed signals — some sources appear to contradict or heavily nuance key points.",
    searchBooster: "official source",
    officeWords: ["president", "prime minister", "chancellor", "king", "queen"],
    nowWords: ["current", "today", "right now", "currently"],
    r_lowInfo: "Too short / too vague: hard to evaluate seriously.",
    r_structured: "Overall structure is coherent (context, continuity, readable).",
    r_sensational: "Sensational framing detected: higher risk of distortion.",
    r_unsafe: "Scam/manipulation cues detected (urgency, extreme promises).",
    r_hasLinks: "Evidence hints present (links / numbers / quotes).",
    r_noLinks: "Few evidence hints (no explicit sources).",
    r_nuance: "Nuanced language (caution) often correlates with higher credibility.",
    r_standardLimit: "Standard: I do not claim facts without external verification — by design.",
    r_claimsPicked: "Key claims detected:",
    r_webOn: "PRO web verification ON: searching for corroboration/contradictions.",
    r_webOff: "PRO web verification OFF: score based on internal signals only.",
    r_lowCoverage: "Limited web coverage: few directly relevant results found.",
    r_corroborated: "Multiple corroboration signals found across sources.",
    r_contradictions: "Debunk/contradiction signals detected: proceed carefully.",
    r_goodSources: "Overall source quality looks strong (recognized / institutional domains).",
    r_timeSensitiveNeedsWeb:
      "Time-sensitive content: enabling web verification helps avoid errors about roles/dates.",
  },
  es: {
    standardSummary:
      "Análisis Estándar: estimación prudente basada en coherencia, estilo y señales de riesgo. Sin verificación web.",
    proSummaryNoWeb:
      "Análisis PRO: lectura avanzada, pero verificación web desactivada — cautela con los hechos.",
    proSummaryNoWebTime:
      "Análisis PRO: contenido sensible al tiempo (fechas/cargos). Sin web, me mantengo prudente.",
    proSummaryStrong:
      "Análisis PRO: varias fuentes parecen corroborar los puntos clave. Riesgo bajo, buena fiabilidad.",
    proSummaryModerate:
      "Análisis PRO: señales sólidas y algunas fuentes alineadas. Algunos puntos aún requieren verificación.",
    proSummaryPartial:
      "Análisis PRO: cobertura web limitada para las afirmaciones clave. Evidencia parcial.",
    proSummaryMixed:
      "Análisis PRO: señales mixtas — algunas fuentes contradicen o matizan puntos importantes.",
    searchBooster: "fuente oficial",
    officeWords: ["presidente", "primer ministro", "canciller", "rey", "reina"],
    nowWords: ["actual", "hoy", "ahora", "actualmente"],
    r_lowInfo: "Demasiado corto o vago: difícil evaluar con seriedad.",
    r_structured: "Estructura global coherente (contexto y continuidad).",
    r_sensational: "Lenguaje sensacionalista detectado: mayor riesgo.",
    r_unsafe: "Señales de estafa/manipulación (urgencia, promesas extremas).",
    r_hasLinks: "Hay indicios de evidencia (enlaces / números / citas).",
    r_noLinks: "Pocos indicios de evidencia (sin fuentes explícitas).",
    r_nuance: "Lenguaje matizado (cautela) suele ser más creíble.",
    r_standardLimit: "Estándar: no afirmo hechos sin verificación externa.",
    r_claimsPicked: "Afirmaciones clave detectadas:",
    r_webOn: "Verificación web PRO activada: buscando corroboración/contradicciones.",
    r_webOff: "Verificación web PRO desactivada: solo señales internas.",
    r_lowCoverage: "Cobertura web limitada: pocos resultados relevantes.",
    r_corroborated: "Señales de corroboración encontradas en varias fuentes.",
    r_contradictions: "Señales de contradicción/débunk detectadas: cautela.",
    r_goodSources: "Calidad de fuentes sólida (dominios reconocidos/institucionales).",
    r_timeSensitiveNeedsWeb: "Contenido sensible al tiempo: activar web ayuda a evitar errores.",
  },
  it: {
    standardSummary:
      "Analisi Standard: stima prudente basata su coerenza, stile e segnali di rischio. Nessuna verifica web.",
    proSummaryNoWeb:
      "Analisi PRO: lettura avanzata, ma verifica web disattivata — prudenza sui fatti.",
    proSummaryNoWebTime:
      "Analisi PRO: contenuto sensibile al tempo (date/ruoli). Senza web, rimango prudente.",
    proSummaryStrong:
      "Analisi PRO: più fonti credibili sembrano corroborare i punti chiave. Rischio basso, buona affidabilità.",
    proSummaryModerate:
      "Analisi PRO: segnali solidi e alcune fonti allineate. Alcuni punti da ricontrollare.",
    proSummaryPartial:
      "Analisi PRO: copertura web limitata per le affermazioni chiave. Evidenza parziale.",
    proSummaryMixed:
      "Analisi PRO: segnali misti — alcune fonti contraddicono o ridimensionano punti importanti.",
    searchBooster: "fonte ufficiale",
    officeWords: ["presidente", "primo ministro", "cancelliere", "re", "regina"],
    nowWords: ["attuale", "oggi", "adesso", "attualmente"],
    r_lowInfo: "Troppo corto o vago: difficile valutare seriamente.",
    r_structured: "Struttura complessiva coerente (contesto e continuità).",
    r_sensational: "Tono sensazionalista rilevato: rischio più alto.",
    r_unsafe: "Segnali di truffa/manipolazione (urgenza, promesse estreme).",
    r_hasLinks: "Indizi di prova presenti (link / numeri / citazioni).",
    r_noLinks: "Pochi indizi di prova (nessuna fonte esplicita).",
    r_nuance: "Linguaggio sfumato (prudenza) spesso è più credibile.",
    r_standardLimit: "Standard: non dichiaro fatti senza verifica esterna.",
    r_claimsPicked: "Affermazioni chiave rilevate:",
    r_webOn: "Verifica web PRO attiva: cerco conferme/contraddizioni.",
    r_webOff: "Verifica web PRO disattiva: solo segnali interni.",
    r_lowCoverage: "Copertura web limitata: pochi risultati pertinenti.",
    r_corroborated: "Segnali di corroborazione trovati su più fonti.",
    r_contradictions: "Segnali di contraddizione/débunk: prudenza.",
    r_goodSources: "Qualità delle fonti buona (domini riconosciuti/istituzionali).",
    r_timeSensitiveNeedsWeb: "Contenuto sensibile al tempo: meglio attivare la verifica web.",
  },
  de: {
    standardSummary:
      "Standardanalyse: vorsichtige Einschätzung auf Basis von Kohärenz, Stil und Risikosignalen. Keine Web-Prüfung.",
    proSummaryNoWeb:
      "PRO-Analyse: erweiterte Bewertung, aber Web-Prüfung ist AUS — bei Fakten vorsichtig bleiben.",
    proSummaryNoWebTime:
      "PRO-Analyse: zeitkritischer Inhalt (Daten/Ämter). Ohne Web-Prüfung bleibe ich konservativ.",
    proSummaryStrong:
      "PRO-Analyse: mehrere glaubwürdige Quellen stützen die Kernpunkte. Niedriges Risiko, hohe Verlässlichkeit.",
    proSummaryModerate:
      "PRO-Analyse: solide Signale, einige Quellen passen. Ein paar Punkte dennoch prüfen.",
    proSummaryPartial:
      "PRO-Analyse: begrenzte Web-Abdeckung der Kernbehauptungen. Teilweise Evidenz.",
    proSummaryMixed:
      "PRO-Analyse: gemischte Signale — einige Quellen widersprechen oder relativieren stark.",
    searchBooster: "offizielle quelle",
    officeWords: ["präsident", "kanzler", "premierminister", "könig", "königin"],
    nowWords: ["aktuell", "heute", "jetzt", "derzeit"],
    r_lowInfo: "Zu kurz/zu vage: seriöse Bewertung schwierig.",
    r_structured: "Insgesamt kohärent (Kontext, Kontinuität, Lesbarkeit).",
    r_sensational: "Sensationaler Ton erkannt: höheres Verzerrungsrisiko.",
    r_unsafe: "Betrug/Manipulationssignale (Dringlichkeit, extreme Versprechen).",
    r_hasLinks: "Hinweise auf Belege vorhanden (Links/Zahlen/Zitate).",
    r_noLinks: "Kaum Belege (keine expliziten Quellen).",
    r_nuance: "Nuancierte Sprache (Vorsicht) ist oft glaubwürdiger.",
    r_standardLimit: "Standard: Ohne externe Prüfung behaupte ich keine Fakten.",
    r_claimsPicked: "Erkannte Kernbehauptungen:",
    r_webOn: "PRO Web-Prüfung AN: Suche nach Bestätigung/Widerspruch.",
    r_webOff: "PRO Web-Prüfung AUS: Bewertung nur anhand interner Signale.",
    r_lowCoverage: "Begrenzte Web-Abdeckung: wenige passende Treffer.",
    r_corroborated: "Mehrere Bestätigungssignale über Quellen hinweg.",
    r_contradictions: "Widerspruch/Débunk-Signale erkannt: Vorsicht.",
    r_goodSources: "Quellenqualität wirkt solide (bekannt/institutionell).",
    r_timeSensitiveNeedsWeb: "Zeitkritischer Inhalt: Web-Prüfung hilft Fehler zu vermeiden.",
  },
  pt: {
    standardSummary:
      "Análise Standard: estimativa cautelosa baseada em coerência, estilo e sinais de risco. Sem verificação web.",
    proSummaryNoWeb:
      "Análise PRO: leitura avançada, mas verificação web desligada — cautela com fatos.",
    proSummaryNoWebTime:
      "Análise PRO: conteúdo sensível ao tempo (datas/cargos). Sem web, permaneço prudente.",
    proSummaryStrong:
      "Análise PRO: várias fontes confiáveis parecem corroborar os pontos-chave. Baixo risco, boa confiabilidade.",
    proSummaryModerate:
      "Análise PRO: sinais sólidos e algumas fontes alinhadas. Alguns pontos ainda merecem checagem.",
    proSummaryPartial:
      "Análise PRO: cobertura web limitada para as afirmações-chave. Evidência parcial.",
    proSummaryMixed:
      "Análise PRO: sinais mistos — algumas fontes contradizem ou nuançam fortemente.",
    searchBooster: "fonte oficial",
    officeWords: ["presidente", "primeiro-ministro", "chanceler", "rei", "rainha"],
    nowWords: ["atual", "hoje", "agora", "atualmente"],
    r_lowInfo: "Muito curto ou vago: difícil avaliar com seriedade.",
    r_structured: "Estrutura geral coerente (contexto e continuidade).",
    r_sensational: "Tom sensacionalista detectado: maior risco.",
    r_unsafe: "Sinais de golpe/manipulação (urgência, promessas extremas).",
    r_hasLinks: "Indícios de evidência (links / números / citações).",
    r_noLinks: "Poucos indícios de evidência (sem fontes explícitas).",
    r_nuance: "Linguagem cautelosa (nuance) tende a ser mais crível.",
    r_standardLimit: "Standard: não afirmo fatos sem verificação externa.",
    r_claimsPicked: "Afirmações-chave detectadas:",
    r_webOn: "Verificação web PRO ativa: buscando corroborar/contradizer.",
    r_webOff: "Verificação web PRO desativada: apenas sinais internos.",
    r_lowCoverage: "Cobertura web limitada: poucos resultados pertinentes.",
    r_corroborated: "Sinais de corroboração em múltiplas fontes.",
    r_contradictions: "Sinais de contradição/débunk: cautela.",
    r_goodSources: "Boa qualidade geral de fontes (domínios reconhecidos/institucionais).",
    r_timeSensitiveNeedsWeb: "Conteúdo sensível ao tempo: melhor ativar verificação web.",
  },
  ru: {
    standardSummary:
      "Стандартный анализ: осторожная оценка по связности, стилю и сигналам риска. Без веб-проверки.",
    proSummaryNoWeb:
      "PRO-анализ: расширенная оценка, но веб-проверка выключена — осторожно с фактами.",
    proSummaryNoWebTime:
      "PRO-анализ: контент чувствителен ко времени (даты/должности). Без веб-проверки я осторожен.",
    proSummaryStrong:
      "PRO-анализ: несколько источников выглядят как подтверждение ключевых тезисов. Низкий риск, высокая надежность.",
    proSummaryModerate:
      "PRO-анализ: хорошие сигналы и часть источников совпадает. Некоторые пункты стоит перепроверить.",
    proSummaryPartial:
      "PRO-анализ: слабое покрытие веб-источниками по ключевым тезисам. Доказательства частичные.",
    proSummaryMixed:
      "PRO-анализ: смешанные сигналы — есть источники, которые противоречат или сильно уточняют.",
    searchBooster: "официальный источник",
    officeWords: ["президент", "премьер-министр", "канцлер", "король", "королева"],
    nowWords: ["сейчас", "сегодня", "в настоящее время", "актуально"],
    r_lowInfo: "Слишком коротко/расплывчато: сложно оценивать серьезно.",
    r_structured: "В целом текст связный и читаемый (контекст, логика).",
    r_sensational: "Обнаружен сенсационный тон: повышенный риск искажений.",
    r_unsafe: "Сигналы мошенничества/манипуляции (срочность, экстремальные обещания).",
    r_hasLinks: "Есть признаки доказательств (ссылки/цифры/цитаты).",
    r_noLinks: "Мало признаков доказательств (нет явных источников).",
    r_nuance: "Осторожная/нюансированная подача часто выглядит надежнее.",
    r_standardLimit: "Standard: без внешней проверки я не утверждаю факты.",
    r_claimsPicked: "Ключевые утверждения:",
    r_webOn: "PRO веб-проверка включена: ищу подтверждения/опровержения.",
    r_webOff: "PRO веб-проверка выключена: только внутренние сигналы.",
    r_lowCoverage: "Ограниченное покрытие: мало релевантных результатов.",
    r_corroborated: "Найдены сигналы подтверждения по нескольким источникам.",
    r_contradictions: "Обнаружены сигналы опровержения/дебанка: осторожно.",
    r_goodSources: "Качество источников выглядит хорошим (известные/институциональные домены).",
    r_timeSensitiveNeedsWeb: "Чувствительно ко времени: лучше включить веб-проверку.",
  },
  ja: {
    standardSummary:
      "標準分析：文章の整合性・文体・リスク信号に基づく慎重な推定。Web検証なし。",
    proSummaryNoWeb:
      "PRO分析：高度な読み取りだが、Web検証がOFF。事実は慎重に扱う。",
    proSummaryNoWebTime:
      "PRO分析：日付/公的役職など“時系列に敏感”な内容。Web検証なしでは保守的に評価。",
    proSummaryStrong:
      "PRO分析：複数の信頼できそうな情報源が主要点を支持している可能性。低リスク。",
    proSummaryModerate:
      "PRO分析：良い信号＋一部の情報源が一致。いくつかは要再確認。",
    proSummaryPartial:
      "PRO分析：主要主張のWebカバレッジが限定的。証拠は部分的。",
    proSummaryMixed:
      "PRO分析：信号が混在。重要点に反証/強い補足が見られる可能性。",
    searchBooster: "公式 情報源",
    officeWords: ["大統領", "首相", "首相", "王", "女王"],
    nowWords: ["現在", "今日", "今", "いま"],
    r_lowInfo: "短すぎる/曖昧：真剣な評価が難しい。",
    r_structured: "全体として整合性がある（文脈・連続性）。",
    r_sensational: "扇情的な表現：誤解や誇張のリスク。",
    r_unsafe: "詐欺/操作の兆候（緊急性、極端な約束）。",
    r_hasLinks: "根拠の手掛かり（リンク/数字/引用）がある。",
    r_noLinks: "根拠の手掛かりが少ない（明示的な情報源なし）。",
    r_nuance: "慎重で含みのある表現は信頼性が高い傾向。",
    r_standardLimit: "標準：外部検証なしに事実断定はしない（信頼性のため）。",
    r_claimsPicked: "主要な主張を抽出：",
    r_webOn: "PRO Web検証ON：支持/反証を探索。",
    r_webOff: "PRO Web検証OFF：内部信号のみで評価。",
    r_lowCoverage: "Webカバレッジが低い：直接関係する結果が少ない。",
    r_corroborated: "複数ソースで支持の兆候。",
    r_contradictions: "反証/デバンクの兆候：注意。",
    r_goodSources: "ソース品質が良好（著名/公的ドメイン）。",
    r_timeSensitiveNeedsWeb: "時系列に敏感：Web検証ONが推奨。",
  },
};

/* =========================================================
   Dictionaries (light + multi-language)
========================================================= */
function sensationalWords(lang) {
  const base = {
    en: ["shocking", "unbelievable", "they don't want you to know", "mind-blowing", "exclusive", "secret", "viral"],
    fr: ["incroyable", "choquant", "ils veulent pas que", "secret", "révélé", "viral"],
    es: ["increíble", "impactante", "no quieren que sepas", "secreto", "viral"],
    it: ["incredibile", "scioccante", "non vogliono che tu sappia", "segreto", "virale"],
    de: ["unglaublich", "schockierend", "sie wollen nicht dass du weißt", "geheim", "viral"],
    pt: ["incrível", "chocante", "não querem que você saiba", "secreto", "viral"],
    ru: ["шок", "невероятно", "они не хотят", "секрет", "вирус"],
    ja: ["衝撃", "信じられない", "秘密", "暴露", "拡散"],
  };
  return base[lang] || base.en;
}

function certaintyWords(lang) {
  const base = {
    en: ["always", "never", "definitely", "proven", "100%", "undeniable", "guaranteed"],
    fr: ["toujours", "jamais", "certainement", "prouvé", "100%", "garanti"],
    es: ["siempre", "nunca", "definitivamente", "probado", "100%", "garantizado"],
    it: ["sempre", "mai", "definitivamente", "provato", "100%", "garantito"],
    de: ["immer", "nie", "definitiv", "bewiesen", "100%", "garantiert"],
    pt: ["sempre", "nunca", "definitivamente", "provado", "100%", "garantido"],
    ru: ["всегда", "никогда", "точно", "доказано", "100%", "гарантировано"],
    ja: ["必ず", "絶対", "確実", "証明", "100%", "保証"],
  };
  return base[lang] || base.en;
}

function hedgeWords(lang) {
  const base = {
    en: ["maybe", "might", "could", "seems", "likely", "unclear", "reportedly"],
    fr: ["peut-être", "pourrait", "semble", "probable", "incertain", "selon"],
    es: ["quizá", "podría", "parece", "probable", "incierto", "según"],
    it: ["forse", "potrebbe", "sembra", "probabile", "incerto", "secondo"],
    de: ["vielleicht", "könnte", "scheint", "wahrscheinlich", "unklar", "laut"],
    pt: ["talvez", "poderia", "parece", "provável", "incerto", "segundo"],
    ru: ["возможно", "может", "кажется", "вероятно", "неясно", "по данным"],
    ja: ["たぶん", "かもしれない", "可能性", "不明", "報道によると", "〜のようだ"],
  };
  return base[lang] || base.en;
}

function unsafeWords(lang) {
  const base = {
    en: ["urgent", "act now", "limited time", "guaranteed profit", "send money", "wire transfer", "crypto giveaway"],
    fr: ["urgent", "agissez", "temps limité", "profit garanti", "envoyez", "virement", "giveaway crypto"],
    es: ["urgente", "actúa", "tiempo limitado", "ganancia garantizada", "envía dinero", "transferencia"],
    it: ["urgente", "agisci", "tempo limitato", "profitto garantito", "invia denaro", "bonifico"],
    de: ["dringend", "jetzt handeln", "begrenzte zeit", "garantierter gewinn", "geld senden", "überweisung"],
    pt: ["urgente", "aja", "tempo limitado", "lucro garantido", "envie dinheiro", "transferência"],
    ru: ["срочно", "действуй", "ограничено", "гарантированная прибыль", "отправь деньги", "перевод"],
    ja: ["緊急", "今すぐ", "期間限定", "利益保証", "送金", "振込"],
  };
  return base[lang] || base.en;
}

function contradictionWords(lang) {
  const base = {
    en: ["false", "hoax", "debunk", "misleading", "not true", "fact check", "fabricated"],
    fr: ["faux", "canular", "démenti", "trompeur", "pas vrai", "fact-check", "vérification des faits"],
    es: ["falso", "bulo", "desmentido", "engañoso", "no es cierto", "verificación"],
    it: ["falso", "bufala", "smentito", "fuorviante", "non è vero", "fact-check"],
    de: ["falsch", "schwindel", "widerlegt", "irreführend", "nicht wahr", "faktencheck"],
    pt: ["falso", "boato", "desmentido", "enganoso", "não é verdade", "checagem"],
    ru: ["ложь", "фейк", "опроверг", "вводит в заблуждение", "неправда", "фактчекинг"],
    ja: ["誤り", "デマ", "否定", "誤解を招く", "事実確認", "虚偽"],
  };
  return base[lang] || base.en;
}

function topicKeywords(lang, topic) {
  const dict = {
    politics: {
      en: ["president", "election", "senate", "government", "prime minister", "white house"],
      fr: ["président", "élection", "sénat", "gouvernement", "premier ministre"],
      es: ["presidente", "elección", "senado", "gobierno", "primer ministro"],
      it: ["presidente", "elezione", "senato", "governo", "primo ministro"],
      de: ["präsident", "wahl", "senat", "regierung", "kanzler"],
      pt: ["presidente", "eleição", "senado", "governo", "primeiro-ministro"],
      ru: ["президент", "выборы", "сенат", "правительство", "премьер-министр"],
      ja: ["大統領", "選挙", "政府", "首相", "ホワイトハウス"],
    },
    health: {
      en: ["cancer", "vaccine", "virus", "cure", "health", "doctor", "who", "cdc"],
      fr: ["cancer", "vaccin", "virus", "guérir", "santé", "médecin", "oms"],
      es: ["cáncer", "vacuna", "virus", "curar", "salud", "médico", "oms"],
      it: ["cancro", "vaccino", "virus", "cura", "salute", "medico", "oms"],
      de: ["krebs", "impfstoff", "virus", "heilung", "gesundheit", "arzt"],
      pt: ["câncer", "vacina", "vírus", "cura", "saúde", "médico"],
      ru: ["рак", "вакцина", "вирус", "лечение", "здоровье", "врач"],
      ja: ["がん", "ワクチン", "ウイルス", "治療", "健康", "医師"],
    },
    finance: {
      en: ["bitcoin", "stocks", "profit", "investment", "market", "bank", "interest rate"],
      fr: ["bitcoin", "actions", "profit", "investissement", "marché", "banque", "taux"],
      es: ["bitcoin", "acciones", "ganancia", "inversión", "mercado", "banco", "tasa"],
      it: ["bitcoin", "azioni", "profitto", "investimento", "mercato", "banca", "tasso"],
      de: ["bitcoin", "aktien", "gewinn", "investition", "markt", "bank", "zins"],
      pt: ["bitcoin", "ações", "lucro", "investimento", "mercado", "banco", "taxa"],
      ru: ["биткоин", "акции", "прибыль", "инвестиции", "рынок", "банк", "ставка"],
      ja: ["ビットコイン", "株", "利益", "投資", "市場", "銀行", "金利"],
    },
  };
  return (dict[topic] && (dict[topic][lang] || dict[topic].en)) || [];
}

/* =========================================================
   Cache (tiny LRU-ish)
========================================================= */
const CACHE = new Map(); // key -> { value, exp, last }
function cacheGet(key) {
  const it = CACHE.get(key);
  if (!it) return null;
  if (it.exp < nowMs()) {
    CACHE.delete(key);
    return null;
  }
  it.last = nowMs();
  return it.value;
}
function cacheSet(key, value) {
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

/* =========================================================
   Rate limiting (per IP per minute bucket)
========================================================= */
const RATE = new Map(); // key -> { count, resetMs }
function rateLimitCheck(req, isPro) {
  const ip = getIp(req);
  const limit = isPro ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const bucket = Math.floor(nowMs() / 60000);
  const key = `${ip}:${bucket}:${isPro ? "pro" : "std"}`;

  const resetMs = (bucket + 1) * 60000;
  const cur = RATE.get(key) || { count: 0, resetMs };
  cur.count += 1;
  cur.resetMs = resetMs;
  RATE.set(key, cur);

  const remaining = Math.max(0, limit - cur.count);
  return { ok: cur.count <= limit, limit, remaining, resetMs: cur.resetMs };
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
  return normalizeSpaces(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff\u3040-\u30ff\u4e00-\u9faf]+/g, " ")
    .trim();
}
function bagOfWords(text, lang) {
  const t = String(text || "").toLowerCase();
  const tokens = t
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u0400-\u04ff\u3040-\u30ff\u4e00-\u9faf]+/g, " ")
    .split(" ")
    .filter((x) => x && x.length >= 3);
  const out = new Set();
  for (const tok of tokens.slice(0, 80)) out.add(tok);
  return out;
}
function tokenOverlapRatio(aSet, bSet) {
  if (!aSet || !bSet || !aSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter += 1;
  return inter / Math.max(1, aSet.size);
}
function getIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "0.0.0.0";
}
function isProbablyProMode(mode) {
  return ["pro", "premium", "premium_plus", "premiumplus", "plus"].includes(String(mode || "").toLowerCase());
}
function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
function looksLikeHomepage(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname || "").replace(/\/+$/, "");
    if (!path || path === "" || path === "/") return true;
    if (["/home", "/news", "/latest", "/index"].includes(path)) return true;
    return false;
  } catch {
    return false;
  }
}
function normalizeUrlForDedupe(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    drop.forEach((k) => u.searchParams.delete(k));
    return (u.origin + u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "")).toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

/* -------------------------------
   Start server
-------------------------------- */
app.listen(PORT, () => {
  console.log(`[IA11] listening on :${PORT} (v${VERSION})`);
});
