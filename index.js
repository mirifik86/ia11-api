/** 
 * IA11 API (LeenScore) — index.js (Ultra PRO, "living" analysis)
 *
 * Promise:
 * - Same v1 response contract (stable for LeenScore)
 * - Much smarter scoring (multi-signal + claim extraction)
 * - Language-aware output (matches UI / user language)
 * - PRO mode: real web evidence via provider (Bing by default if key present)
 * - Conservative truth assertions: never confidently claim "false" on weak evidence
 */

import express from "express";
import cors from "cors";
import crypto from "crypto";

// --------------------------
// Env / Config
// --------------------------

const PORT = process.env.PORT || 3000;

const IA11_API_KEY = process.env.IA11_API_KEY || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Rate limit
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);
const RATE_LIMIT_PER_MIN_PRO = parseInt(process.env.RATE_LIMIT_PER_MIN_PRO || "60", 10);

// Web provider for PRO
const WEB_PROVIDER = (process.env.WEB_PROVIDER || "bing").toLowerCase();
const BING_API_KEY = process.env.BING_API_KEY || "";
const BING_ENDPOINT = process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";

// "Now" year anchor (important for time-sensitive claims)
const NOW_YEAR = parseInt(process.env.NOW_YEAR || "2026", 10);

// Safety toggles
const MAX_TEXT_CHARS = parseInt(process.env.MAX_TEXT_CHARS || "12000", 10);
const MAX_CLAIMS = parseInt(process.env.MAX_CLAIMS || "6", 10);

const ENGINE_NAME = "IA11";
const ENGINE_VERSION = "2.2.1";

// --------------------------
// App
// --------------------------

const app = express();

app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-ia11-key", "x-tier", "x-lang"],
  })
);

app.use(express.json({ limit: "1mb" }));

// --------------------------
// Tiny in-memory rate limiter
// --------------------------

const rateMap = new Map(); // key -> { windowStart, count }

function rateLimit(req, res, next) {
  const tier = (req.headers["x-tier"] || "standard").toString().toLowerCase();
  const limit = tier === "pro" || tier === "premium" || tier === "premium_plus" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const key = `${req.ip}:${tier}`;
  const now = Date.now();
  const windowMs = 60_000;

  const entry = rateMap.get(key) || { windowStart: now, count: 0 };

  if (now - entry.windowStart >= windowMs) {
    entry.windowStart = now;
    entry.count = 0;
  }

  entry.count += 1;
  rateMap.set(key, entry);

  if (entry.count > limit) {
    return res.status(429).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 20,
        riskLevel: "high",
        summary: "Rate limit exceeded.",
        reasons: ["Too many requests in a short period."],
        confidence: 0.5,
        sources: [],
      },
      meta: { tookMs: 0, version: ENGINE_VERSION },
    });
  }

  return next();
}

// --------------------------
// Auth
// --------------------------

function requireKey(req, res, next) {
  const key = req.headers["x-ia11-key"];
  if (!IA11_API_KEY || key !== IA11_API_KEY) {
    return res.status(401).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: (req.headers["x-tier"] || "standard").toString(),
      result: {
        score: 10,
        riskLevel: "high",
        summary: "Unauthorized.",
        reasons: ["Invalid API key."],
        confidence: 0.8,
        sources: [],
      },
      meta: { tookMs: 0, version: ENGINE_VERSION },
    });
  }
  return next();
}

// --------------------------
// Routes
// --------------------------

app.get("/", (req, res) => {
  res.json({ status: "ok", engine: ENGINE_NAME, version: ENGINE_VERSION });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    routes: ["POST /v1/analyze"],
  });
});

app.post("/v1/analyze", rateLimit, requireKey, async (req, res) => {
  const started = Date.now();

  const tier = (req.headers["x-tier"] || "standard").toString().toLowerCase();
  const uiLangHeader = (req.headers["x-lang"] || "").toString().toLowerCase();

  const text = (req.body && (req.body.text || req.body.content || "")).toString();

  if (!text || !text.trim()) {
    return res.status(400).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 15,
        riskLevel: "high",
        summary: "Missing text.",
        reasons: ["No analyzable text was provided."],
        confidence: 0.9,
        sources: [],
      },
      meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
    });
  }

  const clipped = text.slice(0, MAX_TEXT_CHARS);

  const detectedLang = detectLanguage(clipped) || "en";
  const lang = normalizeLang(uiLangHeader) || normalizeLang(detectedLang) || "en";

  try {
    const out = await analyzeText(clipped, tier, lang);
    const tookMs = Date.now() - started;

    return res.json({
      status: "ok",
      requestId: out.requestId,
      engine: ENGINE_NAME,
      mode: tier,
      result: out.result,
      meta: { tookMs, version: ENGINE_VERSION },
    });
  } catch (err) {
    const tookMs = Date.now() - started;
    return res.status(500).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 25,
        riskLevel: "high",
        summary: t(lang, "server_error_summary"),
        reasons: [t(lang, "server_error_reason")],
        confidence: 0.6,
        sources: [],
      },
      meta: { tookMs, version: ENGINE_VERSION },
    });
  }
});

// --------------------------
// Core analysis
// --------------------------

async function analyzeText(text, tier, lang) {
  const reqId = requestId();

  const cleaned = normalizeSpaces(text);
  const signals = [];

  // Base: format / style heuristics
  const capsRatio = ratioCaps(cleaned);
  const exclamCount = (cleaned.match(/!/g) || []).length;
  const hasManyLinks = (cleaned.match(/https?:\/\//g) || []).length >= 2;
  const hasAllCapsWords = /\b[A-Z]{5,}\b/.test(cleaned);

  // Claim extraction
  const claims = extractClaims(cleaned, lang).slice(0, MAX_CLAIMS);

  // Time-sensitive cue
  const isTimeSensitive = detectTimeSensitive(cleaned, lang);

  // Standard mode: heuristics only (no external web)
  const proEnabled = tier === "pro" || tier === "premium" || tier === "premium_plus";

  // Build scoring
  let score = 70;

  // Style penalties/bonuses
  if (capsRatio > 0.25) {
    signals.push({ id: "style_caps", impact: -8, note: t(lang, "sig_caps") });
    score -= 8;
  }
  if (exclamCount >= 4) {
    signals.push({ id: "style_exclam", impact: -6, note: t(lang, "sig_exclam") });
    score -= 6;
  }
  if (hasAllCapsWords) {
    signals.push({ id: "style_allcaps_words", impact: -5, note: t(lang, "sig_allcaps") });
    score -= 5;
  }
  if (hasManyLinks) {
    signals.push({ id: "style_many_links", impact: -3, note: t(lang, "sig_many_links") });
    score -= 3;
  }

  // Claim count logic
  if (claims.length === 0) {
    signals.push({ id: "no_clear_claims", impact: -10, note: t(lang, "sig_no_claims") });
    score -= 10;
  } else if (claims.length >= 4) {
    signals.push({ id: "many_claims", impact: -6, note: t(lang, "sig_many_claims") });
    score -= 6;
  } else {
    signals.push({ id: "some_claims", impact: +2, note: t(lang, "sig_some_claims") });
    score += 2;
  }

  // Time-sensitive: in standard, we can't verify reliably -> conservative penalty
  if (isTimeSensitive && !proEnabled) {
    signals.push({ id: "time_sensitive_no_web", impact: -18, note: t(lang, "sig_time_sensitive") });
    score -= 18;
  }

  // PRO: web verification
  let webEvidence = [];
  if (proEnabled) {
    if (WEB_PROVIDER === "bing" && BING_API_KEY) {
      webEvidence = await verifyClaimsWithWeb(claims, lang);
    } else {
      // PRO without key/provider: behave like standard but label
      signals.push({ id: "pro_no_web_provider", impact: -6, note: t(lang, "sig_pro_no_web") });
      score -= 6;
    }
  }

  // Apply web evidence impact conservatively
  if (proEnabled && webEvidence.length) {
    const { evidenceScoreDelta, evidenceSignals, sources } = aggregateEvidence(webEvidence, lang);
    score += evidenceScoreDelta;
    for (const s of evidenceSignals) signals.push(s);

    // Final clamp
    score = clamp(score, 5, 98);

    const riskLevel = scoreToRisk(score);
    const confidence = scoreToConfidence(score, proEnabled, webEvidence);

    const summary = buildSummary(cleaned, claims, signals, webEvidence, score, lang, proEnabled);

    const reasons = buildReasons(signals, lang);

    return {
      requestId: reqId,
      result: {
        score,
        riskLevel,
        summary,
        reasons,
        confidence,
        sources,
      },
    };
  }

  // Standard output (or PRO without web)
  score = clamp(score, 5, 98);

  const riskLevel = scoreToRisk(score);
  const confidence = scoreToConfidence(score, proEnabled, webEvidence);

  const summary = buildSummary(cleaned, claims, signals, webEvidence, score, lang, proEnabled);
  const reasons = buildReasons(signals, lang);

  return {
    requestId: reqId,
    result: {
      score,
      riskLevel,
      summary,
      reasons,
      confidence,
      sources: [], // standard keeps empty (PRO value)
    },
  };
}

// --------------------------
// Web verification (PRO)
// --------------------------

async function verifyClaimsWithWeb(claims, lang) {
  const out = [];

  for (const claim of claims || []) {
    const query = buildSearchQuery(claim, lang);
    const results = await webSearch(query, lang);
    const judged = judgeSearchResultsAgainstClaim(claim, results, lang);

    out.push({
      claim,
      query,
      judged,
    });
  }

  return out;
}

function buildSearchQuery(claim, lang) {
  const clean = normalizeSpaces(claim);

  // For “living” political roles, force a current-year context to avoid stale snippets
  const lower = clean.toLowerCase();
  const isPolitics = topicMatch(lower, lang, langKeywords(lang, "topics_politics"));

  if (isPolitics) {
    // This prevents results that talk about “former / ex / previous” from older contexts
    return `${clean} ${NOW_YEAR} current official sources`;
  }

  return clean;
}

async function webSearch(query, lang) {
  try {
    if (WEB_PROVIDER === "bing") {
      const res = await fetch(
        `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&mkt=${bingMarket(lang)}&count=6&textDecorations=false&textFormat=Raw`,
        {
          headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
        }
      );

      if (!res.ok) return [];

      const json = await res.json();
      const items = (json.webPages && json.webPages.value) || [];
      return items.map((x) => ({
        name: x.name,
        url: x.url,
        snippet: x.snippet,
      }));
    }
  } catch (_) {}

  return [];
}

function judgeSearchResultsAgainstClaim(claim, results, lang) {
  const lowerClaim = String(claim || "").toLowerCase();
  const tokens = claimTokens(lowerClaim);

  // “not currently” can be implied without explicit negation (esp. politics)
  const roleShiftCues = [
    "former",
    "ex-",
    "ex ",
    "previous",
    "past",
    "ancien",
    "ancienne",
    "précédent",
    "précédente",
    "ex-président",
    "ancien président",
    "быв" // ru stem for “former”
  ];

  const claimHasNegation = containsNegation(lowerClaim, lang);

  let strongSupportHits = 0;
  let strongContradictHits = 0;

  const sources = [];
  const seen = new Set();

  for (const r of results || []) {
    if (!r || !r.url) continue;

    // Reject generic homepages / category pages when possible
    if (isLowValueLandingUrl(r.url)) continue;

    // De-dup URLs (prevents duplicate sources)
    const u = normalizeUrl(r.url);
    if (seen.has(u)) continue;
    seen.add(u);

    const lower = (String(r.name || "") + " " + String(r.snippet || "")).toLowerCase();

    // Match strength
    const overlap = tokenOverlap(tokens, claimTokens(lower));

    // Treat “former/ex/ancien/быв...” as a soft negation cue
    const hasNegation = containsNegation(lower, lang) || roleShiftCues.some((w) => lower.includes(w));

    // Only count STRONG matches; weak matches must not flip the verdict
    const isStrong = overlap >= 0.5;

    if (isStrong) {
      if (claimHasNegation === hasNegation) strongSupportHits += 1;
      else strongContradictHits += 1;
    }

    sources.push({
      title: r.name,
      url: u,
      snippet: r.snippet,
      confidence: sourceConfidenceFromOverlap(overlap),
      quality: sourceQualityTier(u),
    });

    if (sources.length >= 8) break;
  }

  // Final rule: require at least 2 strong signals before declaring supported/contradicted
  let supported = strongSupportHits >= 2;
  let contradicted = strongContradictHits >= 2;

  // If sources conflict -> be conservative (never loudly claim “false”)
  if (supported && contradicted) {
    supported = false;
    contradicted = false;
  }

  return {
    supported,
    contradicted,
    sources: sources.slice(0, 8),
  };
}

function aggregateEvidence(webEvidence, lang) {
  let delta = 0;
  const signals = [];
  const sources = [];

  let supportedCount = 0;
  let contradictedCount = 0;
  let neutralCount = 0;

  for (const e of webEvidence || []) {
    if (!e || !e.judged) continue;

    const { supported, contradicted, sources: srcs } = e.judged;

    // Pick best sources (already filtered and de-duped per-claim)
    for (const s of srcs || []) sources.push(s);

    if (supported) supportedCount += 1;
    else if (contradicted) contradictedCount += 1;
    else neutralCount += 1;
  }

  // Conservative scoring: contradiction needs real support; neutral is "uncertain"
  if (supportedCount >= 2 && contradictedCount === 0) {
    delta += 10;
    signals.push({ id: "web_support", impact: +10, note: t(lang, "sig_web_support") });
  } else if (contradictedCount >= 2 && supportedCount === 0) {
    delta -= 18;
    signals.push({ id: "web_contradict", impact: -18, note: t(lang, "sig_web_contradict") });
  } else if (supportedCount === 0 && contradictedCount === 0 && neutralCount > 0) {
    delta -= 6;
    signals.push({ id: "web_uncertain", impact: -6, note: t(lang, "sig_web_uncertain") });
  } else {
    // Mixed evidence -> do not overreact
    delta -= 4;
    signals.push({ id: "web_mixed", impact: -4, note: t(lang, "sig_web_mixed") });
  }

  // Clamp sources to top 10, prioritize higher quality/confidence
  const unique = dedupeSources(sources).sort((a, b) => {
    const qa = (b.quality || 0) - (a.quality || 0);
    if (qa !== 0) return qa;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  return {
    evidenceScoreDelta: delta,
    evidenceSignals: signals,
    sources: unique.slice(0, 10).map((s) => ({
      title: s.title,
      url: s.url,
      snippet: s.snippet,
      confidence: clamp(s.confidence || 0.6, 0.2, 0.95),
    })),
  };
}

// --------------------------
// Summaries / reasons
// --------------------------

function buildSummary(text, claims, signals, webEvidence, score, lang, isPro) {
  const risk = scoreToRisk(score);

  const topSignals = signals
    .slice()
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3)
    .map((s) => s.note);

  if (isPro && webEvidence && webEvidence.length) {
    const { supported, contradicted } = summarizeEvidence(webEvidence);

    if (contradicted) {
      return t(lang, "summary_pro_contradicted", { risk, top: topSignals.join(" • ") });
    }
    if (supported) {
      return t(lang, "summary_pro_supported", { risk, top: topSignals.join(" • ") });
    }
    return t(lang, "summary_pro_uncertain", { risk, top: topSignals.join(" • ") });
  }

  return t(lang, "summary_standard", { risk, top: topSignals.join(" • ") });
}

function buildReasons(signals, lang) {
  const sorted = signals.slice().sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const reasons = [];
  for (const s of sorted.slice(0, 6)) reasons.push(s.note);
  if (reasons.length === 0) reasons.push(t(lang, "no_reasons"));
  return reasons;
}

function summarizeEvidence(webEvidence) {
  let supported = 0;
  let contradicted = 0;

  for (const e of webEvidence || []) {
    const j = e && e.judged;
    if (!j) continue;
    if (j.supported) supported += 1;
    if (j.contradicted) contradicted += 1;
  }

  return {
    supported: supported >= 2 && contradicted === 0,
    contradicted: contradicted >= 2 && supported === 0,
  };
}

// --------------------------
// Language / i18n
// --------------------------

function normalizeLang(x) {
  if (!x) return "";
  const v = x.toString().toLowerCase();
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  if (v.startsWith("es")) return "es";
  if (v.startsWith("de")) return "de";
  if (v.startsWith("it")) return "it";
  if (v.startsWith("ja")) return "ja";
  if (v.startsWith("ru")) return "ru";
  if (v.startsWith("uk")) return "uk";
  return v.slice(0, 2);
}

function detectLanguage(text) {
  const s = (text || "").toLowerCase();

  // crude heuristic; UI will override via x-lang anyway
  if (/[а-яё]/i.test(s)) return "ru";
  if (/[ぁ-んァ-ン一-龯]/.test(s)) return "ja";
  if (/\b(le|la|les|des|une|un|dans|avec|pour|mais)\b/.test(s)) return "fr";
  if (/\b(the|and|with|for|but|because)\b/.test(s)) return "en";
  if (/\b(el|la|los|las|una|un|con|para|pero)\b/.test(s)) return "es";
  if (/\b(der|die|das|und|mit|für|aber|weil)\b/.test(s)) return "de";
  if (/\b(il|lo|la|gli|le|con|per|ma|perché)\b/.test(s)) return "it";
  return "en";
}

function t(lang, key, vars = {}) {
  const L = I18N[lang] || I18N.en;
  const template = (L && L[key]) || I18N.en[key] || key;

  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

const I18N = {
  en: {
    server_error_summary: "Server error during analysis.",
    server_error_reason: "An internal error occurred.",
    sig_caps: "High uppercase usage can indicate sensational framing.",
    sig_exclam: "Many exclamation marks can indicate emotional framing.",
    sig_allcaps: "ALL-CAPS words can reduce credibility.",
    sig_many_links: "Multiple links without context can be a credibility red flag.",
    sig_no_claims: "No clear, verifiable claim detected.",
    sig_many_claims: "Many claims at once makes verification harder.",
    sig_some_claims: "Some verifiable claims detected.",
    sig_time_sensitive: "Time-sensitive claim: standard mode can’t verify reliably without web evidence.",
    sig_pro_no_web: "PRO requested but web verification is not available (missing provider/key).",
    sig_web_support: "Multiple sources appear to support the claim.",
    sig_web_contradict: "Multiple sources appear to contradict the claim.",
    sig_web_uncertain: "Sources found, but evidence is not strong enough to confirm or refute.",
    sig_web_mixed: "Sources are mixed or unclear; result stays conservative.",
    summary_standard: "Credibility risk: {risk}. {top}",
    summary_pro_supported: "Credibility risk: {risk}. Web evidence tends to support the claim. {top}",
    summary_pro_contradicted: "Credibility risk: {risk}. Web evidence tends to contradict the claim. {top}",
    summary_pro_uncertain: "Credibility risk: {risk}. Web evidence is inconclusive or mixed. {top}",
    no_reasons: "No strong signals detected.",
  },
  fr: {
    server_error_summary: "Erreur serveur pendant l’analyse.",
    server_error_reason: "Une erreur interne est survenue.",
    sig_caps: "Beaucoup de majuscules peut indiquer un ton sensationnaliste.",
    sig_exclam: "Beaucoup de points d’exclamation peut indiquer un ton émotionnel.",
    sig_allcaps: "Des mots en MAJUSCULES peuvent réduire la crédibilité.",
    sig_many_links: "Plusieurs liens sans contexte peuvent être un signal faible.",
    sig_no_claims: "Aucune affirmation claire et vérifiable détectée.",
    sig_many_claims: "Trop d’affirmations à la fois rend la vérification difficile.",
    sig_some_claims: "Quelques affirmations vérifiables détectées.",
    sig_time_sensitive: "Affirmation sensible au temps : sans web, le mode standard ne peut pas confirmer.",
    sig_pro_no_web: "PRO demandé mais la vérification web n’est pas disponible (clé/provider manquant).",
    sig_web_support: "Plusieurs sources semblent corroborer l’affirmation.",
    sig_web_contradict: "Plusieurs sources semblent contredire l’affirmation.",
    sig_web_uncertain: "Des sources existent, mais la preuve est insuffisante pour trancher.",
    sig_web_mixed: "Sources mixtes ou floues : résultat conservateur.",
    summary_standard: "Risque de crédibilité : {risk}. {top}",
    summary_pro_supported: "Risque de crédibilité : {risk}. Les sources web tendent à corroborer. {top}",
    summary_pro_contradicted: "Risque de crédibilité : {risk}. Les sources web tendent à contredire. {top}",
    summary_pro_uncertain: "Risque de crédibilité : {risk}. Les sources web sont mitigées ou insuffisantes. {top}",
    no_reasons: "Aucun signal fort détecté.",
  },
};

// --------------------------
// Helpers: scoring
// --------------------------

function scoreToRisk(score) {
  if (score >= 80) return "low";
  if (score >= 55) return "medium";
  return "high";
}

function scoreToConfidence(score, isPro, webEvidence) {
  let base = score >= 80 ? 0.88 : score >= 55 ? 0.72 : 0.58;
  if (isPro && webEvidence && webEvidence.length) base += 0.06;
  return clamp(base, 0.45, 0.95);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// --------------------------
// Helpers: text / claims
// --------------------------

function normalizeSpaces(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function ratioCaps(s) {
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (!letters) return 0;
  const caps = (s.match(/[A-Z]/g) || []).length;
  return caps / letters;
}

function extractClaims(text, lang) {
  const s = normalizeSpaces(text);

  // Split into short candidate sentences
  const parts = s
    .split(/[\.\n\r]+/)
    .map((x) => normalizeSpaces(x))
    .filter(Boolean)
    .filter((x) => x.length >= 20);

  // Keep likely factual assertions
  const factualHints = langKeywords(lang, "factual_hints");
  const out = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (factualHints.some((w) => lower.includes(w))) out.push(p);
    else if (/\b(is|are|was|were|est|sont|était|sera|won|elected|president|prime minister|président|ministre)\b/i.test(p)) out.push(p);
  }

  // If empty, fallback to first statement chunk
  if (out.length === 0 && parts.length) out.push(parts[0]);

  // Deduplicate
  return dedupeStrings(out).slice(0, 10);
}

function detectTimeSensitive(text, lang) {
  const lower = (text || "").toLowerCase();

  // Mentions of a year, "current", "now", "today", or offices that change over time
  const hasYear = /\b(19|20)\d{2}\b/.test(lower);
  const timeWords = langKeywords(lang, "time_words");
  const officeWords = langKeywords(lang, "topics_politics");

  return hasYear || timeWords.some((w) => lower.includes(w)) || officeWords.some((w) => lower.includes(w));
}

// --------------------------
// Helpers: evidence matching
// --------------------------

function claimTokens(s) {
  return normalizeSpaces(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 3)
    .slice(0, 24);
}

function tokenOverlap(a, b) {
  const A = new Set(a || []);
  const B = new Set(b || []);
  if (!A.size || !B.size) return 0;

  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.max(1, Math.min(A.size, B.size));
}

function containsNegation(s, lang) {
  const lower = (s || "").toLowerCase();
  const negs = langKeywords(lang, "negations");
  return negs.some((w) => lower.includes(w));
}

function isLowValueLandingUrl(url) {
  const u = (url || "").toLowerCase();

  // Likely homepages / hubs
  const bad = [
    "/news",
    "/latest",
    "/home",
    "/index",
    "/category/",
    "/topics/",
    "/tag/",
    "/search?",
    "google.com/search",
    "bing.com/search",
  ];

  // If it's very short and no path depth, often homepage
  try {
    const x = new URL(url);
    const path = x.pathname || "/";
    const depth = path.split("/").filter(Boolean).length;
    if (depth <= 1) return true;
  } catch (_) {}

  return bad.some((b) => u.includes(b));
}

function sourceQualityTier(url) {
  const u = (url || "").toLowerCase();

  // very rough tiers; can expand later
  const high = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "theguardian.com",
    "nytimes.com",
    "washingtonpost.com",
    "whitehouse.gov",
    "gov",
    "parliament",
    "europa.eu",
    "who.int",
    "un.org",
  ];

  const mid = ["wikipedia.org", "britannica.com", "cnn.com", "cbsnews.com", "nbcnews.com", "foxnews.com", "politico.com"];

  if (high.some((d) => u.includes(d))) return 3;
  if (mid.some((d) => u.includes(d))) return 2;
  return 1;
}

function sourceConfidenceFromOverlap(overlap) {
  // overlap in [0..1]
  if (overlap >= 0.7) return 0.9;
  if (overlap >= 0.55) return 0.78;
  if (overlap >= 0.4) return 0.65;
  return 0.55;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    // remove common tracking params
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch (_) {
    return String(url || "");
  }
}

function dedupeSources(srcs) {
  const out = [];
  const seen = new Set();
  for (const s of srcs || []) {
    const u = normalizeUrl(s.url);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push({ ...s, url: u });
  }
  return out;
}

function dedupeStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = normalizeSpaces(x).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(normalizeSpaces(x));
  }
  return out;
}

// --------------------------
// Keywords by language
// --------------------------

function langKeywords(lang, key) {
  const K = KEYWORDS[lang] || KEYWORDS.en;
  return (K && K[key]) || (KEYWORDS.en && KEYWORDS.en[key]) || [];
}

function topicMatch(lowerText, lang, words) {
  for (const w of words || []) {
    if (lowerText.includes(w)) return true;
  }
  return false;
}

const KEYWORDS = {
  en: {
    negations: [" not ", "n't", " no ", " never ", " false ", " untrue "],
    time_words: [" today", " now", " current", " in 20", " this year", " right now"],
    topics_politics: [" president", " prime minister", " government", " election", " senator", " congress", " parliament", " white house"],
    factual_hints: [" is ", " are ", " was ", " were ", " won ", " elected ", " announced ", " confirmed ", " according to "],
  },
  fr: {
    negations: [" ne ", " pas", " aucun", " jamais", " faux", " incorrect"],
    time_words: [" aujourd", " maintenant", " actuel", " en 20", " cette année", " en ce moment"],
    topics_politics: [" président", " premier ministre", " gouvernement", " élection", " sénateur", " congrès", " parlement", " maison-blanche", "maison blanche"],
    factual_hints: [" est ", " sont ", " était ", " ont ", " a été ", " élu", " annonc", " confirmé", " selon "],
  },
  ru: {
    negations: [" не ", " нет", " никогда", " лож", " невер"],
    time_words: [" сегодня", " сейчас", " текущ", " в 20", " в этом году"],
    topics_politics: [" президент", " премьер-министр", " правитель", " выбор", " сенат", " конгресс", " парламент"],
    factual_hints: [" является", " это", " был", " была", " были", " избран", " согласно"],
  },
  uk: {
    negations: [" не ", " ні ", " ніколи", " хиб", " неправ"],
    time_words: [" сьогодні", " зараз", " поточ", " у 20", " цього року"],
    topics_politics: [" президент", " прем'єр", " уряд", " вибор", " парламент"],
    factual_hints: [" є", " був", " була", " були", " обран", " згідно"],
  },
  es: {
    negations: [" no ", " nunca", " falso", " incorrecto"],
    time_words: [" hoy", " ahora", " actual", " en 20", " este año"],
    topics_politics: [" presidente", " primer ministro", " gobierno", " elección", " senado", " congreso", " parlamento"],
    factual_hints: [" es ", " son ", " fue ", " eran ", " ganó", " elegido", " según "],
  },
  de: {
    negations: [" nicht", " kein", " nie", " falsch", " unwahr"],
    time_words: [" heute", " jetzt", " aktuell", " in 20", " dieses jahr"],
    topics_politics: [" präsident", " kanzler", " regierung", " wahl", " senat", " kongress", " parlament"],
    factual_hints: [" ist ", " sind ", " war ", " waren ", " gewann", " gewählt", " laut "],
  },
  it: {
    negations: [" non ", " mai", " falso", " errato"],
    time_words: [" oggi", " ora", " attuale", " nel 20", " quest'anno"],
    topics_politics: [" presidente", " primo ministro", " governo", " elezion", " senato", " congresso", " parlamento"],
    factual_hints: [" è ", " sono ", " era ", " erano ", " ha vinto", " eletto", " secondo "],
  },
  ja: {
    negations: ["ない", "ではない", "違う", "誤", "偽"],
    time_words: ["今日", "今", "現在", "20", "今年"],
    topics_politics: ["大統領", "首相", "政府", "選挙", "議会"],
    factual_hints: ["である", "です", "だった", "によると"],
  },
};

// --------------------------
// Market mapping for Bing
// --------------------------

function bingMarket(lang) {
  if (lang === "fr") return "fr-CA";
  if (lang === "en") return "en-US";
  if (lang === "es") return "es-ES";
  if (lang === "de") return "de-DE";
  if (lang === "it") return "it-IT";
  if (lang === "ja") return "ja-JP";
  if (lang === "ru") return "ru-RU";
  if (lang === "uk") return "uk-UA";
  return "en-US";
}

// --------------------------
// Utils
// --------------------------

function requestId() {
  return crypto.randomBytes(8).toString("hex");
}

// --------------------------
// Start
// --------------------------

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[IA11] listening on ${PORT} — v${ENGINE_VERSION}`);
});
