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

/**
 * IA11 PRO — LeenScore Engine (single-file) — v3.0.0
 * Goal: credible outputs, contradiction-aware, conservative when evidence is weak,
 *       stable for Lovable UI, secure by key, and Serper-powered web corroboration.
 *
 * POST /v1/analyze
 * Body: { text: string, mode?: "standard"|"pro", uiLanguage?: "fr"|"en" }
 *
 * Response:
 * {
 *  status:"ok",
 *  requestId,
 *  engine:"IA11",
 *  mode,
 *  result:{
 *    score:0..100,
 *    riskLevel:"low"|"medium"|"high",
 *    summary:string,
 *    reasons:string[],
 *    confidence:0..1,
 *    breakdown:{ evidence, contradiction, writingQuality, webSearch, caution },
 *    corroboration:{ outcome, sourcesConsulted, summary },
 *    sources:[{title,url,snippet,domain,trust}],
 *    bestLinks:[{title,url}],
 *    debug:{ queriesUsed, evidenceLabel, trustSum, sourcesCount, contradictionDetected, contradictionStrength }
 *  },
 *  meta:{ tookMs, version, webSearchUsed, bypassEnabled }
 * }
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ---------- fetch safety ----------
let _fetch = global.fetch;
if (!_fetch) {
  try {
    _fetch = require("node-fetch");
  } catch (e) {
    _fetch = null;
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// =====================
// Config
// =====================
const VERSION = "3.0.0-pro";
const ENGINE = "IA11";

const API_KEY = process.env.IA11_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

// Allow bypass ONLY if you intentionally enable it. Still constrained by allowed origins.
const ALLOW_FRONTEND_BYPASS =
  String(process.env.IA11_ALLOW_FRONTEND_BYPASS || "false").toLowerCase() === "true";

// Put ONLY domains here, no protocol. Example: lovable.app, leenscore.com
const ALLOWED_ORIGINS = (process.env.IA11_ALLOWED_ORIGINS || "lovable.app,leenscore.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 120);

const SERPER_NUM = Number(process.env.SERPER_NUM || 8);
const SERPER_GL = (process.env.SERPER_GL || "ca").toLowerCase(); // country for results
const CACHE_TTL_MS = Number(process.env.IA11_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX = Number(process.env.IA11_CACHE_MAX || 300);

// =====================
// Utils
// =====================
function nowMs() {
  return Date.now();
}
function uid() {
  return crypto.randomBytes(12).toString("hex");
}
function safeStr(v, max = 6000) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}
function toDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function detectUiLanguage(raw) {
  const v = String(raw || "").toLowerCase();
  if (v.startsWith("en")) return "en";
  return "fr";
}
function pickT(lang) {
  const FR = {
    missingText: "Texte manquant. Colle un texte à analyser.",
    forbidden: "Accès refusé (clé API manquante ou invalide).",
    rate: "Trop de requêtes. Réessaie dans une minute.",
    health: "IA11 OK",
    outcomeConfirmed: "confirmé",
    outcomeContradicted: "contradictoire",
    outcomeUncertain: "incertain",
    confirmed: "Le web semble globalement cohérent avec l’affirmation.",
    contradicted: "Le web donne des signaux clairs qui contredisent l’affirmation.",
    uncertain: "Le web ne permet pas de confirmer clairement. IA11 reste prudent.",
    summaryStd: "Analyse standard : cohérence + signaux web rapides.",
    summaryPro: "Analyse PRO : corroboration web + contradictions + prudence renforcée.",
    reasonNoWeb: "Recherche web indisponible (clé Serper manquante ou fetch indisponible).",
    reasonNoSources: "Aucune source exploitable trouvée : score plafonné par prudence.",
    reasonWeak: "Preuves faibles : formulation recommandée plus prudente.",
    reasonGood: "Plusieurs sources cohérentes : crédibilité renforcée.",
    reasonContradiction: "Signaux de contradiction détectés dans les extraits web.",
    reasonShort: "Texte très court : manque de contexte, risque accru d’erreur.",
    reasonOkLength: "Texte assez détaillé : meilleure base pour juger.",
    caution: "IA11 évite d’affirmer quand les preuves ne sont pas solides.",
  };

  const EN = {
    missingText: "Missing text. Paste something to analyze.",
    forbidden: "Access denied (missing/invalid API key).",
    rate: "Too many requests. Try again in a minute.",
    health: "IA11 OK",
    outcomeConfirmed: "confirmed",
    outcomeContradicted: "contradictory",
    outcomeUncertain: "uncertain",
    confirmed: "The web looks broadly consistent with the claim.",
    contradicted: "The web shows clear signals contradicting the claim.",
    uncertain: "The web does not clearly confirm. IA11 stays conservative.",
    summaryStd: "Standard analysis: coherence + quick web signals.",
    summaryPro: "PRO analysis: web corroboration + contradictions + stronger caution.",
    reasonNoWeb: "Web search unavailable (missing Serper key or fetch runtime).",
    reasonNoSources: "No usable sources found: score capped for safety.",
    reasonWeak: "Weak evidence: recommend more cautious wording.",
    reasonGood: "Multiple consistent sources: stronger credibility.",
    reasonContradiction: "Contradiction signals detected in web snippets.",
    reasonShort: "Very short text: low context, higher risk of error.",
    reasonOkLength: "Detailed enough text: better basis to assess.",
    caution: "IA11 avoids strong claims when evidence is weak.",
  };

  return lang === "en" ? EN : FR;
}

// =====================
// CORS (stable for Lovable)
// =====================
function originAllowed(origin) {
  if (!origin) return true; // server-to-server, curl, etc.
  const o = String(origin).toLowerCase();
  return ALLOWED_ORIGINS.some((d) => o.includes(d));
}

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (originAllowed(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-ia11-key"],
    maxAge: 86400,
  })
);

app.options("*", cors());

// =====================
// Security middleware
// =====================
function requireKey(req, res, next) {
  const origin = req.headers.origin || "";
  const t = pickT(detectUiLanguage(req.body?.uiLanguage));

  // bypass only if explicitly enabled AND origin allowed
  if (ALLOW_FRONTEND_BYPASS && originAllowed(origin)) return next();

  const key = String(req.headers["x-ia11-key"] || "");
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({
      status: "error",
      requestId: uid(),
      error: { message: t.forbidden },
    });
  }
  return next();
}

// =====================
// Rate limiting (memory, per minute)
// =====================
const rateStore = new Map(); // key -> { tsBucket, count }
function rateLimit(req, res, next) {
  const mode = req.body?.mode === "pro" ? "pro" : "standard";
  const limit = mode === "pro" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const t = pickT(detectUiLanguage(req.body?.uiLanguage));

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const bucket = Math.floor(nowMs() / 60000);
  const k = `${ip}:${mode}`;

  const cur = rateStore.get(k);
  if (!cur || cur.tsBucket !== bucket) {
    rateStore.set(k, { tsBucket: bucket, count: 1 });
    return next();
  }

  cur.count += 1;
  rateStore.set(k, cur);

  if (cur.count > limit) {
    return res.status(429).json({
      status: "error",
      requestId: uid(),
      error: { message: t.rate },
    });
  }

  return next();
}

// =====================
// Cache (simple LRU-ish)
// =====================
const cache = new Map(); // key -> { exp, val }
function cacheGet(key) {
  const it = cache.get(key);
  if (!it) return null;
  if (it.exp <= nowMs()) {
    cache.delete(key);
    return null;
  }
  // refresh for LRU-ish behavior
  cache.delete(key);
  cache.set(key, it);
  return it.val;
}
function cacheSet(key, val) {
  // trim oldest
  while (cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { exp: nowMs() + CACHE_TTL_MS, val });
}

// =====================
// Serper web search
// =====================
async function serperSearch(query, uiLanguage, opts = {}) {
  if (!SERPER_API_KEY) return { ok: false, items: [], error: "Missing SERPER_API_KEY" };
  if (!_fetch) return { ok: false, items: [], error: "Missing fetch runtime (node-fetch not installed)" };

  const lang = detectUiLanguage(uiLanguage);
  const hl = lang === "en" ? "en" : "fr";
  const gl = SERPER_GL;

  const noCache = !!opts.noCache || String(process.env.SERPER_DISABLE_CACHE || "").toLowerCase() === "true";

  const cacheKey = `serper:${hl}:${gl}:${query}`;
  if (!noCache) {
    const cached = cacheGet(cacheKey);
    if (cached) return { ok: true, items: cached, error: null, cached: true };
  }

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

  const items = organic
    .map((x) => ({
      title: safeStr(x?.title, 200),
      url: safeStr(x?.link, 600),
      snippet: safeStr(x?.snippet, 500),
    }))
    .filter((x) => x.url && x.title);

  if (!noCache) cacheSet(cacheKey, items);
  return { ok: true, items, error: null, cached: false };
}


  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, items: [], error: `Serper error ${r.status}: ${txt.slice(0, 200)}` };
  }

  const json = await r.json();
  const organic = Array.isArray(json?.organic) ? json.organic : [];

  const items = organic
    .map((x) => ({
      title: safeStr(x?.title, 200),
      url: safeStr(x?.link, 600),
      snippet: safeStr(x?.snippet, 500),
    }))
    .filter((x) => x.url && x.title);

  cacheSet(cacheKey, items);
  return { ok: true, items, error: null, cached: false };
}

// =====================
// Query building (PRO = smarter)
// =====================
function cleanForQuery(s) {
  return safeStr(s, 400).replace(/\s+/g, " ").trim();
}

function extractKeywords(text) {
  const raw = safeStr(text, 1200).toLowerCase();
  // crude keyword extraction: keep longer words, remove common fillers
  const stop = new Set([
    "le","la","les","un","une","des","du","de","d","et","ou","mais","donc","car","que","qui","quoi","où",
    "the","a","an","and","or","but","so","because","that","this","these","those","what","who","where",
    "is","are","was","were","être","est","sont","était","étaient","avec","sans","pour","par","sur","dans","en",
  ]);
  const words = raw
    .replace(/[^a-z0-9àâçéèêëîïôûùüÿñæœ\s-]/gi, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !stop.has(w));
  // keep unique, most frequent first
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map((x) => x[0]);
}

function looksTimeSensitive(text) {
  const t = text.toLowerCase();
  // years or "current" roles
  if (/\b(20\d{2})\b/.test(t)) return true;
  if (/(président|prime minister|premier ministre|ceo|pdg|actuel|currently|en 20\d{2})/.test(t)) return true;
  return false;
}

function buildQueries(text, mode, lang) {
  const base = cleanForQuery(text);
  const kws = extractKeywords(base);

  const q1 = base.length <= 140 ? `"${base}"` : `"${base.slice(0, 140)}"`;
  const q2 = kws.length ? kws.slice(0, 6).join(" ") : base.split(" ").slice(0, 6).join(" ");

  const factWord = lang === "en" ? "fact check" : "vérification des faits";
  const currentWord = lang === "en" ? "current" : "actuel";

  if (mode === "pro") {
    const q3 = looksTimeSensitive(base)
      ? `${q2} ${factWord} ${currentWord}`
      : `${q2} ${factWord}`;

    // PRO: 3 queries, first is exact-ish, then keyword mix, then fact-check oriented
    return [q1, q2, q3].map((x) => cleanForQuery(x)).filter(Boolean);
  }

  // Standard: lighter
  return [q1, q2].map((x) => cleanForQuery(x)).filter(Boolean);
}

async function serperMultiSearch(text, mode, uiLanguage, opts = {}) {
  const lang = detectUiLanguage(uiLanguage);
  const queries = buildQueries(text, mode, lang);

  const forceFresh = !!opts.forceFresh;

  let all = [];
  let okCount = 0;
  let lastError = null;
  let cachedUsed = false;

  for (const q of queries) {
    try {
      const out = await serperSearch(q, lang, { noCache: forceFresh });
      if (out.ok) {
        okCount += 1;
        if (out.cached) cachedUsed = true;
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
    cachedUsed,
  };
}


  return {
    ok: okCount > 0,
    items: all,
    error: okCount > 0 ? null : lastError || "Unknown search error",
    queries,
  };
}

// =====================
// Source trust scoring (fast heuristic)
// =====================
function trustScoreByDomain(domain) {
  if (!domain) return 0.3;

  // strong
  if (domain.endsWith(".gov") || domain.includes(".gouv.")) return 0.98;
  if (domain.endsWith(".edu")) return 0.92;
  if (domain.endsWith(".org")) return 0.75;

  // reputable news / references (heuristic list, can expand later)
  const strong = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "theguardian.com",
    "nytimes.com",
    "washingtonpost.com",
    "cbc.ca",
    "radio-canada.ca",
    "lemonde.fr",
    "france24.com",
    "who.int",
    "un.org",
    "oecd.org",
    "worldbank.org",
    "encyclopedia.com",
    "britannica.com",
    "wikipedia.org",
  ];
  if (strong.some((d) => domain.endsWith(d))) return 0.85;

  // medium
  const medium = ["medium.com", "blogspot.", "wordpress."];
  if (medium.some((d) => domain.includes(d))) return 0.45;

  // default
  return 0.55;
}

function cleanSources(items) {
  const seen = new Set();
  const out = [];

  for (const it of items || []) {
    const url = safeStr(it?.url, 600);
    const title = safeStr(it?.title, 200);
    const snippet = safeStr(it?.snippet, 500);
    if (!url || !title) continue;

    const key = url.toLowerCase().split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);

    const domain = toDomain(url);
    const trust = trustScoreByDomain(domain);

    out.push({ title, url, snippet, domain, trust });
  }

  // sort best first
  out.sort((a, b) => (b.trust - a.trust));
  return out.slice(0, 12);
}

function computeEvidence(sources) {
  const sCount = sources.length;
  const trustSum = sources.reduce((acc, s) => acc + (s.trust || 0), 0);
  const avgTrust = sCount ? trustSum / sCount : 0;

  let label = "none";
  if (sCount >= 6 && avgTrust >= 0.72) label = "strong";
  else if (sCount >= 3 && avgTrust >= 0.62) label = "medium";
  else if (sCount >= 1) label = "weak";

  return { sCount, trustSum: round2(trustSum), avgTrust: round2(avgTrust), label };
}

// =====================
// Contradiction detection (snippet-based, conservative)
// =====================
function normalizeTextForMatch(s) {
  return safeStr(s, 2000).toLowerCase().replace(/\s+/g, " ").trim();
}

// Very light claim extraction: "X is Y" / "X est Y" + optional negation
function extractSimpleClaim(text, lang) {
  const t = safeStr(text, 800).trim();
  const lower = t.toLowerCase();

  if (lang === "fr") {
    // "X est Y" or "X n'est pas Y"
    let m = lower.match(/^(.{2,70})\s+n['’]est\s+pas\s+(.{2,90})$/i);
    if (m) return { subject: m[1].trim(), object: m[2].trim(), neg: true };
    m = lower.match(/^(.{2,70})\s+est\s+(.{2,90})$/i);
    if (m) return { subject: m[1].trim(), object: m[2].trim(), neg: false };
  }

  if (lang === "en") {
    // "X is Y" or "X is not Y"
    let m = lower.match(/^(.{2,70})\s+is\s+not\s+(.{2,90})$/i);
    if (m) return { subject: m[1].trim(), object: m[2].trim(), neg: true };
    m = lower.match(/^(.{2,70})\s+is\s+(.{2,90})$/i);
    if (m) return { subject: m[1].trim(), object: m[2].trim(), neg: false };
  }

  return null;
}

function assessContradiction(text, sources, lang) {
  const claim = extractSimpleClaim(text, lang);
  if (!claim) {
    return { detected: false, strength: 0, support: 0, oppose: 0, note: null };
  }

  const subj = normalizeTextForMatch(claim.subject);
  const obj = normalizeTextForMatch(claim.object);

  let support = 0;
  let oppose = 0;

  for (const s of sources) {
    const sn = normalizeTextForMatch(s.snippet || "");
    const ti = normalizeTextForMatch(s.title || "");
    const pack = `${ti} ${sn}`;

    const hasSubj = subj.length >= 4 && pack.includes(subj);
    if (!hasSubj) continue;

    const hasObj = obj.length >= 4 && pack.includes(obj);
    const hasNeg = /\b(not|n['’]est pas|false|faux|hoax)\b/.test(pack);

    if (!claim.neg) {
      // claim says "X is Y": support if hasObj and no clear neg, oppose if strong neg + mention
      if (hasObj && !hasNeg) support += 1;
      if (hasNeg && !hasObj) oppose += 1;
    } else {
      // claim says "X is not Y": support if neg present, oppose if obj present without neg
      if (hasNeg) support += 1;
      if (hasObj && !hasNeg) oppose += 1;
    }
  }

  const strength = clamp(Math.abs(support - oppose) / 4, 0, 1);

  // Detect contradiction only when there's a meaningful imbalance
  const detected = support + oppose >= 2 && strength >= 0.35;

  let note = null;
  if (detected) {
    if (support > oppose) note = "support";
    else if (oppose > support) note = "oppose";
    else note = "mixed";
  }

  return { detected, strength: round2(strength), support, oppose, note };
}

// =====================
// Scoring (conservative, avoids dumb certainty)
// =====================
function scoreFromSignals(textLen, evidence, contradiction, mode) {
  // base score from evidence quality
  let score = 40;

  if (evidence.label === "strong") score += 35;
  else if (evidence.label === "medium") score += 22;
  else if (evidence.label === "weak") score += 10;
  else score += 0;

  // text length helps reduce risk of misinterpretation
  if (textLen < 80) score -= 10;
  else if (textLen < 160) score -= 4;
  else score += 3;

  // contradiction penalties (strong)
  if (contradiction.detected) {
    if (contradiction.note === "oppose") score -= 28;
    else if (contradiction.note === "mixed") score -= 16;
    else score += 6; // supportive contradiction check
  }

  // PRO gets slightly more demanding: if evidence is weak, cap confidence harder
  const cap = mode === "pro" ? 95 : 92;
  score = clamp(score, 5, cap);

  // risk level
  let riskLevel = "medium";
  if (score >= 78) riskLevel = "low";
  else if (score <= 44) riskLevel = "high";

  // outcome
  let outcome = "uncertain";
  if (evidence.label === "strong" && (!contradiction.detected || contradiction.note === "support")) outcome = "confirmed";
  if (contradiction.detected && contradiction.note === "oppose" && evidence.label !== "none") outcome = "contradicted";

  // confidence: conservative
  let confidence = 0.45;
  if (evidence.label === "strong") confidence = 0.86;
  else if (evidence.label === "medium") confidence = 0.72;
  else if (evidence.label === "weak") confidence = 0.58;

  if (textLen < 80) confidence -= 0.10;
  if (contradiction.detected && contradiction.note === "oppose") confidence -= 0.18;
  if (mode === "pro" && evidence.label === "weak") confidence -= 0.08;

  confidence = clamp(confidence, 0.25, 0.92);

  return { score: Math.round(score), riskLevel, confidence: round2(confidence), outcome };
}

function buildBreakdown(lang, evidence, textLen, contradiction, webUsed) {
  const t = pickT(lang);
  return {
    evidence: {
      label: evidence.label,
      sourcesCount: evidence.sCount,
      avgTrust: evidence.avgTrust,
      trustSum: evidence.trustSum,
    },
    contradiction: {
      detected: Boolean(contradiction.detected),
      strength: contradiction.strength || 0,
      support: contradiction.support || 0,
      oppose: contradiction.oppose || 0,
      note: contradiction.note || null,
    },
    writingQuality: {
      length: textLen,
      note: textLen < 80 ? t.reasonShort : t.reasonOkLength,
    },
    webSearch: {
      used: Boolean(webUsed),
      caution: t.caution,
    },
    caution: {
      principle: t.caution,
    },
  };
}

function makeSummary(lang, mode, score, riskLevel, evidenceLabel, outcome, sourcesCount) {
  const t = pickT(lang);
  const head = mode === "pro" ? t.summaryPro : t.summaryStd;
  const ev = lang === "en" ? `Evidence: ${evidenceLabel}` : `Preuves: ${evidenceLabel}`;
  const out = lang === "en" ? `Outcome: ${outcome}` : `Verdict: ${outcome}`;
  const src = lang === "en" ? `${sourcesCount} sources` : `${sourcesCount} sources`;
  return `${head} • Score ${score}/100 • Risk ${riskLevel} • ${ev} • ${out} • ${src}`;
}

function makeReasons(lang, mode, textLen, evidence, webOk, searchError, contradiction) {
  const t = pickT(lang);
  const reasons = [];

  if (textLen < 80) reasons.push(t.reasonShort);
  else reasons.push(t.reasonOkLength);

  if (!webOk) reasons.push(`${t.reasonNoWeb}${searchError ? ` (${searchError})` : ""}`);
  else if (evidence.sCount === 0) reasons.push(t.reasonNoSources);
  else if (evidence.label === "weak") reasons.push(t.reasonWeak);
  else reasons.push(t.reasonGood);

  if (contradiction.detected) reasons.push(t.reasonContradiction);

  // PRO: add stronger caution if evidence not strong
  if (mode === "pro" && evidence.label !== "strong") reasons.push(t.caution);

  return reasons.slice(0, 6);
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.json({ status: "ok", engine: ENGINE, version: VERSION, message: pickT("fr").health });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE,
    version: VERSION,
    endpoints: {
      postAnalyze: "/v1/analyze",
    },
    requiredHeader: "x-ia11-key",
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
  let cachedUsed = false;
  let forceFresh = false;


  try {
  forceFresh = mode === "pro" && looksTimeSensitive(text);
  const out = await serperMultiSearch(text, mode, lang, { forceFresh });

  searchOk = out.ok;
  cachedUsed = out.cachedUsed;

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

  const breakdown = buildBreakdown(lang, evidence, textLen, contradiction, searchOk && sources.length > 0);
  const summary = makeSummary(lang, mode, scored.score, scored.riskLevel, evidence.label, scored.outcome, evidence.sCount);
  const reasons = makeReasons(lang, mode, textLen, evidence, searchOk, searchError, contradiction);

  const tookMs = nowMs() - t0;

  const corroboration = {
    outcome:
      scored.outcome === "confirmed"
        ? t.outcomeConfirmed
        : scored.outcome === "contradicted"
        ? t.outcomeContradicted
        : t.outcomeUncertain,
    sourcesConsulted: evidence.sCount,
    summary:
      scored.outcome === "confirmed"
        ? t.confirmed
        : scored.outcome === "contradicted"
        ? t.contradicted
        : t.uncertain,
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
        trust: round2(s.trust || 0),
      })),
      bestLinks: sources.map((s) => ({ title: s.title, url: s.url })),
      debug: {
        queriesUsed,
        evidenceLabel: evidence.label,
        trustSum: evidence.trustSum,
        sourcesCount: evidence.sCount,
        contradictionDetected: Boolean(contradiction.detected),
        contradictionStrength: contradiction.strength || 0,
      },
    },
   meta: {
  tookMs,
  version: VERSION,
  webSearchUsed: searchOk && sources.length > 0,
  webSearchCachedUsed: cachedUsed,
  webSearchForceFresh: forceFresh,
  bypassEnabled: ALLOW_FRONTEND_BYPASS,
},

// =====================
// Start
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[IA11 PRO] listening on :${port} | version ${VERSION}`);
});
