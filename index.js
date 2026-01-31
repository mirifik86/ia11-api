/**
 * IA11 API (LeenScore) — index.js (Ultra PRO Global)
 *
 * Goals:
 * - Keep the SAME response contract v1 used by LeenScore
 * - Safer + more reliable scoring (multi-signal)
 * - PRO can do real multi-source web verification (optional, via provider keys)
 * - Strong guardrails: if external search is OFF, IA11 stays conservative (no confident “facts”)
 * - Output language matches detected language (FR/EN/ES/IT/DE/PT/RU/JA + fallback)
 *
 * Response contract v1:
 * { status, requestId, engine, mode,
 *   result{ score, riskLevel, summary, reasons, confidence, sources[] },
 *   meta{ tookMs, version, cached?, externalSearchEnabled?, provider? }
 * }
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

/* -------------------------------
   Config
-------------------------------- */
const PORT = process.env.PORT || 3000;

const ENGINE_NAME = "IA11";
const VERSION = "2.0.0";

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
const CACHE_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS || 500);

// Rate limits (per minute)
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

// External web verification (PRO)
// WEB_PROVIDER: "serper" | "tavily" | "bing"
const WEB_PROVIDER = String(process.env.WEB_PROVIDER || "").trim().toLowerCase();
const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim(); // serper.dev
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || "").trim(); // tavily.com
const BING_API_KEY = (process.env.BING_API_KEY || "").trim(); // Azure Bing Search v7
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 7000);
const WEB_MAX_RESULTS = Number(process.env.WEB_MAX_RESULTS || 6);

/* -------------------------------
   App middleware
-------------------------------- */
app.use(express.json({ limit: JSON_LIMIT }));

app.use(
  cors({
    origin: function (origin, cb) {
      if (!CORS_ORIGINS.length) return cb(null, true);
      if (!origin) return cb(null, true);
      return CORS_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("CORS blocked"), false);
    },
  })
);

/* -------------------------------
   Health + Info
-------------------------------- */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: VERSION,
    message: "IA11 online. Use POST /v1/analyze",
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: VERSION,
    message: "Use POST /v1/analyze with header x-ia11-key and JSON body { text, mode }.",
  });
});

/* -------------------------------
   Main analyze
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
  const text = safeTrimText(req.body?.text || "");
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

  // Cache (lang included because output text changes)
  const cacheKey = `${isPro ? "pro" : "standard"}::${lang}::${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json({
      ...cached,
      requestId,
      meta: {
        ...(cached.meta || {}),
        tookMs: nowMs() - t0,
        version: VERSION,
        cached: true,
      },
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
    },
  };

  cacheSet(cacheKey, response);
  return res.json(response);
});

/* -------------------------------
   ANALYSIS — Standard (conservative)
-------------------------------- */
async function analyzeStandard(text, lang) {
  const s = computeSignals(text, lang);

  // Standard never pretends to have confirmed facts.
  // It scores coherence + safety signals only.
  const base = 58;
  const score = clamp(
    Math.round(
      base +
        s.deltaCoherence +
        s.deltaStyle -
        s.deltaSensational -
        s.deltaContradictionRisk -
        s.deltaLowInfo
    ),
    5,
    98
  );

  const riskLevel = score >= 80 ? "low" : score >= 55 ? "medium" : "high";
  const confidence = clamp(0.62 + s.confBoostStandard - s.confPenalty, 0.12, 0.88);

  const msg = t(lang);
  return {
    score,
    riskLevel,
    summary: msg.standardSummary,
    reasons: buildReasonsStandard(s, lang),
    confidence,
    sources: [],
  };
}

/* -------------------------------
   ANALYSIS — PRO (global + multi-source optional)
-------------------------------- */
async function analyzePro(text, lang, ctx) {
  const msg = t(lang);
  const s = computeSignals(text, lang);

  // Two-pass: extract key claims, then verify with web (if enabled)
  const claims = extractClaims(text, lang);
  const query = buildQueryFromClaims(claims, text);

  let sources = [];
  let verification = {
    corroborations: 0,
    contradictions: 0,
    neutral: 0,
    notes: [],
  };

  if (ctx.externalSearchEnabled && query) {
    const web = await safeWebSearch(query, WEB_MAX_RESULTS);
    sources = cleanAndDedupeSources(web.results || []);

    verification = compareClaimsToSources(claims, sources, lang);
  } else {
    // No external search => do NOT “assert” facts. Stay cautious.
    verification.notes.push(msg.noExternalSearchNote);
  }

  // Hard guardrail: if text is about official roles / “president/PM” + current year,
  // and we cannot do external verification, force conservative confidence.
  const currentYear = new Date().getUTCFullYear();
  const hasOfficialRoleNow = s.topicPolitics && mentionsOfficialRole(text, lang) && mentionsYear(text, currentYear);
  const noExternal = !ctx.externalSearchEnabled;

  // Scoring: base + coherence + style + verified corroborations - contradictions - risk
  let score =
    70 +
    s.deltaCoherence +
    s.deltaStyle -
    s.deltaSensational -
    s.deltaContradictionRisk -
    s.deltaLowInfo;

  // Verification impact (only if external search is ON)
  if (ctx.externalSearchEnabled) {
    score += verification.corroborations * 6;
    score -= verification.contradictions * 10;
    score += verification.neutral * 1;
  } else {
    // No sources: remove “confidence inflation”
    score -= 6;
  }

  // Extra caution for high-risk topics
  if (s.topicHealth) score -= 5;
  if (s.topicFinance) score -= 4;
  if (s.topicPolitics) score -= 3;

  // Clamp
  score = clamp(Math.round(score), 5, 98);

  // Risk
  let riskLevel = "medium";
  if (verification.contradictions >= 2) riskLevel = "high";
  else if (score >= 84 && verification.contradictions === 0) riskLevel = "low";
  else if (score < 55) riskLevel = "high";

  // Confidence
  let confidence =
    0.78 +
    s.confBoostPro -
    s.confPenalty +
    (ctx.externalSearchEnabled ? verification.corroborations * 0.03 - verification.contradictions * 0.07 : -0.1);

  if (hasOfficialRoleNow && noExternal) confidence = Math.min(confidence, 0.48);
  confidence = clamp(confidence, 0.12, 0.98);

  // Summary (language-native)
  const summary = buildSummaryPro({ score, riskLevel, verification, ctx, s, lang });

  const reasons = buildReasonsPro({ s, verification, ctx, lang, hasOfficialRoleNow });

  return {
    score,
    riskLevel,
    summary,
    reasons,
    confidence,
    sources: sources.slice(0, 8),
  };
}

/* -------------------------------
   Signals + scoring helpers
-------------------------------- */
function computeSignals(text, lang) {
  const clean = text.replace(/\s+/g, " ").trim();
  const len = clean.length;

  const hasNumbers = /\d/.test(clean);
  const hasLinks = /(https?:\/\/|www\.)/i.test(clean);
  const hasQuotes = /["“”'’]/.test(clean);
  const hasQuestion = /\?/.test(clean);

  const lowInfo = len < 60 || wordCount(clean) < 10;

  // “Sensational” words (multi-language light lists)
  const sensational = countMatches(clean.toLowerCase(), sensationalWords(lang));
  const certainty = countMatches(clean.toLowerCase(), certaintyWords(lang));
  const hedge = countMatches(clean.toLowerCase(), hedgeWords(lang));

  // Coherence: punctuation balance + sentence-ish structure
  const sentences = Math.max(1, clean.split(/[.!?]+/).filter(Boolean).length);
  const avgSentenceLen = Math.max(1, Math.round(wordCount(clean) / sentences));

  // Topic detection
  const topicPolitics = topicMatch(clean, lang, topicKeywords(lang, "politics"));
  const topicHealth = topicMatch(clean, lang, topicKeywords(lang, "health"));
  const topicFinance = topicMatch(clean, lang, topicKeywords(lang, "finance"));

  // Deltas (tunable but stable)
  let deltaCoherence = 0;
  if (!lowInfo) deltaCoherence += 6;
  if (avgSentenceLen >= 6 && avgSentenceLen <= 28) deltaCoherence += 4;
  if (hasNumbers) deltaCoherence += 2;
  if (hasQuotes) deltaCoherence += 1;
  if (hasLinks) deltaCoherence += 2;

  let deltaStyle = 0;
  if (hedge > 0) deltaStyle += 2; // cautious language is often more credible
  if (hasQuestion) deltaStyle += 1;

  let deltaSensational = 0;
  if (sensational >= 1) deltaSensational += Math.min(10, sensational * 3);

  // Contradiction risk: “absolute certainty” without sources, or political/health claims with certainty
  let deltaContradictionRisk = 0;
  if (certainty >= 2 && !hasLinks) deltaContradictionRisk += 4;
  if ((topicPolitics || topicHealth) && certainty >= 1 && !hasLinks) deltaContradictionRisk += 3;

  let deltaLowInfo = 0;
  if (lowInfo) deltaLowInfo += 10;

  // Confidence shaping
  let confPenalty = 0;
  if (lowInfo) confPenalty += 0.15;
  if (sensational >= 2) confPenalty += 0.12;
  if ((topicHealth || topicPolitics) && !hasLinks) confPenalty += 0.08;

  let confBoostStandard = 0;
  if (!lowInfo) confBoostStandard += 0.06;

  let confBoostPro = 0;
  if (!lowInfo) confBoostPro += 0.08;
  if (hasLinks) confBoostPro += 0.04;

  return {
    len,
    lowInfo,
    hasNumbers,
    hasLinks,
    hasQuotes,
    sensational,
    certainty,
    hedge,
    sentences,
    avgSentenceLen,
    topicPolitics,
    topicHealth,
    topicFinance,
    deltaCoherence,
    deltaStyle,
    deltaSensational,
    deltaContradictionRisk,
    deltaLowInfo,
    confPenalty,
    confBoostStandard,
    confBoostPro,
  };
}

function extractClaims(text, lang) {
  // Very light claim extraction: split into sentences, keep the “assertive” ones
  const clean = text.replace(/\s+/g, " ").trim();
  const parts = clean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    if (p.length < 12) continue;
    if (p.length > 240) continue;
    // Skip pure questions
    if (/\?\s*$/.test(p)) continue;

    // If sentence has a subject-ish capital or a named entity-ish token, keep it
    const hasCapital = /[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+/.test(p);
    const hasNumber = /\d/.test(p);
    const hasRole = mentionsOfficialRole(p, lang);

    if (hasCapital || hasNumber || hasRole) out.push(p);
    if (out.length >= 5) break;
  }

  // Fallback: if nothing extracted, return first chunk
  if (!out.length && clean.length > 0) out.push(clean.slice(0, 200));

  return out;
}

function buildQueryFromClaims(claims, text) {
  const c = (claims || []).slice(0, 3).join(" ");
  const q = (c || text || "").replace(/\s+/g, " ").trim();
  // Keep query reasonable
  return q.length > 240 ? q.slice(0, 240) : q;
}

function compareClaimsToSources(claims, sources, lang) {
  // Heuristic comparison: look for overlapping keywords between claims and snippets/titles
  const msg = t(lang);
  const cl = (claims || []).map((c) => c.toLowerCase());

  let corroborations = 0;
  let contradictions = 0;
  let neutral = 0;

  const notes = [];

  const contradictionMarkers = contradictionWords(lang);
  const supportMarkers = supportWords(lang);

  for (const src of sources || []) {
    const hay = `${src.title || ""} ${src.snippet || ""}`.toLowerCase();

    let hit = 0;
    for (const c of cl) {
      const keys = keywordize(c).slice(0, 8);
      const overlap = keys.filter((k) => k.length >= 4 && hay.includes(k)).length;
      if (overlap >= 2) hit++;
    }

    if (hit === 0) {
      neutral++;
      continue;
    }

    const hasContradict = contradictionMarkers.some((w) => hay.includes(w));
    const hasSupport = supportMarkers.some((w) => hay.includes(w));

    if (hasContradict && !hasSupport) contradictions++;
    else corroborations++;
  }

  if (corroborations === 0 && contradictions === 0) {
    notes.push(msg.verificationWeakNote);
  }

  return { corroborations, contradictions, neutral, notes };
}

/* -------------------------------
   PRO summaries + reasons
-------------------------------- */
function buildSummaryPro({ score, riskLevel, verification, ctx, s, lang }) {
  const msg = t(lang);

  const v = verification || { corroborations: 0, contradictions: 0, neutral: 0, notes: [] };

  if (!ctx.externalSearchEnabled) {
    return msg.proSummaryNoExternal(score, riskLevel);
  }

  if (v.contradictions >= 2) return msg.proSummaryContradictions(score);
  if (v.corroborations >= 2 && v.contradictions === 0) return msg.proSummaryStrong(score);
  if (v.corroborations >= 1 && v.contradictions === 0) return msg.proSummarySome(score);

  // No clear verification
  return msg.proSummaryUnclear(score, riskLevel);
}

function buildReasonsStandard(s, lang) {
  const msg = t(lang);
  const reasons = [];

  reasons.push(msg.standardReasonCoherence);

  if (s.lowInfo) reasons.push(msg.reasonLowInfo);
  if (s.sensational >= 2) reasons.push(msg.reasonSensational);
  if (s.topicHealth) reasons.push(msg.reasonHealthCaution);
  if (s.topicPolitics) reasons.push(msg.reasonPoliticsCaution);

  reasons.push(msg.standardReasonNoMultiSource);

  return uniqKeepOrder(reasons).slice(0, 5);
}

function buildReasonsPro({ s, verification, ctx, lang, hasOfficialRoleNow }) {
  const msg = t(lang);
  const reasons = [];

  reasons.push(msg.proReasonSignals);

  if (ctx.externalSearchEnabled) {
    const v = verification || { corroborations: 0, contradictions: 0, neutral: 0, notes: [] };
    if (v.corroborations >= 1) reasons.push(msg.proReasonCorroboration(v.corroborations));
    if (v.contradictions >= 1) reasons.push(msg.proReasonContradiction(v.contradictions));
    if (v.corroborations === 0 && v.contradictions === 0) reasons.push(msg.proReasonWeakVerification);
  } else {
    reasons.push(msg.proReasonNoExternal);
  }

  if (s.sensational >= 2) reasons.push(msg.reasonSensational);
  if (s.lowInfo) reasons.push(msg.reasonLowInfo);

  if (s.topicHealth) reasons.push(msg.reasonHealthCaution);
  if (s.topicPolitics) reasons.push(msg.reasonPoliticsCaution);

  if (hasOfficialRoleNow && !ctx.externalSearchEnabled) reasons.push(msg.reasonOfficialRoleNeedsSources);

  return uniqKeepOrder(reasons).slice(0, 6);
}

/* -------------------------------
   External Search (optional)
-------------------------------- */
function isExternalSearchEnabled() {
  if (!WEB_PROVIDER) return false;
  if (WEB_PROVIDER === "serper") return !!SERPER_API_KEY;
  if (WEB_PROVIDER === "tavily") return !!TAVILY_API_KEY;
  if (WEB_PROVIDER === "bing") return !!BING_API_KEY;
  return false;
}

async function safeWebSearch(query, maxResults) {
  const q = String(query || "").trim();
  if (!q) return { results: [] };

  try {
    if (WEB_PROVIDER === "serper") return await serperSearch(q, maxResults);
    if (WEB_PROVIDER === "tavily") return await tavilySearch(q, maxResults);
    if (WEB_PROVIDER === "bing") return await bingSearch(q, maxResults);
    return { results: [] };
  } catch (e) {
    return { results: [] };
  }
}

async function serperSearch(query, maxResults) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);

  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: clamp(Number(maxResults || 6), 1, 10) }),
      signal: controller.signal,
    });

    const data = await r.json().catch(() => ({}));
    const organic = Array.isArray(data?.organic) ? data.organic : [];

    const results = organic.slice(0, maxResults).map((it) => ({
      title: it.title || "",
      url: it.link || "",
      snippet: it.snippet || "",
      source: hostFromUrl(it.link || ""),
    }));

    return { results };
  } finally {
    clearTimeout(to);
  }
}

async function tavilySearch(query, maxResults) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);

  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: clamp(Number(maxResults || 6), 1, 10),
        include_answer: false,
        include_images: false,
      }),
      signal: controller.signal,
    });

    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data?.results) ? data.results : [];

    const results = items.slice(0, maxResults).map((it) => ({
      title: it.title || "",
      url: it.url || "",
      snippet: it.content || it.snippet || "",
      source: hostFromUrl(it.url || ""),
    }));

    return { results };
  } finally {
    clearTimeout(to);
  }
}

async function bingSearch(query, maxResults) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);

  try {
    const url =
      "https://api.bing.microsoft.com/v7.0/search?q=" + encodeURIComponent(query) + "&count=" + clamp(maxResults, 1, 10);

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

    // Avoid obvious homepages (keeps credibility: go to the real article)
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

/* -------------------------------
   Language + templates
-------------------------------- */
function detectLangVerySimple(text) {
  const t = String(text || "");

  // Detect Japanese (hiragana/katakana/kanji)
  if (/[ぁ-ゟ゠-ヿ一-龯]/.test(t)) return "ja";

  // Detect Cyrillic (Russian / Ukrainian etc.)
  if (/[А-Яа-яЁёІіЇїЄє]/.test(t)) return "ru";

  const lower = t.toLowerCase();

  // Very light heuristics for Latin languages
  const frHits = countMatches(lower, [" le ", " la ", " les ", " des ", " une ", " un ", " je ", " tu ", " pas ", " est "]);
  const enHits = countMatches(lower, [" the ", " and ", " is ", " are ", " was ", " were ", " not ", " you ", " i "]);
  const esHits = countMatches(lower, [" el ", " la ", " los ", " las ", " que ", " y ", " no ", " es ", " un ", " una "]);
  const itHits = countMatches(lower, [" il ", " lo ", " la ", " che ", " e ", " non ", " è ", " un ", " una "]);
  const deHits = countMatches(lower, [" der ", " die ", " das ", " und ", " ist ", " nicht ", " ein ", " eine "]);
  const ptHits = countMatches(lower, [" o ", " a ", " os ", " as ", " que ", " e ", " não ", " é ", " um ", " uma "]);

  const best = [
    { l: "fr", v: frHits },
    { l: "en", v: enHits },
    { l: "es", v: esHits },
    { l: "it", v: itHits },
    { l: "de", v: deHits },
    { l: "pt", v: ptHits },
  ].sort((a, b) => b.v - a.v)[0];

  return best && best.v >= 2 ? best.l : "en";
}

function t(lang) {
  const L = String(lang || "en").toLowerCase();

  // Minimal, high-quality templates. You can expand later.
  const dict = {
    en: {
      standardSummary:
        "Standard analysis based on consistency and general credibility signals. For multi-source verification, switch to PRO.",
      standardReasonCoherence: "Checked overall coherence, structure, and credibility signals.",
      standardReasonNoMultiSource: "Standard mode does not perform full multi-source verification.",
      proReasonSignals: "PRO analysis combines credibility signals with verification when available.",
      proReasonNoExternal: "External search is disabled, so PRO stays conservative and avoids asserting facts.",
      proReasonCorroboration: (n) => `Multiple sources appear to support key points (${n} supporting signals).`,
      proReasonContradiction: (n) => `Some sources suggest contradictions or disputes (${n} conflicting signals).`,
      proReasonWeakVerification: "Sources did not clearly confirm or refute the main claims.",
      reasonLowInfo: "The text is short or lacks specifics, which reduces reliability.",
      reasonSensational: "Sensational or extreme wording increases misinformation risk.",
      reasonHealthCaution: "Health-related claims require strong sources; extra caution applied.",
      reasonPoliticsCaution: "Political claims are time-sensitive; extra caution applied.",
      reasonOfficialRoleNeedsSources: "Official-role claims (e.g., president/PM) require up-to-date sources to confirm.",
      noExternalSearchNote:
        "External web verification is OFF. This result focuses on signals and avoids stating unverified facts.",
      verificationWeakNote: "Verification signals were weak or ambiguous.",
      proSummaryNoExternal: (score, risk) =>
        `PRO analysis (signals-only). Score ${score}/98, risk ${risk}. Enable external verification for stronger confirmation.`,
      proSummaryStrong: (score) =>
        `High confidence pattern. Score ${score}/98. Multiple sources align with the main claims.`,
      proSummarySome: (score) =>
        `Moderate confidence. Score ${score}/98. At least one credible source aligns with key points, but more confirmation may be needed.`,
      proSummaryContradictions: (score) =>
        `Warning: contradictions detected. Score ${score}/98. Some sources conflict with the claims—treat this as high risk.`,
      proSummaryUnclear: (score, risk) =>
        `Mixed signals. Score ${score}/98, risk ${risk}. Sources did not clearly confirm the main claims.`,
    },

    fr: {
      standardSummary:
        "Analyse standard basée sur la cohérence et des signaux généraux de crédibilité. Pour une vérification multi-sources, passe en PRO.",
      standardReasonCoherence: "Vérification de la cohérence, de la structure et des signaux de crédibilité.",
      standardReasonNoMultiSource: "Le mode standard ne fait pas une vérification multi-sources complète.",
      proReasonSignals: "L’analyse PRO combine signaux de crédibilité et vérification quand elle est disponible.",
      proReasonNoExternal:
        "La recherche externe est désactivée : l’analyse PRO reste prudente et n’affirme pas des faits non vérifiés.",
      proReasonCorroboration: (n) => `Plusieurs sources semblent corroborer les points clés (${n} signaux de soutien).`,
      proReasonContradiction: (n) => `Certaines sources suggèrent des contradictions (${n} signaux de conflit).`,
      proReasonWeakVerification: "Les sources ne confirment ni n’infirment clairement les affirmations principales.",
      reasonLowInfo: "Le texte est court ou manque de détails, ce qui réduit la fiabilité.",
      reasonSensational: "Le ton extrême/sensationnaliste augmente le risque de désinformation.",
      reasonHealthCaution: "Les affirmations santé exigent des sources solides : prudence renforcée.",
      reasonPoliticsCaution: "Les affirmations politiques sont sensibles au temps : prudence renforcée.",
      reasonOfficialRoleNeedsSources:
        "Les rôles officiels (président/PM) exigent des sources à jour pour confirmer.",
      noExternalSearchNote:
        "Vérification web externe désactivée : résultat basé sur signaux, sans affirmer des faits non vérifiés.",
      verificationWeakNote: "Signaux de vérification faibles ou ambigus.",
      proSummaryNoExternal: (score, risk) =>
        `Analyse PRO (signaux seulement). Score ${score}/98, risque ${risk}. Active la vérification externe pour confirmer plus fort.`,
      proSummaryStrong: (score) =>
        `Confiance élevée. Score ${score}/98. Plusieurs sources s’alignent avec les affirmations principales.`,
      proSummarySome: (score) =>
        `Confiance moyenne. Score ${score}/98. Au moins une source crédible s’aligne, mais plus de confirmation peut être nécessaire.`,
      proSummaryContradictions: (score) =>
        `Attention : contradictions détectées. Score ${score}/98. Certaines sources contredisent—risque élevé.`,
      proSummaryUnclear: (score, risk) =>
        `Signaux mitigés. Score ${score}/98, risque ${risk}. Les sources ne confirment pas clairement les affirmations.`,
    },

    // For other languages: keep concise, professional, understandable
    es: {
      standardSummary:
        "Análisis estándar basado en coherencia y señales generales de credibilidad. Para verificación multi-fuente, cambia a PRO.",
      standardReasonCoherence: "Revisión de coherencia, estructura y señales de credibilidad.",
      standardReasonNoMultiSource: "El modo estándar no realiza verificación multi-fuente completa.",
      proReasonSignals: "El modo PRO combina señales de credibilidad y verificación cuando está disponible.",
      proReasonNoExternal: "La búsqueda externa está desactivada; PRO se mantiene conservador y evita afirmar hechos.",
      proReasonCorroboration: (n) => `Fuentes parecen respaldar puntos clave (${n} señales).`,
      proReasonContradiction: (n) => `Algunas fuentes sugieren contradicciones (${n} señales).`,
      proReasonWeakVerification: "Las fuentes no confirmaron ni refutaron claramente las afirmaciones.",
      reasonLowInfo: "Texto corto o poco específico; baja la fiabilidad.",
      reasonSensational: "Lenguaje sensacionalista aumenta el riesgo.",
      reasonHealthCaution: "Afirmaciones de salud requieren fuentes fuertes; prudencia extra.",
      reasonPoliticsCaution: "Afirmaciones políticas son sensibles al tiempo; prudencia extra.",
      reasonOfficialRoleNeedsSources: "Roles oficiales requieren fuentes actualizadas.",
      noExternalSearchNote: "Verificación web externa apagada: sin afirmar hechos no verificados.",
      verificationWeakNote: "Señales de verificación débiles o ambiguas.",
      proSummaryNoExternal: (score, risk) => `PRO (solo señales). Puntuación ${score}/98, riesgo ${risk}.`,
      proSummaryStrong: (score) => `Alta confianza. Puntuación ${score}/98. Varias fuentes coinciden.`,
      proSummarySome: (score) => `Confianza media. Puntuación ${score}/98. Al menos una fuente coincide.`,
      proSummaryContradictions: (score) => `Advertencia: contradicciones. Puntuación ${score}/98.`,
      proSummaryUnclear: (score, risk) => `Señales mixtas. Puntuación ${score}/98, riesgo ${risk}.`,
    },

    it: {
      standardSummary:
        "Analisi standard basata su coerenza e segnali generali di credibilità. Per verifica multi-fonte, passa a PRO.",
      standardReasonCoherence: "Controllo di coerenza, struttura e segnali di credibilità.",
      standardReasonNoMultiSource: "La modalità standard non esegue una verifica multi-fonte completa.",
      proReasonSignals: "PRO combina segnali di credibilità e verifica quando disponibile.",
      proReasonNoExternal: "Ricerca esterna disattivata: PRO resta prudente e non afferma fatti non verificati.",
      proReasonCorroboration: (n) => `Più fonti sembrano supportare punti chiave (${n} segnali).`,
      proReasonContradiction: (n) => `Alcune fonti indicano contraddizioni (${n} segnali).`,
      proReasonWeakVerification: "Le fonti non confermano né smentiscono chiaramente le affermazioni principali.",
      reasonLowInfo: "Testo breve o poco specifico: affidabilità ridotta.",
      reasonSensational: "Linguaggio sensazionalistico aumenta il rischio.",
      reasonHealthCaution: "Claim sulla salute richiedono fonti forti: cautela extra.",
      reasonPoliticsCaution: "Claim politici sono sensibili al tempo: cautela extra.",
      reasonOfficialRoleNeedsSources: "Ruoli ufficiali richiedono fonti aggiornate.",
      noExternalSearchNote: "Verifica web esterna OFF: niente fatti non verificati.",
      verificationWeakNote: "Segnali di verifica deboli o ambigui.",
      proSummaryNoExternal: (score, risk) => `PRO (solo segnali). Punteggio ${score}/98, rischio ${risk}.`,
      proSummaryStrong: (score) => `Alta fiducia. Punteggio ${score}/98. Più fonti coincidono.`,
      proSummarySome: (score) => `Fiducia media. Punteggio ${score}/98. Almeno una fonte coincide.`,
      proSummaryContradictions: (score) => `Attenzione: contraddizioni. Punteggio ${score}/98.`,
      proSummaryUnclear: (score, risk) => `Segnali misti. Punteggio ${score}/98, rischio ${risk}.`,
    },

    de: {
      standardSummary:
        "Standardanalyse basierend auf Konsistenz und allgemeinen Glaubwürdigkeits-Signalen. Für Multi-Source-Prüfung: PRO.",
      standardReasonCoherence: "Prüfung von Kohärenz, Struktur und Glaubwürdigkeits-Signalen.",
      standardReasonNoMultiSource: "Standardmodus führt keine vollständige Multi-Source-Verifikation durch.",
      proReasonSignals: "PRO kombiniert Signale und Verifikation, wenn verfügbar.",
      proReasonNoExternal: "Externe Suche deaktiviert: PRO bleibt vorsichtig und behauptet keine ungeprüften Fakten.",
      proReasonCorroboration: (n) => `Mehrere Quellen stützen Kernpunkte (${n} Signale).`,
      proReasonContradiction: (n) => `Einige Quellen deuten Widersprüche an (${n} Signale).`,
      proReasonWeakVerification: "Quellen bestätigten oder widerlegten die Aussagen nicht klar.",
      reasonLowInfo: "Text ist kurz oder unspezifisch; geringere Zuverlässigkeit.",
      reasonSensational: "Sensationelle Sprache erhöht das Risiko.",
      reasonHealthCaution: "Gesundheitsthemen brauchen starke Quellen; extra Vorsicht.",
      reasonPoliticsCaution: "Politik ist zeitkritisch; extra Vorsicht.",
      reasonOfficialRoleNeedsSources: "Offizielle Rollen brauchen aktuelle Quellen.",
      noExternalSearchNote: "Externe Web-Prüfung AUS: keine ungeprüften Fakten.",
      verificationWeakNote: "Verifikationssignale schwach oder uneindeutig.",
      proSummaryNoExternal: (score, risk) => `PRO (nur Signale). Score ${score}/98, Risiko ${risk}.`,
      proSummaryStrong: (score) => `Hohe Sicherheit. Score ${score}/98. Mehrere Quellen stimmen überein.`,
      proSummarySome: (score) => `Mittlere Sicherheit. Score ${score}/98. Mindestens eine Quelle passt.`,
      proSummaryContradictions: (score) => `Warnung: Widersprüche. Score ${score}/98.`,
      proSummaryUnclear: (score, risk) => `Gemischte Signale. Score ${score}/98, Risiko ${risk}.`,
    },

    pt: {
      standardSummary:
        "Análise padrão baseada em consistência e sinais gerais de credibilidade. Para verificação multi-fontes, use PRO.",
      standardReasonCoherence: "Checagem de coerência, estrutura e sinais de credibilidade.",
      standardReasonNoMultiSource: "Modo padrão não faz verificação multi-fontes completa.",
      proReasonSignals: "PRO combina sinais de credibilidade e verificação quando disponível.",
      proReasonNoExternal: "Busca externa desativada: PRO fica conservador e não afirma fatos não verificados.",
      proReasonCorroboration: (n) => `Fontes parecem apoiar pontos-chave (${n} sinais).`,
      proReasonContradiction: (n) => `Algumas fontes sugerem contradições (${n} sinais).`,
      proReasonWeakVerification: "As fontes não confirmaram nem refutaram claramente as afirmações.",
      reasonLowInfo: "Texto curto ou pouco específico: menor confiabilidade.",
      reasonSensational: "Linguagem sensacionalista aumenta o risco.",
      reasonHealthCaution: "Saúde exige fontes fortes; cautela extra.",
      reasonPoliticsCaution: "Política é sensível ao tempo; cautela extra.",
      reasonOfficialRoleNeedsSources: "Cargos oficiais exigem fontes atualizadas.",
      noExternalSearchNote: "Verificação web externa OFF: sem afirmar fatos.",
      verificationWeakNote: "Sinais de verificação fracos ou ambíguos.",
      proSummaryNoExternal: (score, risk) => `PRO (só sinais). Nota ${score}/98, risco ${risk}.`,
      proSummaryStrong: (score) => `Alta confiança. Nota ${score}/98. Várias fontes concordam.`,
      proSummarySome: (score) => `Confiança média. Nota ${score}/98. Pelo menos uma fonte concorda.`,
      proSummaryContradictions: (score) => `Atenção: contradições. Nota ${score}/98.`,
      proSummaryUnclear: (score, risk) => `Sinais mistos. Nota ${score}/98, risco ${risk}.`,
    },

    ru: {
      standardSummary:
        "Стандартный анализ по согласованности текста и общим сигналам доверия. Для мульти-источниковой проверки — PRO.",
      standardReasonCoherence: "Проверка связности, структуры и сигналов доверия.",
      standardReasonNoMultiSource: "Стандартный режим не выполняет полную проверку по нескольким источникам.",
      proReasonSignals: "PRO объединяет сигналы доверия и проверку (если доступна).",
      proReasonNoExternal:
        "Внешний поиск отключён: PRO остаётся осторожным и не утверждает непроверенные факты.",
      proReasonCorroboration: (n) => `Несколько источников поддерживают ключевые пункты (${n}).`,
      proReasonContradiction: (n) => `Некоторые источники указывают на противоречия (${n}).`,
      proReasonWeakVerification: "Источники не подтвердили и не опровергли утверждения однозначно.",
      reasonLowInfo: "Текст короткий или без деталей — надёжность ниже.",
      reasonSensational: "Сенсационный/крайний тон повышает риск.",
      reasonHealthCaution: "Здоровье требует сильных источников — повышенная осторожность.",
      reasonPoliticsCaution: "Политика зависит от времени — повышенная осторожность.",
      reasonOfficialRoleNeedsSources: "Официальные должности требуют актуальных источников.",
      noExternalSearchNote: "Внешняя проверка OFF: без утверждения фактов.",
      verificationWeakNote: "Сигналы проверки слабые или неоднозначные.",
      proSummaryNoExternal: (score, risk) => `PRO (только сигналы). Балл ${score}/98, риск ${risk}.`,
      proSummaryStrong: (score) => `Высокая уверенность. Балл ${score}/98. Источники согласуются.`,
      proSummarySome: (score) => `Средняя уверенность. Балл ${score}/98. Есть совпадающие источники.`,
      proSummaryContradictions: (score) => `Внимание: противоречия. Балл ${score}/98.`,
      proSummaryUnclear: (score, risk) => `Смешанные сигналы. Балл ${score}/98, риск ${risk}.`,
    },

    ja: {
      standardSummary:
        "標準分析：文章の整合性と一般的な信頼性シグナルに基づきます。複数ソース検証はPROで行います。",
      standardReasonCoherence: "整合性・構造・信頼性シグナルを確認しました。",
      standardReasonNoMultiSource: "標準モードでは本格的な複数ソース検証は行いません。",
      proReasonSignals: "PROは信頼性シグナルと（可能なら）検証を組み合わせます。",
      proReasonNoExternal: "外部検索が無効のため、PROは慎重に扱い未検証の事実は断定しません。",
      proReasonCorroboration: (n) => `複数の情報が主要点を支持しています（${n}）。`,
      proReasonContradiction: (n) => `矛盾を示す情報が見つかりました（${n}）。`,
      proReasonWeakVerification: "情報は主張を明確に肯定/否定できませんでした。",
      reasonLowInfo: "文章が短い/具体性が不足しており、信頼性が下がります。",
      reasonSensational: "過激・扇動的な表現はリスクを高めます。",
      reasonHealthCaution: "健康分野は強い根拠が必要なため慎重に扱います。",
      reasonPoliticsCaution: "政治は時間依存のため慎重に扱います。",
      reasonOfficialRoleNeedsSources: "公職（大統領/首相など）は最新ソースでの確認が必要です。",
      noExternalSearchNote: "外部検証OFF：未検証の事実は断定しません。",
      verificationWeakNote: "検証シグナルが弱い/不明確です。",
      proSummaryNoExternal: (score, risk) => `PRO（シグナルのみ）。スコア ${score}/98、リスク ${risk}。`,
      proSummaryStrong: (score) => `高い信頼。スコア ${score}/98。複数ソースが一致しています。`,
      proSummarySome: (score) => `中程度の信頼。スコア ${score}/98。部分的に一致があります。`,
      proSummaryContradictions: (score) => `注意：矛盾あり。スコア ${score}/98。`,
      proSummaryUnclear: (score, risk) => `混合シグナル。スコア ${score}/98、リスク ${risk}。`,
    },
  };

  return dict[L] || dict.en;
}

/* -------------------------------
   Keyword lists (light but effective)
-------------------------------- */
function sensationalWords(lang) {
  const base = ["shocking", "insane", "unbelievable", "must see", "exposed", "scam", "hoax", "fake", "breaking"];
  const fr = ["incroyable", "choquant", "scandale", "arnaque", "fake", "révélé", "bombe"];
  const es = ["increíble", "impactante", "escándalo", "estafa", "falso", "revelado", "bomba"];
  const it = ["incredibile", "scioccante", "scandalo", "truffa", "falso", "rivelato", "bomba"];
  const de = ["unglaublich", "schockierend", "skandal", "betrug", "fake", "enthüllt"];
  const pt = ["incrível", "chocante", "escândalo", "golpe", "falso", "revelado"];
  const ru = ["шок", "скандал", "обман", "фейк", "сенсация", "разоблачение"];
  const ja = ["衝撃", "ヤバい", "詐欺", "フェイク", "暴露", "速報"];

  if (lang === "fr") return base.concat(fr);
  if (lang === "es") return base.concat(es);
  if (lang === "it") return base.concat(it);
  if (lang === "de") return base.concat(de);
  if (lang === "pt") return base.concat(pt);
  if (lang === "ru") return ru;
  if (lang === "ja") return ja;
  return base;
}

function certaintyWords(lang) {
  const en = ["definitely", "certainly", "always", "never", "100%", "proof", "confirmed"];
  const fr = ["certain", "certainement", "toujours", "jamais", "preuve", "confirmé"];
  const es = ["siempre", "nunca", "prueba", "confirmado", "seguro"];
  const it = ["sempre", "mai", "prova", "confermato", "sicuro"];
  const de = ["immer", "nie", "beweis", "bestätigt", "sicher"];
  const pt = ["sempre", "nunca", "prova", "confirmado", "certo"];
  const ru = ["всегда", "никогда", "доказательство", "подтверждено", "точно"];
  const ja = ["絶対", "確実", "証拠", "確認済み", "必ず"];

  if (lang === "fr") return en.concat(fr);
  if (lang === "es") return en.concat(es);
  if (lang === "it") return en.concat(it);
  if (lang === "de") return en.concat(de);
  if (lang === "pt") return en.concat(pt);
  if (lang === "ru") return ru;
  if (lang === "ja") return ja;
  return en;
}

function hedgeWords(lang) {
  const en = ["maybe", "might", "could", "possibly", "appears", "seems", "likely"];
  const fr = ["peut-être", "pourrait", "sembler", "probable", "il semble", "il paraît"];
  const es = ["quizá", "podría", "parece", "probable"];
  const it = ["forse", "potrebbe", "sembra", "probabile"];
  const de = ["vielleicht", "könnte", "scheint", "wahrscheinlich"];
  const pt = ["talvez", "poderia", "parece", "provável"];
  const ru = ["возможно", "может", "похоже", "вероятно"];
  const ja = ["たぶん", "かもしれない", "ようだ", "可能性"];

  if (lang === "fr") return en.concat(fr);
  if (lang === "es") return en.concat(es);
  if (lang === "it") return en.concat(it);
  if (lang === "de") return en.concat(de);
  if (lang === "pt") return en.concat(pt);
  if (lang === "ru") return ru;
  if (lang === "ja") return ja;
  return en;
}

function contradictionWords(lang) {
  const en = ["false", "hoax", "debunk", "misleading", "incorrect", "refute", "not true"];
  const fr = ["faux", "dément", "débunk", "trompeur", "incorrect", "réfute"];
  const es = ["falso", "desmentido", "engañoso", "incorrecto", "refuta"];
  const it = ["falso", "smentito", "fuorviante", "errato", "confuta"];
  const de = ["falsch", "widerlegt", "irreführend", "inkorrekt"];
  const pt = ["falso", "desmentido", "enganoso", "incorreto", "refuta"];
  const ru = ["ложь", "фейк", "опроверг", "вводит в заблуждение", "неверно"];
  const ja = ["誤り", "デマ", "誤解を招く", "不正確", "否定"];

  if (lang === "fr") return en.concat(fr);
  if (lang === "es") return en.concat(es);
  if (lang === "it") return en.concat(it);
  if (lang === "de") return en.concat(de);
  if (lang === "pt") return en.concat(pt);
  if (lang === "ru") return ru;
  if (lang === "ja") return ja;
  return en;
}

function supportWords(lang) {
  const en = ["confirmed", "according to", "report", "official", "statement", "data"];
  const fr = ["confirmé", "selon", "rapport", "officiel", "déclaration", "données"];
  const es = ["confirmado", "según", "informe", "oficial", "declaración", "datos"];
  const it = ["confermato", "secondo", "rapporto", "ufficiale", "dati"];
  const de = ["bestätigt", "laut", "bericht", "offiziell", "daten"];
  const pt = ["confirmado", "segundo", "relatório", "oficial", "dados"];
  const ru = ["подтверждено", "согласно", "отчет", "официально", "данные"];
  const ja = ["確認", "によると", "報告", "公式", "声明", "データ"];

  if (lang === "fr") return en.concat(fr);
  if (lang === "es") return en.concat(es);
  if (lang === "it") return en.concat(it);
  if (lang === "de") return en.concat(de);
  if (lang === "pt") return en.concat(pt);
  if (lang === "ru") return ru;
  if (lang === "ja") return ja;
  return en;
}

function topicKeywords(lang, topic) {
  // small lists – fast and stable
  const maps = {
    politics: {
      en: ["president", "prime minister", "election", "government", "parliament", "senate", "minister"],
      fr: ["président", "premier ministre", "élection", "gouvernement", "parlement", "ministre"],
      es: ["presidente", "primer ministro", "elección", "gobierno", "parlamento", "ministro"],
      it: ["presidente", "primo ministro", "elezione", "governo", "parlamento", "ministro"],
      de: ["präsident", "kanzler", "wahl", "regierung", "parlament", "minister"],
      pt: ["presidente", "primeiro-ministro", "eleição", "governo", "parlamento", "ministro"],
      ru: ["президент", "премьер-министр", "выборы", "правительство", "парламент", "министр"],
      ja: ["大統領", "首相", "選挙", "政府", "議会", "大臣"],
    },
    health: {
      en: ["cure", "vaccine", "disease", "cancer", "covid", "medicine", "doctor"],
      fr: ["guérir", "vaccin", "maladie", "cancer", "covid", "médicament", "docteur"],
      es: ["cura", "vacuna", "enfermedad", "cáncer", "covid", "medicina", "doctor"],
      it: ["cura", "vaccino", "malattia", "cancro", "covid", "medicina", "dottore"],
      de: ["heilung", "impfstoff", "krankheit", "krebs", "covid", "medizin", "arzt"],
      pt: ["cura", "vacina", "doença", "câncer", "covid", "medicina", "médico"],
      ru: ["лечение", "вакцина", "болезнь", "рак", "ковид", "лекарство", "врач"],
      ja: ["治療", "ワクチン", "病気", "がん", "コロナ", "薬", "医師"],
    },
    finance: {
      en: ["stock", "bitcoin", "crypto", "interest rate", "inflation", "bank", "investment"],
      fr: ["action", "bitcoin", "crypto", "taux d'intérêt", "inflation", "banque", "investissement"],
      es: ["acción", "bitcoin", "cripto", "tasa de interés", "inflación", "banco", "inversión"],
      it: ["azione", "bitcoin", "cripto", "tasso di interesse", "inflazione", "banca", "investimento"],
      de: ["aktie", "bitcoin", "krypto", "zins", "inflation", "bank", "investition"],
      pt: ["ação", "bitcoin", "cripto", "taxa de juros", "inflação", "banco", "investimento"],
      ru: ["акция", "биткоин", "крипто", "ставка", "инфляция", "банк", "инвестиции"],
      ja: ["株", "ビットコイン", "暗号資産", "金利", "インフレ", "銀行", "投資"],
    },
  };

  const pack = maps[topic] || {};
  const k = pack[lang] || pack.en || [];
  return k;
}

function topicMatch(text, lang, kws) {
  const lower = String(text || "").toLowerCase();
  for (const k of kws || []) {
    if (!k) continue;
    // If keyword has non-latin chars, compare raw; else lowercase
    const needle = /[^\x00-\x7F]/.test(k) ? k : k.toLowerCase();
    if (lower.includes(needle.toLowerCase())) return true;
  }
  return false;
}

function mentionsOfficialRole(text, lang) {
  const kws = topicKeywords(lang, "politics");
  return topicMatch(text, lang, kws) && /(president|prime minister|président|premier ministre|президент|首相|大統領)/i.test(text);
}

function mentionsYear(text, year) {
  return new RegExp(String(year), "g").test(String(text || ""));
}

/* -------------------------------
   Utilities
-------------------------------- */
function nowMs() {
  return Date.now();
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function safeTrimText(x) {
  return String(x || "").replace(/\s+/g, " ").trim();
}

function clamp(n, a, b) {
  const x = Number(n);
  if (Number.isNaN(x)) return a;
  return Math.min(b, Math.max(a, x));
}

function wordCount(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function countMatches(hay, needles) {
  const s = String(hay || "");
  let c = 0;
  for (const n of needles || []) {
    const needle = String(n || "").trim();
    if (!needle) continue;
    if (s.includes(needle)) c++;
  }
  return c;
}

function keywordize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9à-öø-ÿа-яё一-龯ぁ-ゟ゠-ヿ\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 3)
    .slice(0, 20);
}

function uniqKeepOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = String(x || "");
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function safeShort(s, max) {
  const x = String(s || "").trim();
  if (!x) return "";
  return x.length <= max ? x : x.slice(0, max - 1) + "…";
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function looksLikeHomepage(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "").replace(/\/+$/, "");
    // Consider homepage if path empty or too short
    return p === "" || p === "/" || p.length <= 1;
  } catch {
    return false;
  }
}

function normalizeUrlForDedupe(url) {
  try {
    const u = new URL(url);
    // drop tracking
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((k) =>
      u.searchParams.delete(k)
    );
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return String(url || "").trim();
  }
}

/* -------------------------------
   Rate limiting (in-memory, robust)
-------------------------------- */
const buckets = new Map();
// key => { count, resetAtMs }

function rateLimitCheck(req, isPro) {
  const limit = isPro ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const ip =
    (req.headers["x-forwarded-for"] || "")
      .toString()
      .split(",")[0]
      .trim() || req.socket?.remoteAddress || "unknown";

  const k = `${isPro ? "pro" : "std"}::${ip}`;
  const now = nowMs();
  const resetAt = now + 60 * 1000;

  let b = buckets.get(k);
  if (!b || now > b.resetAtMs) {
    b = { count: 0, resetAtMs: resetAt };
    buckets.set(k, b);
  }

  b.count += 1;

  // cleanup occasionally
  if (buckets.size > 5000) {
    const cut = now - 5 * 60 * 1000;
    for (const [kk, vv] of buckets.entries()) {
      if (vv.resetAtMs < cut) buckets.delete(kk);
    }
  }

  const remaining = Math.max(0, limit - b.count);

  return {
    ok: b.count <= limit,
    limit,
    remaining,
    resetMs: b.resetAtMs,
  };
}

/* -------------------------------
   Cache (in-memory)
-------------------------------- */
const cache = new Map();
// key => { value, exp }

function cacheGet(key) {
  const k = String(key || "");
  if (!k) return null;

  const it = cache.get(k);
  if (!it) return null;

  if (nowMs() > it.exp) {
    cache.delete(k);
    return null;
  }
  return it.value || null;
}

function cacheSet(key, value) {
  const k = String(key || "");
  if (!k) return;

  if (cache.size >= CACHE_MAX_ITEMS) {
    // simple eviction: remove oldest
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  cache.set(k, { value, exp: nowMs() + CACHE_TTL_MS });
}

/* -------------------------------
   Mode helpers
-------------------------------- */
function isProbablyProMode(mode) {
  const m = String(mode || "").toLowerCase();
  return m === "pro" || m === "premium" || m === "premium_plus" || m === "plus";
}

/* -------------------------------
   Start
-------------------------------- */
app.listen(PORT, () => {
  console.log(`[${ENGINE_NAME}] listening on port ${PORT} (v${VERSION})`);
  console.log(`[${ENGINE_NAME}] external search: ${isExternalSearchEnabled() ? "ON" : "OFF"} (${WEB_PROVIDER || "none"})`);
});
