/**
 * IA11 - Credibility Intelligence Engine (Express)
 * Ultra PRO - single engine for LeenScore
 *
 * What this version fixes:
 * - Stable & defensive runtime (no Render crash on missing env / bad fetch)
 * - Real web evidence (Bing OR Serper), never "invented"
 * - PRO output: buckets (corroborate/contradict/neutral) + corrections (live checks)
 * - Same response contract style (status/requestId/engine/mode/result/meta)
 *
 * ENV required (choose one provider):
 * - IA11_API_KEY                  (required)
 * - SEARCH_PROVIDER               ("bing" | "serper" | "none") optional auto
 *
 * If Bing:
 * - BING_API_KEY                  (required for bing)
 * - BING_ENDPOINT                 default https://api.bing.microsoft.com/v7.0/search
 *
 * If Serper:
 * - SERPER_API_KEY                (required for serper)
 * - SERPER_ENDPOINT               default https://google.serper.dev/search
 *
 * Rate limit:
 * - RATE_LIMIT_PER_MIN            default 60
 * - RATE_LIMIT_PER_MIN_PRO        default 30
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- CONFIG --------------------
const ENGINE_NAME = "IA11";
const VERSION = "2.0.0-ultra-pro";

const IA11_API_KEY = process.env.IA11_API_KEY || "";

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

// Providers
const BING_API_KEY = process.env.BING_API_KEY || "";
const BING_ENDPOINT =
  process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";

const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SERPER_ENDPOINT = process.env.SERPER_ENDPOINT || "https://google.serper.dev/search";

// Auto provider
const SEARCH_PROVIDER = (
  process.env.SEARCH_PROVIDER ||
  (SERPER_API_KEY ? "serper" : BING_API_KEY ? "bing" : "none")
).toLowerCase();

// -------------------- SAFE FETCH --------------------
function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  // Fallback for older Node runtimes
  try {
    // node-fetch v2 commonjs
    // eslint-disable-next-line import/no-extraneous-dependencies
    const nf = require("node-fetch");
    return nf;
  } catch (e) {
    return null;
  }
}
const _fetch = getFetch();

// -------------------- UTIL --------------------
function nowMs() {
  return Date.now();
}

function makeId() {
  return crypto.randomBytes(10).toString("hex");
}

function safeStr(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toLowerSafe(s) {
  return safeStr(s).toLowerCase();
}

function guessLang(input) {
  const s = toLowerSafe(input);
  if (!s) return "fr";
  // Very simple: if it contains a lot of french markers
  const frHits = (s.match(/\b(le|la|les|des|est|sont|avec|donc|pour|sur|dans|qui)\b/g) || []).length;
  const enHits = (s.match(/\b(the|is|are|was|were|with|for|on|in|that|which)\b/g) || []).length;
  return frHits >= enHits ? "fr" : "en";
}

function scoreToRisk(score) {
  if (score >= 80) return "low";
  if (score >= 55) return "medium";
  return "high";
}

// Small credibility heuristic (domain trust-ish). You can extend later.
function domainCredibility(hostname) {
  const h = toLowerSafe(hostname);

  // High trust
  const strong = [
    ".gov", ".gc.ca", ".gouv.fr", ".europa.eu", ".who.int", ".un.org",
    "reuters.com", "apnews.com", "bbc.co.uk", "bbc.com",
    "nytimes.com", "washingtonpost.com", "theguardian.com",
    "economist.com", "nature.com", "science.org", "sciencemag.org",
    "encyclopedia.com", "britannica.com"
  ];

  // Medium trust
  const medium = [
    "wikipedia.org", "cnn.com", "cbc.ca", "radio-canada.ca", "france24.com",
    "lemonde.fr", "lapresse.ca", "globalnews.ca", "ft.com", "bloomberg.com"
  ];

  if (!h) return 40;

  if (strong.some((x) => h.endsWith(x) || h.includes(x))) return 90;
  if (medium.some((x) => h.endsWith(x) || h.includes(x))) return 75;

  // Default
  return 55;
}

function normalizeUrl(u) {
  const s = safeStr(u).trim();
  if (!s) return "";
  try {
    const url = new URL(s);
    // remove tracking-ish params lightly
    url.searchParams.delete("utm_source");
    url.searchParams.delete("utm_medium");
    url.searchParams.delete("utm_campaign");
    return url.toString();
  } catch {
    return s;
  }
}

function uniqByUrl(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const url = normalizeUrl(it?.url);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ ...it, url });
  }
  return out;
}

function bucketSources(sources) {
  const buckets = { corroborate: [], contradict: [], neutral: [] };
  for (const s of sources || []) {
    const stance = s?.stance === "corroborate" || s?.stance === "contradict" ? s.stance : "neutral";
    buckets[stance].push(s);
  }
  // sort
  for (const k of Object.keys(buckets)) {
    buckets[k] = buckets[k]
      .sort((a, b) => (b.credibility || 0) - (a.credibility || 0))
      .slice(0, 6);
  }
  return buckets;
}

// -------------------- RATE LIMIT --------------------
/**
 * Simple in-memory limiter.
 * Keyed by ip + mode. Resets per rolling minute.
 */
const rl = new Map();

function rateLimitCheck(req, mode) {
  const ip =
    safeStr(req.headers["x-forwarded-for"]).split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const bucketKey = `${ip}:${mode === "pro" ? "pro" : "standard"}`;
  const limit = mode === "pro" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const t = nowMs();
  const minute = Math.floor(t / 60000);

  const current = rl.get(bucketKey);
  if (!current || current.minute !== minute) {
    rl.set(bucketKey, { minute, count: 1 });
    return { ok: true, limit, remaining: limit - 1 };
  }

  if (current.count >= limit) {
    return { ok: false, limit, remaining: 0 };
  }

  current.count += 1;
  rl.set(bucketKey, current);
  return { ok: true, limit, remaining: limit - current.count };
}

// -------------------- CLAIM EXTRACTION --------------------
function looksLikeClaim(line) {
  const t = safeStr(line).trim();
  if (t.length < 12) return false;

  // Skip super generic lines
  const tooGeneric = /\b(i think|je pense|maybe|peut[- ]être|in my opinion|à mon avis)\b/i.test(t);
  if (tooGeneric) return false;

  const hasNumbers = /\b\d{1,4}\b/.test(t);
  const hasStrongVerb = /\b(is|are|was|were|has|have|born|elected|killed|won|will|est|sont|était|a été|né|née|élu|élue|a gagné|sera)\b/i.test(t);
  const hasEntityHint = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,4}\b/.test(t);

  // At least one "fact-like" signal
  return (hasStrongVerb && (hasEntityHint || hasNumbers)) || (hasNumbers && hasEntityHint);
}

function extractClaims(text) {
  const raw = safeStr(text).replace(/\r/g, "\n");

  // Split by lines and sentences (lightly)
  const chunks = raw
    .split("\n")
    .flatMap((l) => l.split(/(?<=[.!?])\s+/g))
    .map((s) => safeStr(s).trim())
    .filter(Boolean);

  const claims = [];
  for (const c of chunks) {
    const cleaned = c.replace(/^\s*[-*•]\s*/g, "").trim();
    if (!looksLikeClaim(cleaned)) continue;
    claims.push({ text: cleaned });
    if (claims.length >= 10) break;
  }

  // If we found none, fallback: take the best first long sentence
  if (claims.length === 0) {
    const fallback = chunks.find((x) => safeStr(x).length >= 30);
    if (fallback) claims.push({ text: fallback });
  }

  return claims;
}

// -------------------- WEB SEARCH --------------------
async function providerSearch(query, count = 8) {
  const q = safeStr(query).trim();
  if (!q) return { items: [], providerUsed: "none", webUsed: false, error: "empty_query" };

  if (!_fetch) {
    return { items: [], providerUsed: "none", webUsed: false, error: "fetch_unavailable" };
  }

  if (SEARCH_PROVIDER === "bing") {
    if (!BING_API_KEY) return { items: [], providerUsed: "bing", webUsed: false, error: "missing_bing_key" };

    try {
      const url = new URL(BING_ENDPOINT);
      url.searchParams.set("q", q);
      url.searchParams.set("count", String(clamp(count, 3, 10)));
      url.searchParams.set("textDecorations", "false");
      url.searchParams.set("textFormat", "raw");
      url.searchParams.set("safeSearch", "Moderate");

      const resp = await _fetch(url.toString(), {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
      });

      if (!resp.ok) {
        return { items: [], providerUsed: "bing", webUsed: false, error: `bing_http_${resp.status}` };
      }

      const data = await resp.json();
      const items = data?.webPages?.value || [];
      const mapped = items.map((it) => {
        const u = safeStr(it?.url);
        let host = "";
        try {
          host = new URL(u).hostname;
        } catch {}
        return {
          title: safeStr(it?.name),
          url: normalizeUrl(u),
          domain: host,
          snippet: safeStr(it?.snippet),
          credibility: domainCredibility(host),
        };
      });

      return { items: uniqByUrl(mapped), providerUsed: "bing", webUsed: true, error: null };
    } catch (e) {
      return { items: [], providerUsed: "bing", webUsed: false, error: "bing_exception" };
    }
  }

  if (SEARCH_PROVIDER === "serper") {
    if (!SERPER_API_KEY) return { items: [], providerUsed: "serper", webUsed: false, error: "missing_serper_key" };

    try {
      const resp = await _fetch(SERPER_ENDPOINT, {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q,
          num: clamp(count, 3, 10),
          gl: "ca",
          hl: "fr",
        }),
      });

      if (!resp.ok) {
        return { items: [], providerUsed: "serper", webUsed: false, error: `serper_http_${resp.status}` };
      }

      const data = await resp.json();
      const organic = Array.isArray(data?.organic) ? data.organic : [];
      const mapped = organic.map((it) => {
        const u = safeStr(it?.link);
        let host = "";
        try {
          host = new URL(u).hostname;
        } catch {}
        return {
          title: safeStr(it?.title),
          url: normalizeUrl(u),
          domain: host,
          snippet: safeStr(it?.snippet),
          credibility: domainCredibility(host),
        };
      });

      return { items: uniqByUrl(mapped), providerUsed: "serper", webUsed: true, error: null };
    } catch (e) {
      return { items: [], providerUsed: "serper", webUsed: false, error: "serper_exception" };
    }
  }

  return { items: [], providerUsed: "none", webUsed: false, error: "search_disabled" };
}

// -------------------- STANCE HEURISTICS --------------------
function stanceAgainstClaim(claimText, snippet) {
  const c = toLowerSafe(claimText);
  const s = toLowerSafe(snippet);

  if (!c || !s) return "neutral";

  // Very light contradiction signals
  const contradictSignals = [
    "false", "incorrect", "not true", "debunk", "hoax", "misleading",
    "faux", "inexact", "pas vrai", "démenti", "canular", "trompeur"
  ];

  const corroborateSignals = [
    "according to", "confirmed", "official", "announced", "reported",
    "selon", "confirmé", "officiel", "annoncé", "rapporté"
  ];

  // If snippet contains strong contradiction keywords, mark contradict
  if (contradictSignals.some((k) => s.includes(k))) return "contradict";
  if (corroborateSignals.some((k) => s.includes(k))) return "corroborate";

  // Otherwise neutral (safe)
  return "neutral";
}

// -------------------- PRO: LIVE CORRECTIONS (WOW) --------------------
/**
 * This does NOT "assert" facts from memory.
 * It queries the web for certain patterns and returns "best evidence snapshot".
 */
async function buildCorrections(claims, lang) {
  const corrections = [];
  const list = Array.isArray(claims) ? claims.slice(0, 6) : [];

  const patterns = [
    { key: "us_president", re: /\bpresident\b.*\b(united states|u\.s\.|usa|américain|américaine)\b/i,
      qFR: "président actuel des États-Unis",
      qEN: "current president of the United States"
    },
    { key: "canada_pm", re: /\b(prime minister|premier ministre)\b.*\b(canada|canadien|canadienne)\b/i,
      qFR: "premier ministre actuel du Canada",
      qEN: "current Prime Minister of Canada"
    },
    { key: "fr_president", re: /\bprésident\b.*\b(france|français|française)\b/i,
      qFR: "président actuel de la France",
      qEN: "current president of France"
    },
  ];

  for (const cl of list) {
    const text = safeStr(cl?.text);
    if (!text) continue;

    const match = patterns.find((p) => p.re.test(text));
    if (!match) continue;

    const q = lang === "fr" ? match.qFR : match.qEN;
    const sr = await providerSearch(q, 6);

    const top = (sr.items || []).slice(0, 3);
    if (top.length === 0) {
      corrections.push({
        claim: text,
        check: q,
        status: "unverified",
        note: lang === "fr"
          ? "Recherche web indisponible ou aucun résultat fiable."
          : "Web search unavailable or no reliable results.",
        sources: [],
      });
      continue;
    }

    corrections.push({
      claim: text,
      check: q,
      status: "evidence_found",
      note: lang === "fr"
        ? "Voici les meilleures sources trouvées en recherche live (à vérifier rapidement)."
        : "Top live evidence sources (quickly verify).",
      sources: top.map((x) => ({
        title: x.title,
        url: x.url,
        domain: x.domain,
        snippet: x.snippet,
        credibility: x.credibility,
      })),
    });
  }

  return corrections.slice(0, 4);
}

// -------------------- ANALYSIS CORE --------------------
async function analyzeText({ text, mode, lang }) {
  const t0 = nowMs();
  const claims = extractClaims(text);

  // Build evidence query
  const topClaims = claims.slice(0, 4).map((c) => safeStr(c.text)).filter(Boolean);
  const joined = topClaims.join(" | ");

  const query =
    lang === "fr"
      ? `vérifier ces affirmations: ${joined}`.trim()
      : `verify these claims: ${joined}`.trim();

  const search = await providerSearch(query, 10);
  const webUsed = search.webUsed === true;

  // Attach stance relative to first claim (safe heuristic)
  const firstClaim = safeStr(claims?.[0]?.text);
  const sources = (search.items || []).map((s) => ({
    ...s,
    stance: stanceAgainstClaim(firstClaim, s.snippet),
  }));

  const buckets = bucketSources(sources);

  // Score logic (safe & conservative)
  // Base score 50 then adjust based on evidence availability & source credibility
  const avgCred =
    sources.length > 0
      ? sources.reduce((a, b) => a + (Number(b.credibility) || 0), 0) / sources.length
      : 0;

  let score = 50;

  if (!webUsed) score -= 10;                 // no web = less confident
  if (claims.length === 0) score -= 8;       // no clear claims extracted

  // Credibility influence
  if (avgCred >= 80) score += 18;
  else if (avgCred >= 70) score += 12;
  else if (avgCred >= 60) score += 6;
  else if (avgCred > 0) score += 2;

  // Stance mix influence (still conservative)
  const cCount = buckets.corroborate.length;
  const xCount = buckets.contradict.length;

  if (cCount >= 3) score += 8;
  if (xCount >= 2) score -= 10;
  if (xCount >= 4) score -= 16;

  score = clamp(Math.round(score), 5, 98);

  const riskLevel = scoreToRisk(score);

  const confidence = clamp(
    (webUsed ? 0.75 : 0.55) + (avgCred / 100) * 0.2 - (xCount >= 3 ? 0.08 : 0),
    0.35,
    0.93
  );

  // Reasons (PRO wording)
  const reasons = [];
  if (claims.length > 0) reasons.push(lang === "fr" ? "Affirmations identifiées et vérifiables." : "Detected checkable claims.");
  else reasons.push(lang === "fr" ? "Texte trop vague pour extraire des affirmations solides." : "Text too vague to extract strong claims.");

  if (webUsed) reasons.push(lang === "fr" ? `Recherche web activée (${search.providerUsed}).` : `Web search enabled (${search.providerUsed}).`);
  else reasons.push(lang === "fr" ? "Recherche web indisponible → prudence." : "Web search unavailable → be cautious.");

  reasons.push(
    lang === "fr"
      ? `Qualité moyenne des sources: ~${Math.round(avgCred)} / 100.`
      : `Average source quality: ~${Math.round(avgCred)} / 100.`
  );

  if (buckets.contradict.length > 0) {
    reasons.push(
      lang === "fr"
        ? `Contradictions potentielles détectées (${buckets.contradict.length}).`
        : `Potential contradictions detected (${buckets.contradict.length}).`
    );
  }

  // Summary (WOW style, but honest)
  const summary =
    lang === "fr"
      ? `Score IA11: ${score}/98 (${riskLevel}). ${webUsed ? "Sources trouvées et classées." : "Pas de recherche web: analyse limitée."}`
      : `IA11 score: ${score}/98 (${riskLevel}). ${webUsed ? "Sources found and bucketed." : "No web search: limited analysis."}`;

  // Corrections (live checks) only for PRO mode
  const corrections = mode === "pro" ? await buildCorrections(claims, lang) : [];

  const tookMs = nowMs() - t0;

  return {
    score,
    riskLevel,
    confidence: Number(confidence.toFixed(2)),
    summary,
    reasons,
    claims: claims.slice(0, 8),
    sources: sources.slice(0, 10),
    buckets,
    corrections,
    web: {
      used: webUsed,
      provider: search.providerUsed,
      error: search.error || null,
    },
    tookMs,
  };
}

// -------------------- ROUTES --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    engine: ENGINE_NAME,
    version: VERSION,
    endpoints: {
      health: "GET /",
      status: "GET /v1/analyze",
      analyze: "POST /v1/analyze (header: x-ia11-key)",
    },
    searchProvider: SEARCH_PROVIDER,
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    ok: true,
    engine: ENGINE_NAME,
    version: VERSION,
    searchProvider: SEARCH_PROVIDER,
    webReady: SEARCH_PROVIDER !== "none" && (_fetch ? true : false),
  });
});

app.post("/v1/analyze", async (req, res) => {
  const t0 = nowMs();
  const requestId = makeId();

  try {
    // Security
    const key = safeStr(req.headers["x-ia11-key"]);
    if (!IA11_API_KEY || key !== IA11_API_KEY) {
      return res.status(401).json({
        status: "error",
        requestId,
        engine: ENGINE_NAME,
        mode: "standard",
        error: "unauthorized",
        message: "Invalid or missing x-ia11-key.",
      });
    }

    const body = req.body || {};
    const text = safeStr(body.text);
    const mode = toLowerSafe(body.mode) === "pro" ? "pro" : "standard";
    const uiLang = safeStr(body.lang || body.uiLang || "");
    const lang = uiLang ? guessLang(uiLang) : guessLang(text);

    if (!text || text.trim().length < 3) {
      return res.status(400).json({
        status: "error",
        requestId,
        engine: ENGINE_NAME,
        mode,
        error: "bad_request",
        message: "Missing 'text' in body.",
      });
    }

    // Rate limit
    const rlRes = rateLimitCheck(req, mode);
    res.setHeader("X-RateLimit-Limit", String(rlRes.limit));
    res.setHeader("X-RateLimit-Remaining", String(rlRes.remaining));
    if (!rlRes.ok) {
      return res.status(429).json({
        status: "error",
        requestId,
        engine: ENGINE_NAME,
        mode,
        error: "rate_limited",
        message: "Too many requests. Please slow down.",
      });
    }

    const result = await analyzeText({ text, mode, lang });

    return res.json({
      status: "ok",
      requestId,
      engine: ENGINE_NAME,
      mode,
      result: {
        score: result.score,
        riskLevel: result.riskLevel,
        summary: result.summary,
        reasons: result.reasons,
        confidence: result.confidence,
        // Keep compatibility + add PRO fields
        sources: result.sources,
        buckets: result.buckets,
        claims: result.claims,
        corrections: result.corrections,
        web: result.web,
      },
      meta: {
        tookMs: nowMs() - t0,
        version: VERSION,
      },
    });
  } catch (e) {
    return res.status(500).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: "standard",
      error: "server_error",
      message: "Unexpected server error.",
      meta: {
        tookMs: nowMs() - t0,
        version: VERSION,
      },
    });
  }
});

// -------------------- START --------------------
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[IA11] listening on :${port} | version=${VERSION} | provider=${SEARCH_PROVIDER}`);
});
