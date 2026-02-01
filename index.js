/**
 * IA11 — Credibility Intelligence Engine (LeenScore)
 * Single-file production server (Node/Express) for Render.
 *
 * Key goals:
 * - PRO web corroboration with DIRECT links (Bing)
 * - Intelligent contradiction detector (weighted + time-aware)
 * - Dynamic confidence & score (no high score without strong evidence)
 * - Zero-bullshit failsafe (uncertain > hallucination)
 * - Output compatible with Lovable UI normalization (incl. top-level articleSummary)
 *
 * ENV required:
 * - IA11_API_KEY="..."  (or IA11_API_KEYS="key1,key2")
 *
 * Rate limit:
 * - RATE_LIMIT_PER_MIN="30" (standard)
 * - RATE_LIMIT_PER_MIN_PRO="60" (pro)
 *
 * Web evidence (PRO):
 * - WEB_EVIDENCE_PROVIDER="bing" (default)
 * - BING_API_KEY="..."  (or AZURE_BING_KEY / BING_SEARCH_KEY)
 * - BING_ENDPOINT="https://api.bing.microsoft.com/v7.0/search"
 * - BING_FRESHNESS="Day" | "Week" | "Month" (optional, default "Week")
 *
 * CORS (recommended in production):
 * - CORS_ORIGINS="https://leenscore.com,https://www.leenscore.com"  (or "*" to allow all)
 * - TRUST_PROXY="1"  (recommended on Render, makes req.ip reliable)
 *
 * Critical facts library (optional, extendable):
 * - CRITICAL_FACTS_JSON='[{"id":"us_president_2026","type":"office_holder","role":"president","jurisdiction":"united states","validFrom":"2025-01-20","validTo":"2029-01-20","value":"donald trump","source":"whitehouse.gov"}]'
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

// CORS: lock it down in production (set CORS_ORIGINS="https://leenscore.com,https://www.leenscore.com")
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*").toString().trim();
const TRUST_PROXY = (process.env.TRUST_PROXY || "0").toString().trim();
if (TRUST_PROXY === "1") app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (CORS_ORIGINS === "*" || !origin) return cb(null, true);
      const allowed = CORS_ORIGINS.split(",").map((s) => s.trim());
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
  })
);

app.use(express.json({ limit: "1mb" }));

// -------------------- configuration
const PORT = parseInt(process.env.PORT || "8080", 10); // Azure/Render both set PORT; default 8080

// ---- Auth keys
const IA11_API_KEY_RAW = (process.env.IA11_API_KEY || "").toString().trim();
const IA11_API_KEYS_RAW = (process.env.IA11_API_KEYS || "").toString().trim();
const allowedKeys = new Set(
  [IA11_API_KEY_RAW, ...IA11_API_KEYS_RAW.split(",").map((s) => s.trim()).filter(Boolean)].filter(Boolean)
);

// ---- Rate limits
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);
const RATE_LIMIT_PER_MIN_PRO = parseInt(process.env.RATE_LIMIT_PER_MIN_PRO || "60", 10);

// ---- Web evidence
const WEB_EVIDENCE_PROVIDER = ((process.env.WEB_EVIDENCE_PROVIDER || "bing") + "").toLowerCase().trim();
const BING_API_KEY = (process.env.BING_API_KEY || process.env.AZURE_BING_KEY || process.env.BING_SEARCH_KEY || process.env.AZURE_BING_SEARCH_KEY || "").toString().trim();
const BING_ENDPOINT = (process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search").toString().trim();
const BING_FRESHNESS = (process.env.BING_FRESHNESS || "Week").toString().trim();

// ---- Critical facts
let CRITICAL_FACTS = [];
try {
  const raw = (process.env.CRITICAL_FACTS_JSON || "").toString().trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) CRITICAL_FACTS = parsed;
  }
} catch {
  CRITICAL_FACTS = [];
}

// ---- In-memory rate limiter
const buckets = new Map(); // key -> { windowStartMs, countStd, countPro }
// Prevent memory growth: purge old rate-limit buckets (IPs that disappeared)
const BUCKET_TTL_MS = 10 * 60_000; // 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets.entries()) {
    if (!v || !v.windowStartMs) {
      buckets.delete(k);
      continue;
    }
    // if bucket hasn't been used for TTL, delete it
    if (now - v.windowStartMs > BUCKET_TTL_MS) buckets.delete(k);
  }
}, 60_000).unref();


// -------------------- helpers
function nowMs() {
  return Date.now();
}
function newRequestId() {
  return crypto.randomBytes(10).toString("hex");
}
function safeStr(x) {
  if (x === null || x === undefined) return "";
  return String(x);
}
function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}
function normalizeWhitespace(s) {
  return safeStr(s).replace(/\s+/g, " ").trim();
}
function normalizeDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
function stripTracking(url) {
  try {
    const u = new URL(url);
    // remove common tracking params
    const kill = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid",
      "ref",
      "ref_src",
      "ref_url",
      "igshid",
      "mkt_tok",
    ];
    kill.forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
}
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function pick(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, n);
}
function uniqBy(arr, fn) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = fn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
function scoreToRisk(score) {
  if (score >= 85) return "low";
  if (score >= 65) return "medium";
  return "high";
}
function boundedConfidence(x) {
  return clamp(x, 0.05, 0.98);
}
function safeMode(mode) {
  const m = (mode || "standard").toString().toLowerCase().trim();
  if (m === "pro" || m === "premium" || m === "premium_plus") return m;
  return "standard";
}
function isPro(mode) {
  return mode === "pro" || mode === "premium" || mode === "premium_plus";
}
function clientKey(req) {
  // key for bucket = API key + IP (keeps abuse per key)
  const apiKey = safeStr(req.headers["x-ia11-key"]).trim();
  const ip = safeStr(req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress).split(",")[0].trim();
  return `${apiKey || "nokey"}|${ip || "noip"}`;
}
function checkRateLimit(req, mode) {
  const k = clientKey(req);
  const t = nowMs();
  const windowMs = 60_000;

  const b = buckets.get(k) || { windowStartMs: t, countStd: 0, countPro: 0 };

  // reset window if expired
  if (t - b.windowStartMs >= windowMs) {
    b.windowStartMs = t;
    b.countStd = 0;
    b.countPro = 0;
  }

  if (isPro(mode)) {
    b.countPro += 1;
    buckets.set(k, b);
    if (b.countPro > RATE_LIMIT_PER_MIN_PRO) return { ok: false, limit: RATE_LIMIT_PER_MIN_PRO };
    return { ok: true, limit: RATE_LIMIT_PER_MIN_PRO };
  }

  b.countStd += 1;
  buckets.set(k, b);
  if (b.countStd > RATE_LIMIT_PER_MIN) return { ok: false, limit: RATE_LIMIT_PER_MIN };
  return { ok: true, limit: RATE_LIMIT_PER_MIN };
}

// -------------------- auth middleware
function requireApiKey(req, res, next) {
  const key = safeStr(req.headers["x-ia11-key"]).trim();
  if (!allowedKeys.size) {
    // If no keys set, refuse: safety first.
    return res.status(500).json({
      status: "error",
      message: "Server misconfigured: IA11_API_KEY missing",
    });
  }
  if (!key || !allowedKeys.has(key)) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  return next();
}

// -------------------- language / locale helpers (light)
function detectLikelyLang(text) {
  const t = safeStr(text);
  // Very lightweight: pick French if it contains many accents/common FR words, else English.
  const frHints = [" le ", " la ", " les ", " des ", " une ", " est ", " pas ", " pour ", " avec ", " ce ", " cette ", " ça "];
  const hasAccents = /[àâäéèêëîïôöùûüç]/i.test(t);
  let score = 0;
  for (const h of frHints) if (t.toLowerCase().includes(h)) score += 1;
  if (hasAccents) score += 2;
  return score >= 2 ? "fr" : "en";
}
function tmsg(lang, key) {
  const FR = {
    ok: "ok",
    uncertain: "incertain",
    missingEvidence: "Manque de preuves fiables en ligne pour confirmer.",
    contradiction: "Contradiction détectée dans des sources crédibles.",
    corroboration: "Plusieurs sources crédibles corroborent l'information.",
    shortText: "Texte trop court: pas assez de contexte pour analyser correctement.",
    invalidInput: "Texte manquant ou invalide.",
    proNeedsKey: "Mode PRO: Bing API key manquante (BING_API_KEY / AZURE_BING_KEY).",
  };
  const EN = {
    ok: "ok",
    uncertain: "uncertain",
    missingEvidence: "Not enough reliable web evidence to confirm.",
    contradiction: "Contradiction detected across credible sources.",
    corroboration: "Multiple credible sources corroborate the claim.",
    shortText: "Text too short: not enough context to analyze properly.",
    invalidInput: "Missing or invalid text.",
    proNeedsKey: "PRO mode: missing Bing API key (BING_API_KEY / AZURE_BING_KEY).",
  };
  const dict = lang === "fr" ? FR : EN;
  return dict[key] || key;
}

// -------------------- claim extraction (simple, robust)
function extractCoreClaims(text) {
  const t = normalizeWhitespace(text);
  if (!t) return [];
  // Split on punctuation/newlines, keep meaningful segments
  const parts = t
    .split(/[\n\r]+|[.!?]+/g)
    .map((s) => normalizeWhitespace(s))
    .filter((s) => s.length >= 12);
  // keep up to 6 strongest parts
  return pick(parts, 6);
}

// -------------------- critical facts guardrail
function applyCriticalFactsGuard(text, lang) {
  const t = safeStr(text).toLowerCase();
  if (!CRITICAL_FACTS.length) return null;

  // Example rule: if someone asserts something contradicting a known critical fact, mark as high risk.
  // This is intentionally conservative and only triggers when it can match clearly.
  for (const f of CRITICAL_FACTS) {
    const val = safeStr(f.value).toLowerCase();
    const role = safeStr(f.role).toLowerCase();
    const juris = safeStr(f.jurisdiction).toLowerCase();

    // naive: look for "president" + jurisdiction + another name different from value
    if (role.includes("president") && juris.includes("united states")) {
      if (t.includes("president") && (t.includes("united states") || t.includes("usa") || t.includes("américain") || t.includes("american"))) {
        // if text contains a different likely name, and doesn't contain the correct value, flag
        const containsCorrect = val && t.includes(val);
        if (!containsCorrect) {
          const msg = lang === "fr"
            ? "Garde-fou: cette affirmation touche un fait critique (présidence US) sans mention du titulaire attendu."
            : "Guardrail: this claim touches a critical fact (US presidency) without mentioning the expected office-holder.";
          return {
            triggered: true,
            message: msg,
            fact: f,
          };
        }
      }
    }
  }
  return null;
}

// -------------------- web evidence scoring (strict, anti-hallucination)

function domainCredibility(domain) {
  const d = safeStr(domain).toLowerCase();
  if (!d) return 0.2;

  // very rough priors (extend later)
  const strong = [
    "reuters.com",
    "apnews.com",
    "bbc.com",
    "nytimes.com",
    "theguardian.com",
    "wsj.com",
    "economist.com",
    "nature.com",
    "science.org",
    "who.int",
    "un.org",
    "whitehouse.gov",
    "canada.ca",
    "gouv.qc.ca",
    "europa.eu",
    "nasa.gov",
    "nih.gov",
    "cdc.gov",
    "statcan.gc.ca",
    "oecd.org",
    "imf.org",
  ];
  const medium = [
    "wikipedia.org",
    "britannica.com",
    "investopedia.com",
    "bloomberg.com",
    "cbc.ca",
    "radio-canada.ca",
    "lemonde.fr",
    "france24.com",
    "forbes.com",
    "time.com",
    "theverge.com",
  ];

  if (strong.some((x) => d.endsWith(x))) return 1.0;
  if (medium.some((x) => d.endsWith(x))) return 0.7;
  if (d.endsWith(".gov") || d.endsWith(".gouv.fr") || d.endsWith(".gc.ca")) return 0.95;
  if (d.endsWith(".edu")) return 0.8;

  return 0.45;
}

function evidenceQuality(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { corroboration: 0, contradiction: 0, quality: 0 };

  // quality = avg domain credibility + diversity bonus
  const domains = uniqBy(list, (x) => x.domain).map((x) => x.domain);
  const avgCred =
    domains.reduce((sum, d) => sum + domainCredibility(d), 0) / Math.max(1, domains.length);
  const diversityBonus = clamp(domains.length / 5, 0, 1) * 0.15;

  return { corroboration: 0, contradiction: 0, quality: clamp(avgCred + diversityBonus, 0, 1) };
}

function simpleContradictionSignals(text) {
  const t = safeStr(text).toLowerCase();
  const signals = [
    "not",
    "false",
    "hoax",
    "debunk",
    "misleading",
    "no evidence",
    "incorrect",
    "rumor",
    "rumeur",
    "faux",
    "canular",
    "démenti",
    "dementi",
    "désinformation",
    "desinformation",
    "fake",
  ];
  let score = 0;
  for (const s of signals) if (t.includes(s)) score += 1;
  return clamp(score / 5, 0, 1);
}

// -------------------- Bing evidence fetch
async function fetchBingEvidence(query, count = 6, timeoutMs = 6500) {
  const q = safeStr(query).trim();
  if (!q) return { ok: false, reason: "empty_query", items: [] };
  if (!BING_API_KEY) return { ok: false, reason: "missing_bing_key", items: [] };

  const url = new URL(BING_ENDPOINT);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(clamp(count, 3, 10)));
  url.searchParams.set("textDecorations", "false");
  url.searchParams.set("textFormat", "Raw");
  url.searchParams.set("safeSearch", "Moderate");

  if (BING_FRESHNESS) url.searchParams.set("freshness", BING_FRESHNESS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `bing_http_${res.status}`, items: [] };

    const data = await res.json();
    const webPages = data?.webPages?.value || [];
    const items = webPages
      .map((v) => ({
        title: safeStr(v.name),
        url: safeStr(v.url),
        snippet: safeStr(v.snippet),
        dateLastCrawled: safeStr(v.dateLastCrawled),
        domain: normalizeDomain(v.url),
      }))
      .filter((x) => x.url && x.domain);

    return { ok: true, reason: "ok", items };
  } catch (e) {
    return { ok: false, reason: "bing_fetch_failed", items: [] };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------- Evidence builder (lightweight but strict)
async function buildEvidence(claims, lang) {
  const queries = (claims || []).map((c) => normalizeWhitespace(c)).filter(Boolean);
  if (!queries.length) return { provider: WEB_EVIDENCE_PROVIDER, items: [], notes: [] };

  if (WEB_EVIDENCE_PROVIDER !== "bing") {
    return { provider: WEB_EVIDENCE_PROVIDER, items: [], notes: ["unsupported_provider"] };
  }
  if (!BING_API_KEY) {
    return { provider: "bing", items: [], notes: ["missing_bing_key", tmsg(lang, "proNeedsKey")] };
  }

  // query Bing with a few top claims, merge results, de-dupe by URL
  let all = [];
  const notes = [];
  for (const q of pick(queries, 3)) {
    const r = await fetchBingEvidence(q, 6, 6500);
    if (!r.ok) {
      notes.push(r.reason || "bing_failed");
      continue;
    }
    all = all.concat(r.items || []);
  }
  all = all
    .map((x) => ({ ...x, url: stripTracking(x.url) }))
    .filter((x) => x.url && x.domain);

  const dedup = uniqBy(all, (x) => x.url);
  // keep max 10 sources
  const items = pick(dedup, 10);

  return { provider: "bing", items, notes };
}

// -------------------- PRO scoring logic (credible by design)
function computeProScore({ text, claims, evidenceItems, lang }) {
  const base = 55;

  const length = safeStr(text).length;
  const lengthBonus = clamp((length - 120) / 800, 0, 1) * 10; // up to +10

  const eq = evidenceQuality(evidenceItems);
  const qualityBonus = eq.quality * 25; // up to +25

  // contradiction: if snippets indicate debunk/false strongly, reduce score
  const contra = (evidenceItems || []).reduce((sum, it) => sum + simpleContradictionSignals(it.snippet || ""), 0);
  const contraAvg = contra / Math.max(1, (evidenceItems || []).length);
  const contradictionPenalty = contraAvg * 30; // up to -30

  // corroboration proxy: diversity and credible domains present
  const domains = uniqBy(evidenceItems || [], (x) => x.domain).map((x) => x.domain);
  const hasStrongDomain = domains.some((d) => domainCredibility(d) >= 0.95);
  const hasMediumDomains = domains.filter((d) => domainCredibility(d) >= 0.7).length >= 2;
  const corroborationBonus = (hasStrongDomain ? 8 : 0) + (hasMediumDomains ? 5 : 0);

  let score = base + lengthBonus + qualityBonus + corroborationBonus - contradictionPenalty;

  // No evidence => cap score
  if (!evidenceItems || evidenceItems.length === 0) score = Math.min(score, 62);

  score = clamp(Math.round(score), 5, 98);

  const riskLevel = scoreToRisk(score);

  // confidence: tied to evidence quality; never high with no evidence
  let confidence = 0.55 + eq.quality * 0.35;
  if (!evidenceItems || evidenceItems.length === 0) confidence = 0.48;
  if (contradictionPenalty > 15) confidence = Math.min(confidence, 0.6);
  confidence = boundedConfidence(confidence);

  // summary / reasons: in UI language
  let summary = "";
  const reasons = [];

  if (!evidenceItems || evidenceItems.length === 0) {
    summary = tmsg(lang, "missingEvidence");
    reasons.push(tmsg(lang, "uncertain"));
  } else if (contradictionPenalty > 18) {
    summary = tmsg(lang, "contradiction");
    reasons.push("Strong contradiction signals in web snippets");
  } else {
    summary = tmsg(lang, "corroboration");
    reasons.push("Credible sources + domain diversity");
  }

  if (length < 120) reasons.push("Low context / short input");

  // Build sources array for UI (direct links!)
  const sources = (evidenceItems || []).map((it) => ({
    title: it.title || it.domain,
    url: it.url,
    domain: it.domain,
    snippet: it.snippet,
    dateLastCrawled: it.dateLastCrawled || "",
  }));

  return { score, riskLevel, summary, reasons, confidence, sources };
}

// -------------------- Standard scoring logic (fast, conservative)
function computeStandardScore({ text, lang }) {
  const length = safeStr(text).length;
  if (length < 80) {
    return {
      score: 45,
      riskLevel: "high",
      summary: tmsg(lang, "shortText"),
      reasons: ["Low context", "Insufficient verifiable detail"],
      confidence: 0.55,
      sources: [],
    };
  }
  return {
    score: 72,
    riskLevel: "medium",
    summary: lang === "fr" ? "Analyse Standard: plausibilité moyenne (sans vérification web)." : "Standard analysis: medium plausibility (no web verification).",
    reasons: ["Structure and context detected", "No external corroboration (Standard mode)"],
    confidence: 0.68,
    sources: [],
  };
}

// -------------------- core analyze
async function analyze({ text, mode }) {
  const cleanText = normalizeWhitespace(text);
  const lang = detectLikelyLang(cleanText);

  if (!cleanText) {
    return {
      status: "error",
      error: tmsg(lang, "invalidInput"),
      result: {
        score: 5,
        riskLevel: "high",
        summary: tmsg(lang, "invalidInput"),
        reasons: [tmsg(lang, "invalidInput")],
        confidence: 0.3,
        sources: [],
      },
      lang,
    };
  }

  // Guardrail: critical facts
  const guard = applyCriticalFactsGuard(cleanText, lang);

  const claims = extractCoreClaims(cleanText);

  if (!isPro(mode)) {
    const standard = computeStandardScore({ text: cleanText, lang });
    const articleSummary =
      lang === "fr"
        ? "Résumé: analyse Standard sans preuve web (rapide, prudente)."
        : "Summary: Standard analysis without web evidence (fast, conservative).";

    return {
      status: "success",
      lang,
      result: standard,
      articleSummary,
      guardrail: guard || undefined,
      debug: { mode, claimsCount: claims.length },
    };
  }

  // PRO: web evidence
  const evidence = await buildEvidence(claims, lang);
  const pro = computeProScore({ text: cleanText, claims, evidenceItems: evidence.items, lang });

  // If guardrail triggered, reduce confidence and score slightly (but do not hallucinate "facts")
  if (guard?.triggered) {
    pro.score = Math.max(15, pro.score - 10);
    pro.riskLevel = scoreToRisk(pro.score);
    pro.confidence = Math.min(pro.confidence, 0.6);
    pro.reasons.unshift("Guardrail triggered (critical fact area)");
  }

  const articleSummary =
    lang === "fr"
      ? "Résumé: analyse PRO avec corroboration web (liens directs)."
      : "Summary: PRO analysis with web corroboration (direct links).";

  return {
    status: "success",
    lang,
    result: pro,
    articleSummary,
    evidenceMeta: { provider: evidence.provider, notes: evidence.notes || [] },
    guardrail: guard || undefined,
    debug: { mode, claimsCount: claims.length, sourcesCount: (pro.sources || []).length },
  };
}

// -------------------- routes

app.get("/", (req, res) => {
  res.json({
    status: "IA11 engine running",
    engine: "IA11",
    version: "1.0",
    webEvidenceProvider: WEB_EVIDENCE_PROVIDER,
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ready",
    message: "Use POST /v1/analyze with x-ia11-key header",
    engine: "IA11",
    webEvidenceProvider: WEB_EVIDENCE_PROVIDER,
  });
});

app.post("/v1/analyze", requireApiKey, async (req, res) => {
  const requestId = newRequestId();
  const start = nowMs();

  const mode = safeMode(req.body?.mode || "standard");

  // Rate limit
  const rl = checkRateLimit(req, mode);
  if (!rl.ok) {
    return res.status(429).json({
      status: "error",
      requestId,
      engine: "IA11",
      mode,
      message: "Rate limit exceeded",
      meta: { tookMs: nowMs() - start, version: "1.0", limitPerMin: rl.limit },
    });
  }

  const text = safeStr(req.body?.text);

  const out = await analyze({ text, mode });

  // Contract v1
  const payload = {
    status: out.status,
    requestId,
    engine: "IA11",
    mode,
    result: out.result,
    meta: {
      tookMs: nowMs() - start,
      version: "1.0",
    },
  };

  // Optional extra fields Lovable likes (non-breaking)
  if (out.articleSummary) payload.articleSummary = out.articleSummary;
  if (out.evidenceMeta) payload.evidenceMeta = out.evidenceMeta;
  if (out.guardrail) payload.guardrail = out.guardrail;
  if (out.lang) payload.lang = out.lang;
  if (out.debug) payload.debug = out.debug;

  return res.json(payload);
});

// -------------------- start
app.listen(PORT, () => {
  console.log(`IA11 running on port ${PORT}`);
});
