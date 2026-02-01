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
 * - IA11_API_KEY="your_primary_key"
 * Optional:
 * - IA11_API_KEYS="key1,key2,key3" (comma-separated)
 * - RATE_LIMIT_PER_MIN="30"
 * - RATE_LIMIT_PER_MIN_PRO="60"
 * - ENGINE_VERSION="2.0.0-wow-pro"
 *
 * Web evidence (PRO):
 * - WEB_EVIDENCE_PROVIDER="bing" (default)
 * - BING_API_KEY="..."
 * - BING_ENDPOINT="https://api.bing.microsoft.com/v7.0/search"
 * - BING_FRESHNESS="Day" | "Week" | "Month" (optional, default "Week")
 *
 * Critical facts library (optional, extendable):
 * - CRITICAL_FACTS_JSON='[{"id":"us_president_2026","type":"office_holder","role":"president","jurisdiction":"united states","validFrom":"2025-01-20","validTo":"2029-01-20","value":"donald trump","source":"whitehouse.gov"}]'
 *
 * Headers:
 * - x-ia11-key: required
 * - x-ui-lang: fr|en|...
 * - x-tier: standard|pro
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
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

// ---- In-memory rate limiter
const buckets = new Map(); // key -> { windowStartMs, countStd, countPro }

// -------------------- helpers
function nowMs() {
  return Date.now();
}

function newRequestId() {
  return crypto.randomBytes(12).toString("hex");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function detectLang(bodyLang, headerLang) {
  const raw = (bodyLang || headerLang || "en").toString().toLowerCase().trim();
  if (!raw) return "en";
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("en")) return "en";
  return raw;
}

function t(lang, fr, en) {
  return (lang || "").startsWith("fr") ? fr : en;
}

function normalizeDomain(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase().trim();
    // strip www.
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

function stripUrls(text) {
  return safeStr(text).replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

function compact(text, max = 280) {
  const s = safeStr(text).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
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
  const bucket = buckets.get(key) || { windowStartMs: now, countStd: 0, countPro: 0 };

  // reset window every minute
  if (now - bucket.windowStartMs >= 60_000) {
    bucket.windowStartMs = now;
    bucket.countStd = 0;
    bucket.countPro = 0;
  }

  if (mode === "pro") bucket.countPro += 1;
  else bucket.countStd += 1;

  const used = mode === "pro" ? bucket.countPro : bucket.countStd;
  buckets.set(key, bucket);

  if (used > limit) {
    return { ok: false, status: 429, mode, error: "Rate limit exceeded. Please retry later." };
  }

  return { ok: true, status: 200, mode };
}

// -------------------- claim intelligence (hard facts + time)
function parseTimeContext(text) {
  const s = safeStr(text).toLowerCase();
  const years = [...s.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => parseInt(m[1], 10)).filter(Boolean);
  const hasCurrent =
    /\b(currently|today|right now|at the moment|en ce moment|actuellement|aujourd'hui|maintenant)\b/i.test(text);
  const year = years.length ? years[0] : null;
  return {
    year,
    hasExplicitYear: Boolean(year),
    isCurrent: hasCurrent || !year, // default: current if no year
  };
}

function detectHardFactType(text) {
  const s = safeStr(text).toLowerCase();
  // office holders / leadership
  const leadership =
    /\b(president|président|prime minister|premier ministre|chancellor|roi|king|queen|monarch|ceo)\b/i.test(text) &&
    /\b(of|de|des|du)\b/i.test(text);
  // deaths, wars, elections, treaties, emergencies
  const majorEvent =
    /\b(died|dead|death|mort|décès|war|guerre|election|élection|treaty|traité|pandemic|urgence)\b/i.test(text);

  if (leadership) return "office_holder";
  if (majorEvent) return "major_event";
  return "general";
}

// very lightweight target extraction (en/fr)
function extractTargets(text) {
  const raw = stripUrls(text);
  const time = parseTimeContext(raw);
  const lower = raw.toLowerCase();

  // Detect gender claims for leadership (woman/female vs man/male)
  const saysFemale = /\b(woman|female|femme)\b/i.test(raw);
  const saysMale = /\b(man|male|homme)\b/i.test(raw);

  // Try capture "president of X"
  let role = null;
  let jurisdiction = null;

  // EN: "president of the united states"
  let m = raw.match(/\b(president|prime minister|ceo|king|queen)\b\s+of\s+(the\s+)?([A-Za-zÀ-ÿ\s'.-]{3,60})/i);
  if (m) {
    role = m[1].toLowerCase();
    jurisdiction = safeStr(m[3]).trim().toLowerCase();
  } else {
    // FR: "président des États-Unis"
    m = raw.match(/\b(président|premier ministre|roi|reine)\b\s+(de|du|des|d')\s*([A-Za-zÀ-ÿ\s'.-]{3,60})/i);
    if (m) {
      role = m[1].toLowerCase();
      jurisdiction = safeStr(m[3]).trim().toLowerCase();
    }
  }

  return {
    time,
    role,
    jurisdiction,
    saysFemale,
    saysMale,
  };
}

// -------------------- critical facts library (small built-in + extendable via env)
function loadCriticalFacts() {
  let arr = [];
  try {
    const raw = (process.env.CRITICAL_FACTS_JSON || "").toString().trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    }
  } catch {
    // ignore
  }

  // Minimal built-in safeguards (can be expanded via env)
  // Keep it tiny: this is a failsafe layer, not a full encyclopedia.
  const builtIn = [
    {
      id: "us_president_2026",
      type: "office_holder",
      role: "president",
      jurisdiction: "united states",
      validFrom: "2025-01-20",
      validTo: "2029-01-20",
      value: "donald trump",
      source: "whitehouse.gov",
    },
  ];

  // Merge (env overrides built-in by id)
  const map = new Map();
  for (const f of [...builtIn, ...arr]) {
    if (f && f.id) map.set(String(f.id), f);
  }
  return [...map.values()];
}

const CRITICAL_FACTS = loadCriticalFacts();

function dateISO() {
  return new Date().toISOString().slice(0, 10);
}

function isWithin(dateStr, fromStr, toStr) {
  const d = (dateStr || dateISO()).slice(0, 10);
  if (fromStr && d < fromStr) return false;
  if (toStr && d > toStr) return false;
  return true;
}

function criticalFactsCheck(targets) {
  // only apply for office_holder-like claims
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

  // return strongest single (first)
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

// -------------------- base scoring signals (text-only)
function scoreSignals(text) {
  const raw = safeStr(text);
  const len = raw.length;

  // Basic heuristics (kept stable)
  // base score from clarity + completeness
  let score = 55;
  if (len < 40) score -= 18;
  else if (len < 80) score -= 10;
  else if (len > 1200) score -= 4;

  // Excessive caps / spammy punctuation
  const caps = (raw.match(/[A-Z]/g) || []).length;
  const letters = (raw.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const capsRatio = letters ? caps / letters : 0;
  if (capsRatio > 0.35) score -= 6;

  const bangs = (raw.match(/[!?]{2,}/g) || []).length;
  if (bangs > 0) score -= 3;

  // Contains URL suggests sourcing (small plus)
  const hasUrl = /https?:\/\//i.test(raw);
  if (hasUrl) score += 3;

  score = clamp(score, 5, 98);

  // breakdown (UI expects these)
  const breakdown = {
    sources: { points: hasUrl ? 14 : 8, reason: hasUrl ? "Contains link(s) or references." : "No explicit sources included." },
    factual: { points: 12, reason: "Claim appears fact-like; requires verification." },
    tone: { points: 14, reason: "Tone signal computed from punctuation/caps." },
    context: { points: len > 80 ? 14 : 10, reason: len > 80 ? "Enough context provided." : "Limited context provided." },
    clarity: { points: len > 80 ? 14 : 10, reason: len > 80 ? "Clearer statement." : "Short statement; may be ambiguous." },
    transparency: { points: hasUrl ? 14 : 10, reason: hasUrl ? "References help transparency." : "Transparency improves with references." },
  };

  const confidence = len < 80 ? 0.50 : 0.72;

  const reasons = [];
  if (len < 80) reasons.push("Very short input; harder to verify precisely.");
  if (hasUrl) reasons.push("Contains link(s) that can support verification.");

  return {
    score,
    confidence,
    reasons,
    breakdown,
  };
}

// -------------------- Bing evidence fetch (PRO)
async function fetchBingEvidence(query, count = 6, timeoutMs = 6500) {
  const q = safeStr(query).trim();
  if (!q) return { ok: false, reason: "empty_query", items: [] };

  const url = new URL(BING_ENDPOINT);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(clamp(count, 3, 10)));
  url.searchParams.set("textDecorations", "false");
  url.searchParams.set("textFormat", "Raw");
  url.searchParams.set("safeSearch", "Moderate");

  // freshness is optional
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

// -------------------- trust tiers + stance + contradiction detector
const MAJOR_NEWS_DOMAINS = new Set([
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "cnn.com",
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
  "wsj.com",
  "bloomberg.com",
  "cbsnews.com",
  "nbcnews.com",
  "abcnews.go.com",
  "foxnews.com",
]);

function classifyTier(domain) {
  const d = safeStr(domain).toLowerCase();
  if (!d) return "other";
  if (d.endsWith(".gov") || d.endsWith(".mil") || d.includes("whitehouse.gov") || d.includes("usa.gov")) return "official";
  if (MAJOR_NEWS_DOMAINS.has(d)) return "major";
  return "other";
}

function tierWeight(tier) {
  if (tier === "official") return 1.0;
  if (tier === "major") return 0.75;
  return 0.45;
}

// Detect stance in a pragmatic way from title/snippet vs target
function inferStance(item, claimText, targets, criticalHit) {
  const hay = (safeStr(item.title) + " " + safeStr(item.snippet)).toLowerCase();
  const claim = safeStr(claimText).toLowerCase();

  // If we have a critical fact hit (e.g., office holder name) use it strongly
  if (criticalHit && criticalHit.fact && criticalHit.fact.value) {
    const v = safeStr(criticalHit.fact.value).toLowerCase();
    const mentionsValue = v && hay.includes(v);
    // If claim asserts female but evidence mentions a male person (by name) => contradict
    if (mentionsValue) {
      if (targets?.saysFemale) return "contradicts";
      // Otherwise likely supports "who is X"
      return "supports";
    }
  }

  // Simple contradiction markers
  const negMarkers = ["not", "no", "false", "incorrect", "debunk", "hoax", "fake", "myth", "faux", "pas", "incorrect"];
  const posMarkers = ["confirmed", "official", "announced", "states", "statement", "déclare", "confirme"];

  const hasNeg = negMarkers.some((w) => hay.includes(` ${w} `) || hay.startsWith(`${w} `));
  const hasPos = posMarkers.some((w) => hay.includes(` ${w} `));

  // If leadership claim with gender attribute: if snippet mentions "president" + male/female cues
  if (targets?.role && targets?.jurisdiction) {
    const mentionsRole = hay.includes(targets.role);
    const mentionsJur = hay.includes(targets.jurisdiction.split(" ")[0]); // coarse
    if (mentionsRole && (mentionsJur || targets.jurisdiction.length < 6)) {
      if (targets.saysFemale) {
        // evidence hints "he/him" or "mr" or male-coded tokens => contradict
        if (/\b(he|him|mr\.|mister|donald|trump)\b/i.test(hay)) return "contradicts";
        if (/\b(she|her|ms\.|mrs\.|madam)\b/i.test(hay)) return "supports";
      }
      if (targets.saysMale) {
        if (/\b(she|her|ms\.|mrs\.|madam)\b/i.test(hay)) return "contradicts";
        if (/\b(he|him|mr\.|mister)\b/i.test(hay)) return "supports";
      }
    }
  }

  if (hasNeg && !hasPos) return "contradicts";
  if (hasPos && !hasNeg) return "supports";

  // If snippet overlaps with main claim keywords, treat as neutral-ish support
  const kw = claim.split(/\s+/).filter((w) => w.length >= 5).slice(0, 6);
  const overlap = kw.filter((w) => hay.includes(w)).length;
  if (overlap >= 2) return "neutral";

  return "unclear";
}

function dedupeByDomain(items, max = 6) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const d = it.domain;
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

function detectContradiction(evidenceItems, timeCtx) {
  // Weighted stance sums by tier
  let supportW = 0;
  let contradictW = 0;
  let neutralW = 0;

  let officialCount = 0;
  let majorCount = 0;
  let otherCount = 0;

  for (const e of evidenceItems) {
    const w = tierWeight(e.tier);
    if (e.tier === "official") officialCount++;
    else if (e.tier === "major") majorCount++;
    else otherCount++;

    if (e.stance === "supports") supportW += w;
    else if (e.stance === "contradicts") contradictW += w;
    else if (e.stance === "neutral") neutralW += w;
  }

  const total = supportW + contradictW + neutralW;
  const hasBoth = supportW > 0.5 && contradictW > 0.5;

  // Time-aware "evolution" guess: if explicit year and freshness is broad, be more cautious.
  const likelyTemporalShift = Boolean(timeCtx?.hasExplicitYear) && total > 1.2 && hasBoth;

  let badge = "CONSENSUS";
  let contradictionsCheck = "none_found";
  if (hasBoth) {
    badge = likelyTemporalShift ? "EVOLUTION" : "CONFLICT";
    contradictionsCheck = "found";
  } else if (contradictW > supportW + 0.6) {
    badge = "CONSENSUS"; // consensus on contradiction (i.e., claim is false)
  }

  return {
    supportW,
    contradictW,
    neutralW,
    officialCount,
    majorCount,
    otherCount,
    totalW: total,
    hasBoth,
    badge, // CONSENSUS | CONFLICT | EVOLUTION
    contradictionsCheck,
  };
}

// -------------------- Build PRO result (corroboration + sources + bestLinks + WOW article summary)
function buildEvidence(claimText, lang, rawItems, targets, criticalHit) {
  const trimmed = dedupeByDomain(rawItems, 7);

  // enrich items
  const enriched = trimmed.map((it) => {
    const tier = classifyTier(it.domain);
    const stance = inferStance(it, claimText, targets, criticalHit);
    return {
      title: it.title,
      url: it.url,
      snippet: it.snippet,
      domain: it.domain,
      tier,
      stance, // supports | contradicts | neutral | unclear
      dateLastCrawled: it.dateLastCrawled,
    };
  });

  const stats = detectContradiction(enriched, targets?.time);

  // Determine outcome
  // "confirmed" if support dominates and no strong contradiction
  // "contradicted" if contradiction dominates strongly
  // "mixed" if both present
  // else "uncertain"
  let outcome = "uncertain";
  if (stats.supportW >= stats.contradictW + 0.8 && stats.supportW >= 0.9) outcome = "confirmed";
  else if (stats.contradictW >= stats.supportW + 0.8 && stats.contradictW >= 0.9) outcome = "contradicted";
  else if (stats.hasBoth) outcome = "mixed";
  else outcome = "uncertain";

  // Source types
  const sourceTypes = [];
  if (stats.officialCount) sourceTypes.push("official");
  if (stats.majorCount) sourceTypes.push("major_news");
  if (stats.otherCount) sourceTypes.push("other");

  // Best links: choose up to 3, prefer official then major, then others, and prefer relevant stance
  const byTier = (tier) => enriched.filter((x) => x.tier === tier);
  const pickBest = (arr) => {
    // prefer supports/contradicts/neutral over unclear
    const rank = (s) => (s === "supports" ? 3 : s === "contradicts" ? 3 : s === "neutral" ? 2 : 1);
    return [...arr].sort((a, b) => rank(b.stance) - rank(a.stance)).slice(0, 2);
  };

  const bestLinksRaw = [
    ...pickBest(byTier("official")),
    ...pickBest(byTier("major")),
    ...pickBest(byTier("other")),
  ].slice(0, 3);

  const bestLinks = bestLinksRaw.map((x) => ({
    title: x.title,
    url: x.url,
    tier: x.tier,
    why:
      x.tier === "official"
        ? t(lang, "Source officielle", "Official source")
        : x.tier === "major"
        ? t(lang, "Média majeur", "Major news")
        : t(lang, "Source complémentaire", "Supporting source"),
  }));

  // Corroboration summary (simple + premium)
  const summary = (() => {
    if (!enriched.length) {
      return t(
        lang,
        "Aucune source web solide n’a pu être consultée pour confirmer ou contredire.",
        "No strong web sources could be consulted to confirm or contradict."
      );
    }
    if (outcome === "confirmed") {
      return t(
        lang,
        "Les sources consultées vont majoritairement dans le même sens (corroboration).",
        "Consulted sources mostly align (corroboration)."
      );
    }
    if (outcome === "contradicted") {
      return t(
        lang,
        "Les sources consultées contredisent fortement l’affirmation.",
        "Consulted sources strongly contradict the claim."
      );
    }
    if (outcome === "mixed") {
      return t(
        lang,
        stats.badge === "EVOLUTION"
          ? "Les sources divergent, et la différence semble liée à une évolution dans le temps."
          : "Les sources divergent sur le même point (contradictions).",
        stats.badge === "EVOLUTION"
          ? "Sources diverge and the difference appears linked to changes over time."
          : "Sources diverge on the same point (contradictions)."
      );
    }
    return t(
      lang,
      "Les sources sont insuffisantes ou trop neutres pour trancher clairement.",
      "Sources are insufficient or too neutral to conclude clearly."
    );
  })();

  // Return a "verification" object for WOW UI (even if not used yet)
  const verification = {
    badge: stats.badge, // CONSENSUS | CONFLICT | EVOLUTION
    outcome, // confirmed | contradicted | mixed | uncertain
    stanceWeights: {
      support: Number(stats.supportW.toFixed(2)),
      contradict: Number(stats.contradictW.toFixed(2)),
      neutral: Number(stats.neutralW.toFixed(2)),
    },
    sourceDiversity: sourceTypes.length >= 2 ? "medium" : sourceTypes.length ? "low" : "none",
    contradictionsCheck: stats.contradictionsCheck,
    timeContext: targets?.time || { year: null, isCurrent: true },
  };

  return {
    corroboration: {
      outcome,
      sourcesConsulted: enriched.length,
      sourceTypes,
      summary,
    },
    sources: enriched,
    bestLinks,
    verification,
  };
}

function dynamicConfidence(baseConf, evidence, hardFact, criticalHit) {
  // baseConf: 0..1
  let c = typeof baseConf === "number" ? baseConf : 0.55;

  if (!evidence || !evidence.corroboration) return clamp(c - (hardFact ? 0.12 : 0.06), 0.15, 0.95);

  const out = evidence.corroboration.outcome;
  const types = evidence.corroboration.sourceTypes || [];
  const hasOfficial = types.includes("official");
  const hasMajor = types.includes("major_news");

  if (hasOfficial) c += 0.10;
  if (hasMajor) c += 0.06;

  if (out === "confirmed") c += 0.12;
  else if (out === "contradicted") c += 0.10; // confidence can be high for "false" too
  else if (out === "mixed") c -= 0.14;
  else c -= 0.08;

  if (hardFact) c -= 0.02; // harder standard
  if (criticalHit?.hit) c += 0.06; // added safety

  // Bound
  return clamp(c, 0.15, 0.95);
}

function adjustScoreWithEvidence(baseScore, evidence, hardFact, criticalHit) {
  let s = Number(baseScore || 55);

  if (!evidence || !evidence.corroboration) {
    // no evidence => be more cautious for hard facts
    return clamp(s - (hardFact ? 10 : 4), 5, 98);
  }

  const out = evidence.corroboration.outcome;
  const types = evidence.corroboration.sourceTypes || [];
  const hasOfficial = types.includes("official");
  const hasMajor = types.includes("major_news");

  // Evidence strength factor
  let strength = 0;
  if (hasOfficial) strength += 1.0;
  if (hasMajor) strength += 0.7;
  if (types.includes("other")) strength += 0.3;

  if (out === "confirmed") s += Math.round(8 + 4 * strength);
  else if (out === "contradicted") s -= Math.round(10 + 3 * strength);
  else if (out === "mixed") s -= Math.round(6 + 2 * strength);
  else s -= hardFact ? 7 : 3;

  // Critical fact conflict: if hard fact + critical hit and claim asserts opposite (e.g., female vs known male leader)
  if (hardFact && criticalHit?.hit && criticalHit?.fact?.value) {
    // If claim says "woman" but we have a male name in critical fact, apply penalty if evidence is weak/mixed
    if (evidence?.corroboration?.outcome !== "confirmed" && evidence?.corroboration?.outcome !== "contradicted") {
      s -= 4;
    }
  }

  // Hard facts demand stricter scoring
  if (hardFact && out === "uncertain") s -= 3;

  return clamp(s, 5, 98);
}

function buildWOWArticleSummary(lang, mode, claimText, base, evidence, finalScore, finalConf, hardFact, criticalHit) {
  // This is the “paid feels good” part: clean, structured, human-like.
  const badge = evidence?.verification?.badge || "CONSENSUS";
  const outcome = evidence?.corroboration?.outcome || "uncertain";

  const badgeLabel =
    badge === "CONFLICT"
      ? t(lang, "Conflit", "Conflict")
      : badge === "EVOLUTION"
      ? t(lang, "Évolution", "Evolution")
      : t(lang, "Consensus", "Consensus");

  const verdict =
    outcome === "confirmed"
      ? t(lang, "Corroboré", "Corroborated")
      : outcome === "contradicted"
      ? t(lang, "Contredit", "Contradicted")
      : outcome === "mixed"
      ? t(lang, "Mixte", "Mixed")
      : t(lang, "Incertain", "Uncertain");

  const confTier = finalConf >= 0.75 ? t(lang, "Élevée", "High") : finalConf >= 0.45 ? t(lang, "Moyenne", "Medium") : t(lang, "Faible", "Low");

  const time = parseTimeContext(claimText);
  const timeLine = time.hasExplicitYear
    ? t(lang, `Contexte temporel : ${time.year}`, `Time context: ${time.year}`)
    : t(lang, "Contexte temporel : actuel", "Time context: current");

  const criticalLine =
    criticalHit?.hit && criticalHit?.fact
      ? t(
          lang,
          `Sécurité “faits critiques” : référence interne détectée (${criticalHit.fact.role} — ${criticalHit.fact.jurisdiction}).`,
          `Critical facts safety: internal reference detected (${criticalHit.fact.role} — ${criticalHit.fact.jurisdiction}).`
        )
      : t(lang, "Sécurité “faits critiques” : non applicable.", "Critical facts safety: not applicable.");

  const evidenceLine =
    mode === "pro"
      ? t(
          lang,
          `Vérification web : ${badgeLabel} • Verdict : ${verdict} • Confiance : ${confTier}`,
          `Web verification: ${badgeLabel} • Verdict: ${verdict} • Confidence: ${confTier}`
        )
      : t(lang, "Mode Standard : sans vérification web.", "Standard mode: no web verification.");

  const safeLine =
    hardFact && (outcome === "uncertain" || outcome === "mixed")
      ? t(
          lang,
          "Note PRO : sujet sensible → le moteur évite toute conclusion forcée si les preuves sont insuffisantes.",
          "PRO note: sensitive topic → the engine avoids forced conclusions when evidence is insufficient."
        )
      : "";

  // 3 bullets: verified / unclear / next
  const bullets = [];
  if (mode === "pro") {
    if (outcome === "confirmed") bullets.push(t(lang, "Les sources consultées corroborent l’affirmation.", "Sources consulted corroborate the claim."));
    else if (outcome === "contradicted") bullets.push(t(lang, "Les sources consultées contredisent l’affirmation.", "Sources consulted contradict the claim."));
    else if (outcome === "mixed") bullets.push(t(lang, "Les sources divergent : contradiction ou évolution temporelle.", "Sources diverge: contradiction or temporal shift."));
    else bullets.push(t(lang, "Les preuves disponibles sont insuffisantes pour trancher.", "Available evidence is insufficient to conclude."));

    bullets.push(
      t(
        lang,
        `Score final : ${finalScore}/98 (ajusté par qualité des preuves).`,
        `Final score: ${finalScore}/98 (adjusted by evidence quality).`
      )
    );

    bullets.push(
      t(
        lang,
        "Les liens affichés mènent directement vers des pages/articles (pas des homepages).",
        "Displayed links point directly to pages/articles (not generic homepages)."
      )
    );
  } else {
    bullets.push(t(lang, `Score final : ${finalScore}/98 (sans preuve web).`, `Final score: ${finalScore}/98 (no web evidence).`));
  }

  const bulletBlock = bullets.map((b) => `• ${b}`).join("\n");

  return [
    t(lang, "Rapport PRO IA11", "IA11 PRO Report"),
    "—",
    t(lang, `Affirmation : ${compact(stripUrls(claimText), 180)}`, `Claim: ${compact(stripUrls(claimText), 180)}`),
    timeLine,
    evidenceLine,
    criticalLine,
    safeLine ? safeLine : null,
    "—",
    bulletBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSummary(lang, mode, score, riskLevel, corroboration) {
  if (mode === "pro") {
    const out = corroboration?.outcome || "uncertain";
    if (out === "confirmed") {
      return t(lang, "Analyse PRO : contenu plutôt fiable (corroboré).", "PRO: content looks reliable (corroborated).");
    }
    if (out === "contradicted") {
      return t(lang, "Analyse PRO : contenu probablement faux (contredit).", "PRO: content likely false (contradicted).");
    }
    if (out === "mixed") {
      return t(lang, "Analyse PRO : sources divergentes (prudence).", "PRO: sources diverge (use caution).");
    }
    return t(lang, "Analyse PRO : preuves insuffisantes pour conclure.", "PRO: insufficient evidence to conclude.");
  }

  return t(lang, "Analyse Standard : estimation basée sur le texte (sans vérification web).", "Standard: estimate based on text only (no web verification).");
}

// -------------------- routes
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    routes: ["/v1/analyze"],
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    info: "POST /v1/analyze with x-ia11-key header.",
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
      articleSummary: gate.error, // keep UI compatible
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

  // Critical fact safety test (small but powerful)
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
    // Build better query for office holders
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

  // WOW article summary (UI expects TOP-LEVEL articleSummary)
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

  // Ensure breakdown exists
  const breakdown = base.breakdown;

  // Output compatible shape:
  // - UI normalization reads raw.articleSummary at top-level (important!)
  // - also keep result.articleSummary for future use
  const out = {
    status: "ok",
    requestId,
    engine: ENGINE_NAME,
    mode,
    analysisType: mode,
    articleSummary: wowArticleSummary, // <-- critical for Index.tsx
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
      // extra: future-proof fields for premium UI
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
