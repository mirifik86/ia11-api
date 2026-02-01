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
 * - BING_API_KEY="..."
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
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || CORS_ORIGINS === "*") return cb(null, true);
      const allowed = new Set(CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));
      return allowed.has(origin) ? cb(null, true) : cb(null, false);
    },
  })
);

// If you run behind Render / proxy, this makes req.ip reliable
if ((process.env.TRUST_PROXY || "1").toString() === "1") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "1mb" }));

// ---- Engine identity
const ENGINE_NAME = "IA11";
const ENGINE_VERSION = (process.env.ENGINE_VERSION || "2.0.0-wow-pro").toString().trim();
const PORT = parseInt(process.env.PORT || "10000", 10);

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
const BING_API_KEY = (process.env.BING_API_KEY || "").toString().trim();
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
  return Math.max(a, Math.min(b, n));
}
function truncate(s, max = 240) {
  const x = safeStr(s).trim();
  if (x.length <= max) return x;
  if (max <= 3) return x.slice(0, max);
  return x.slice(0, max - 1).trim() + "…";
}
function dateISO(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isWithin(dateStr, fromStr, toStr) {
  if (!dateStr || !fromStr || !toStr) return false;
  return dateStr >= fromStr && dateStr <= toStr;
}

// very light language detection (UI may pass it)
function detectLang(bodyLang, headerLang) {
  const l = safeStr(bodyLang || headerLang || "fr").toLowerCase().trim();
  if (l.startsWith("en")) return "en";
  if (l.startsWith("fr")) return "fr";
  return "fr";
}

// tiny i18n helper
function t(lang, fr, en) {
  return lang === "en" ? en : fr;
}

function normalizeDomain(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase().trim();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

function stripUrls(text) {
  const s = safeStr(text);
  return s.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
}

function getClientIp(req) {
  const xf = safeStr(req.headers["x-forwarded-for"]);
  if (xf) return xf.split(",")[0].trim();
  return safeStr(req.ip || req.connection?.remoteAddress || "unknown");
}

// -------------------- auth + rate limit
function authAndRateLimit(req) {
  const key = safeStr(req.headers["x-ia11-key"]).trim();
  if (!key || !allowedKeys.has(key)) {
    return { ok: false, status: 401, mode: "standard", error: "Unauthorized (bad x-ia11-key)." };
  }

  const tier = safeStr(req.headers["x-tier"] || req.body?.analysisType || req.body?.analysis_type || "").toLowerCase().trim();
  const mode = tier === "pro" ? "pro" : "standard";

  const limit = mode === "pro" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const now = nowMs();

  // Better limiter: key + IP (avoids one shared key punishing everyone)
  const ip = getClientIp(req);
  const bucketKey = `${key}::${ip}`;
  const bucket = buckets.get(bucketKey) || { windowStartMs: now, countStd: 0, countPro: 0 };

  // reset window every minute
  if (now - bucket.windowStartMs >= 60_000) {
    bucket.windowStartMs = now;
    bucket.countStd = 0;
    bucket.countPro = 0;
  }

  if (mode === "pro") bucket.countPro += 1;
  else bucket.countStd += 1;

  const used = mode === "pro" ? bucket.countPro : bucket.countStd;
  buckets.set(bucketKey, bucket);

  if (used > limit) {
    return { ok: false, status: 429, mode, error: "Rate limit exceeded. Please retry later." };
  }

  return { ok: true, status: 200, mode };
}

// -------------------- claim intelligence (hard facts + time)
function parseTimeContext(text) {
  const s = safeStr(text).toLowerCase();
  const years = [...s.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => parseInt(m[1], 10)).filter(Boolean);
  const hasExplicitYear = years.length > 0;
  const year = hasExplicitYear ? years[0] : null;

  // vague time words
  const mentionsNow = /\b(now|today|currently|en ce moment|aujourd'hui|actuellement)\b/.test(s);
  const mentionsFuture = /\b(202\d|next year|l'an prochain|bient[oô]t|future)\b/.test(s);

  return {
    hasExplicitYear,
    year,
    mentionsNow,
    mentionsFuture,
    inferred:
      hasExplicitYear ? "explicit_year" : mentionsNow ? "present" : mentionsFuture ? "future_or_recent" : "unknown",
  };
}

function detectHardFactType(text) {
  const s = safeStr(text).toLowerCase();

  // office holder patterns
  if (/\b(pr[eé]sident|prime minister|premier ministre|roi|king|queen|pape|pope)\b/.test(s)) {
    if (/\b(usa|u\.s\.|united states|am[eé]ricain|am[eé]rique)\b/.test(s)) return "office_holder";
    if (/\b(canada|canadien)\b/.test(s)) return "office_holder";
    if (/\b(france|fran[cç]ais)\b/.test(s)) return "office_holder";
    return "office_holder";
  }

  // big events
  if (/\b(war|guerre|earthquake|s[eé]isme|explosion|attack|attentat|election|élection)\b/.test(s)) {
    return "major_event";
  }

  return "general_claim";
}

function extractTargets(text) {
  const s = safeStr(text).toLowerCase();

  // crude role detection
  let role = "";
  if (/\bpr[eé]sident\b/.test(s) || /\bpresident\b/.test(s)) role = "president";
  else if (/\bprime minister\b/.test(s) || /\bpremier ministre\b/.test(s)) role = "prime minister";

  // crude jurisdiction detection
  let jurisdiction = "";
  if (/\b(united states|u\.s\.|usa|am[eé]rique|am[eé]ricain)\b/.test(s)) jurisdiction = "united states";
  else if (/\bcanada|canadien\b/.test(s)) jurisdiction = "canada";
  else if (/\bfrance|fran[cç]ais\b/.test(s)) jurisdiction = "france";

  return { role, jurisdiction };
}

function criticalFactsCheck(targets) {
  if (!targets || !targets.role || !targets.jurisdiction) return { hit: false };

  const role = targets.role.toLowerCase();
  const jur = targets.jurisdiction.toLowerCase();

  const today = dateISO();
  const hits = CRITICAL_FACTS.filter((f) => {
    if (!f || f.type !== "office_holder") return false;
    if ((f.role || "").toLowerCase() !== role) return false;
    if ((f.jurisdiction || "").toLowerCase() !== jur) return false;
    return isWithin(today, f.validFrom, f.validTo);
  });

  if (!hits.length) return { hit: false };

  const f = hits[0];
  return {
    hit: true,
    fact: {
      id: f.id,
      role: f.role,
      jurisdiction: f.jurisdiction,
      value: f.value,
      source: f.source,
      validFrom: f.validFrom,
      validTo: f.validTo,
    },
  };
}

// -------------------- base scoring (signals)
function scoreSignals(text) {
  const s = safeStr(text).trim();
  const clean = stripUrls(s);

  // Base score starts at 55 then adjusted
  let score = 55;
  let confidence = 0.55;

  const reasons = [];
  const breakdown = {
    sources: { points: 0, reason: "" },
    factual: { points: 0, reason: "" },
    tone: { points: 0, reason: "" },
    context: { points: 0, reason: "" },
    clarity: { points: 0, reason: "" },
    transparency: { points: 0, reason: "" },
  };

  // length / clarity
  const len = clean.length;
  if (len < 40) {
    score -= 15;
    confidence -= 0.12;
    breakdown.clarity = { points: -15, reason: "Very short claim, low context." };
    reasons.push("Texte très court → contexte faible.");
  } else if (len > 220) {
    score += 5;
    confidence += 0.05;
    breakdown.clarity = { points: +5, reason: "More context provided." };
    reasons.push("Plus de contexte → meilleure analyse.");
  } else {
    breakdown.clarity = { points: 0, reason: "Average length." };
  }

  // sensational tone penalty
  const lower = clean.toLowerCase();
  const hype = /\b(shocking|incroyable|insane|secret|100%|certain|preuve absolue|garanti)\b/.test(lower);
  if (hype) {
    score -= 8;
    confidence -= 0.05;
    breakdown.tone = { points: -8, reason: "Sensational tone increases risk." };
    reasons.push("Ton sensationnaliste → risque plus élevé.");
  } else {
    breakdown.tone = { points: 0, reason: "Neutral tone." };
  }

  // transparency / hedging
  const hedged = /\b(maybe|peut[- ]?être|possible|probablement|je pense)\b/.test(lower);
  if (hedged) {
    score += 3;
    confidence += 0.02;
    breakdown.transparency = { points: +3, reason: "Hedged language reduces overclaim risk." };
    reasons.push("Formulation prudente → moins de risque d'affirmation gratuite.");
  } else {
    breakdown.transparency = { points: 0, reason: "No explicit hedging." };
  }

  // numbers + specifics (context)
  const hasNumbers = /\b\d+([.,]\d+)?\b/.test(clean);
  if (hasNumbers) {
    score += 2;
    confidence += 0.02;
    breakdown.context = { points: +2, reason: "Specifics present (numbers)." };
  } else {
    breakdown.context = { points: 0, reason: "Few specifics." };
  }

  // URL present in input (user added source)
  const hadUrl = /https?:\/\/\S+/.test(s);
  if (hadUrl) {
    score += 4;
    confidence += 0.03;
    breakdown.sources = { points: +4, reason: "User included a link (unverified)." };
    reasons.push("Lien fourni → indice de source (à vérifier).");
  } else {
    breakdown.sources = { points: 0, reason: "No user source." };
  }

  score = clamp(Math.round(score), 5, 98);
  confidence = clamp(Number(confidence.toFixed(2)), 0.2, 0.95);

  return { score, confidence, reasons, breakdown };
}

// -------------------- Bing evidence fetch
async function fetchBingEvidence(query, count = 6, timeoutMs = 6500) {
  const q = safeStr(query).trim();
  if (!q) return { ok: false, reason: "empty_query", items: [] };

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
function buildEvidence(text, lang, items, targets, criticalHit) {
  const s = safeStr(text).toLowerCase();
  const timeCtx = parseTimeContext(text);

  // Deduplicate by URL
  const seen = new Set();
  const sources = [];
  for (const it of items || []) {
    if (!it?.url || seen.has(it.url)) continue;
    seen.add(it.url);

    // Light quality filter: avoid obvious junk domains
    const d = safeStr(it.domain);
    if (!d) continue;

    sources.push({
      title: truncate(it.title, 90),
      url: it.url,
      snippet: truncate(it.snippet, 170),
      domain: d,
      confidence: 0.6,
      stance: "neutral",
    });
  }

  // Domain diversity
  const domains = new Set(sources.map((x) => x.domain));
  const diversity =
    domains.size >= 5 ? "high" : domains.size >= 3 ? "medium" : domains.size >= 2 ? "low" : "very_low";

  // Simple contradiction heuristic:
  // - if critical facts hit (office holder), enforce that as "hard truth anchor"
  let contradictionsCheck = "none_found";
  let badge = "CONSENSUS";
  let outcome = "uncertain";

  // If we have a critical fact, we can do a strong anchor
  if (criticalHit?.hit && criticalHit?.fact?.value) {
    const expected = safeStr(criticalHit.fact.value).toLowerCase();
    const saysOpposite = /\b(not|no|isn't|n'est pas|faux|incorrect)\b/.test(s);

    // if text contains expected name -> corroborated
    if (s.includes(expected)) {
      outcome = "corroborated";
      badge = "CONSENSUS";
      contradictionsCheck = "checked";
    } else if (saysOpposite) {
      outcome = "contradicted";
      badge = "CONTRADICTION";
      contradictionsCheck = "checked";
    } else {
      outcome = "uncertain";
      badge = "CONSENSUS";
      contradictionsCheck = "checked";
    }
  } else {
    // Without hard anchor, be conservative
    outcome = sources.length >= 3 ? "partially_corroborated" : "uncertain";
    contradictionsCheck = "soft_check";
    badge = outcome === "uncertain" ? "CONSENSUS" : "CONSENSUS";
  }

  // Choose best links (top 5) - direct URLs
  const bestLinks = sources.slice(0, 5).map((s) => ({
    title: s.title,
    url: s.url,
    domain: s.domain,
  }));

  const summary =
    outcome === "corroborated"
      ? t(lang, "Plusieurs sources concordent avec l'affirmation.", "Multiple sources align with the claim.")
      : outcome === "contradicted"
      ? t(lang, "Des sources solides contredisent l'affirmation.", "Strong sources contradict the claim.")
      : outcome === "partially_corroborated"
      ? t(lang, "Certaines sources vont dans le même sens, mais la preuve reste limitée.", "Some sources align, but evidence is limited.")
      : t(lang, "Preuve web insuffisante pour confirmer clairement.", "Insufficient web evidence to clearly confirm.");

  return {
    corroboration: {
      outcome,
      sourcesConsulted: sources.length,
      sourceTypes: [...domains].slice(0, 6),
      summary,
    },
    sources,
    bestLinks,
    verification: {
      badge,
      contradictionsCheck,
      timeContext: timeCtx,
      sourceDiversity: diversity,
    },
  };
}

// -------------------- confidence & score adjustment
function dynamicConfidence(baseConfidence, evidence, hardFact, criticalHit) {
  let c = baseConfidence;

  if (evidence?.corroboration?.outcome === "corroborated") c += 0.18;
  else if (evidence?.corroboration?.outcome === "partially_corroborated") c += 0.08;
  else if (evidence?.corroboration?.outcome === "contradicted") c -= 0.22;
  else c -= hardFact ? 0.10 : 0.05;

  if (hardFact) c -= 0.03; // hard claims require stronger proof
  if (criticalHit?.hit) c += 0.08; // anchor improves reliability

  // penalize low diversity
  const div = evidence?.verification?.sourceDiversity || "none";
  if (div === "very_low" || div === "low") c -= 0.05;

  return clamp(Number(c.toFixed(2)), 0.2, 0.95);
}

function adjustScoreWithEvidence(baseScore, evidence, hardFact, criticalHit) {
  let s = baseScore;

  const out = evidence?.corroboration?.outcome || "uncertain";
  if (out === "corroborated") s += 18;
  else if (out === "partially_corroborated") s += 8;
  else if (out === "contradicted") s -= 25;
  else s -= hardFact ? 10 : 4;

  if (hardFact) s -= 3;
  if (criticalHit?.hit) s += 10;

  s = clamp(Math.round(s), 5, 98);

  // No “high score” if no web evidence on hard facts
  if (hardFact && (!evidence || (evidence?.sources || []).length < 2)) {
    s = Math.min(s, 62);
  }

  return s;
}

// -------------------- summary builders (Standard + PRO)
function buildSummary(lang, mode, score, riskLevel, corroboration) {
  const out = corroboration?.outcome || "uncertain";

  if (mode === "pro") {
    if (out === "corroborated") return t(lang, "Affirmation fortement corroborée par des sources fiables.", "Claim strongly corroborated by reliable sources.");
    if (out === "contradicted") return t(lang, "Affirmation contredite par des sources solides.", "Claim contradicted by strong sources.");
    if (out === "partially_corroborated") return t(lang, "Affirmation partiellement corroborée, preuve encore limitée.", "Claim partially corroborated; evidence remains limited.");
    return t(lang, "Impossible de confirmer clairement avec la vérification web actuelle.", "Unable to clearly confirm with current web verification.");
  }

  // Standard
  if (riskLevel === "low") return t(lang, "Texte cohérent, mais vérification externe recommandée.", "Coherent text, but external verification recommended.");
  if (riskLevel === "medium") return t(lang, "Texte plausible, mais manque de preuves claires.", "Plausible text, but lacks clear evidence.");
  return t(lang, "Texte à risque: prudence et vérification nécessaire.", "High-risk text: caution and verification needed.");
}

function buildWOWArticleSummary(lang, mode, text, base, evidence, finalScore, finalConfidence, hardFact, criticalHit) {
  const clean = stripUrls(text);
  const claim = truncate(clean, 260);

  const outcome = evidence?.corroboration?.outcome || "uncertain";
  const sourcesCount = evidence?.corroboration?.sourcesConsulted || 0;
  const badge = evidence?.verification?.badge || "CONSENSUS";

  const header =
    mode === "pro"
      ? t(lang, "Analyse PRO — Lecture crédibilité IA11", "PRO Analysis — IA11 credibility read")
      : t(lang, "Analyse Standard — Lecture crédibilité IA11", "Standard Analysis — IA11 credibility read");

  const hardLabel = hardFact ? t(lang, "Fait dur détecté", "Hard fact detected") : t(lang, "Affirmation générale", "General claim");

  const evidenceLine =
    mode === "pro"
      ? t(
          lang,
          `Vérification web: ${outcome} • Sources consultées: ${sourcesCount} • Badge: ${badge}`,
          `Web verification: ${outcome} • Sources consulted: ${sourcesCount} • Badge: ${badge}`
        )
      : t(lang, "Vérification web: non incluse en Standard.", "Web verification: not included in Standard.");

  const anchorLine =
    criticalHit?.hit
      ? t(
          lang,
          `Ancre critique: ${criticalHit.fact.role} (${criticalHit.fact.jurisdiction}) → ${criticalHit.fact.value}`,
          `Critical anchor: ${criticalHit.fact.role} (${criticalHit.fact.jurisdiction}) → ${criticalHit.fact.value}`
        )
      : "";

  const scoreLine = t(
    lang,
    `Score: ${finalScore}/98 • Confiance: ${Math.round(finalConfidence * 100)}% • ${hardLabel}`,
    `Score: ${finalScore}/98 • Confidence: ${Math.round(finalConfidence * 100)}% • ${hardLabel}`
  );

  const tip =
    outcome === "contradicted"
      ? t(lang, "Conseil: ne partage pas tel quel. Cherche une source primaire.", "Tip: don’t share as-is. Look for a primary source.")
      : outcome === "corroborated"
      ? t(lang, "Conseil: tu peux partager, mais garde les liens de preuve.", "Tip: you can share, but keep the proof links.")
      : t(lang, "Conseil: attends plus de preuves avant d'affirmer.", "Tip: wait for stronger proof before asserting.");

  return [header, "", `• Claim: ${claim}`, `• ${scoreLine}`, `• ${evidenceLine}`, anchorLine ? `• ${anchorLine}` : "", `• ${tip}`]
    .filter(Boolean)
    .join("\n");
}

// -------------------- routes
app.get("/", (req, res) => {
  res.json({ status: "ok", engine: ENGINE_NAME, version: ENGINE_VERSION });
});

app.get("/v1/health", (req, res) => {
  return res.json({ status: "ok", engine: ENGINE_NAME, version: ENGINE_VERSION });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    routes: ["GET /", "GET /v1/health", "GET /v1/analyze", "POST /v1/analyze"],
    notes: "Use POST /v1/analyze with header x-ia11-key and optional x-tier: pro",
  });
});

app.post("/v1/analyze", async (req, res) => {
  const t0 = nowMs();
  const requestId = newRequestId();

  const gate = authAndRateLimit(req);
  if (!gate.ok) {
    return res.status(gate.status).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: "standard",
      result: {
        score: 5,
        riskLevel: "high",
        summary: gate.error,
        reasons: [],
        confidence: 0.2,
        breakdown: {
          sources: { points: 0, reason: "" },
          factual: { points: 0, reason: "" },
          tone: { points: 0, reason: "" },
          context: { points: 0, reason: "" },
          clarity: { points: 0, reason: "" },
          transparency: { points: 0, reason: "" },
        },
        sources: [],
        bestLinks: [],
        corroboration: { outcome: "uncertain", sourcesConsulted: 0, sourceTypes: [], summary: gate.error },
      },
      articleSummary: gate.error,
      meta: { tookMs: nowMs() - t0, version: ENGINE_VERSION },
    });
  }

  const mode = gate.mode;
  const text = safeStr(req.body?.text || req.body?.content || "").trim();
  const lang = detectLang(req.body?.language, req.headers["x-ui-lang"]);

  if (!text) {
    const msg = t(lang, "Texte manquant.", "Missing text.");
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      result: {
        score: 5,
        riskLevel: "high",
        summary: msg,
        reasons: [],
        confidence: 0.2,
        breakdown: {
          sources: { points: 0, reason: "" },
          factual: { points: 0, reason: "" },
          tone: { points: 0, reason: "" },
          context: { points: 0, reason: "" },
          clarity: { points: 0, reason: "" },
          transparency: { points: 0, reason: "" },
        },
        sources: [],
        bestLinks: [],
        corroboration: { outcome: "uncertain", sourcesConsulted: 0, sourceTypes: [], summary: msg },
      },
      articleSummary: msg,
      meta: { tookMs: nowMs() - t0, version: ENGINE_VERSION },
    });
  }

  // Base signals
  const base = scoreSignals(text);

  // Claim intelligence
  const timeCtx = parseTimeContext(text);
  const hardType = detectHardFactType(text);
  const hardFact = hardType === "office_holder" || hardType === "major_event";
  const targets = extractTargets(text);

  // Critical fact safety test
  const criticalHit = criticalFactsCheck(targets);

  // PRO web evidence
  let evidence = null;
  let coverage = {
    webCoverage: "none",
    sourceDiversity: "none",
    contradictionsCheck: "not_run",
    badge: "CONSENSUS",
  };

  if (mode === "pro") {
    const qBase = stripUrls(text).slice(0, 180);
    const q =
      targets?.role && targets?.jurisdiction
        ? `${targets.role} of ${targets.jurisdiction} ${timeCtx.hasExplicitYear ? timeCtx.year : ""}`.trim()
        : qBase;

    if (WEB_EVIDENCE_PROVIDER === "bing" && BING_API_KEY) {
      const ev = await fetchBingEvidence(q, 8);
      if (ev.ok && ev.items.length) {
        evidence = buildEvidence(text, lang, ev.items, targets, criticalHit);
        coverage = {
          webCoverage: "limited",
          sourceDiversity: evidence?.verification?.sourceDiversity || "low",
          contradictionsCheck: evidence?.verification?.contradictionsCheck || "none_found",
          badge: evidence?.verification?.badge || "CONSENSUS",
        };
      } else {
        evidence = {
          corroboration: {
            outcome: "uncertain",
            sourcesConsulted: 0,
            sourceTypes: [],
            summary: t(
              lang,
              "Vérification web indisponible (clé manquante ou requête impossible).",
              "Web verification unavailable (missing key or request failed)."
            ),
          },
          sources: [],
          bestLinks: [],
          verification: { badge: "CONSENSUS", contradictionsCheck: "not_run", timeContext: timeCtx },
        };
        coverage = { webCoverage: "none", sourceDiversity: "none", contradictionsCheck: "not_run", badge: "CONSENSUS" };
      }
    } else {
      evidence = {
        corroboration: {
          outcome: "uncertain",
          sourcesConsulted: 0,
          sourceTypes: [],
          summary: t(lang, "Couverture web limitée (aucune clé de recherche configurée).", "Limited web coverage (no search key configured)."),
        },
        sources: [],
        bestLinks: [],
        verification: { badge: "CONSENSUS", contradictionsCheck: "not_run", timeContext: timeCtx },
      };
      coverage = { webCoverage: "none", sourceDiversity: "none", contradictionsCheck: "not_run", badge: "CONSENSUS" };
    }
  }

  // Dynamic confidence + score
  const finalConfidence = dynamicConfidence(base.confidence, evidence, hardFact, criticalHit);
  const finalScore = adjustScoreWithEvidence(base.score, evidence, hardFact, criticalHit);

  const riskLevel = finalScore >= 75 ? "low" : finalScore >= 50 ? "medium" : "high";
  const summary = buildSummary(lang, mode, finalScore, riskLevel, evidence?.corroboration);

  const wowArticleSummary = buildWOWArticleSummary(
    lang,
    mode,
    text,
    base,
    evidence,
    finalScore,
    finalConfidence,
    hardFact,
    criticalHit
  );

  const breakdown = base.breakdown;

  const out = {
    status: "ok",
    requestId,
    engine: ENGINE_NAME,
    mode,
    analysisType: mode,
    articleSummary: wowArticleSummary,
    result: {
      score: finalScore,
      riskLevel,
      summary,
      articleSummary: wowArticleSummary,
      confidence: finalConfidence,
      reasons: base.reasons,
      breakdown,
      corroboration: evidence?.corroboration || { outcome: "uncertain", sourcesConsulted: 0, sourceTypes: [], summary: t(lang, "Aucune preuve web.", "No web evidence.") },
      sources: evidence?.sources || [],
      bestLinks: evidence?.bestLinks || [],
      coverage,
      verification: evidence?.verification || { badge: "CONSENSUS", contradictionsCheck: "not_run", timeContext: timeCtx },
      hardFact: { type: hardType, enabled: Boolean(hardFact) },
      criticalFacts: criticalHit?.hit ? criticalHit.fact : null,
      timeContext: timeCtx,
    },
    meta: {
      tookMs: nowMs() - t0,
      version: ENGINE_VERSION,
      lang,
      provider: WEB_EVIDENCE_PROVIDER,
    },
  };

  return res.json(out);
});

// -------------------- start
app.listen(PORT, () => {
  console.log(`[IA11] ${ENGINE_NAME} v${ENGINE_VERSION} listening on ${PORT}`);
});
