// =====================
// IA11 — LeenScore Engine (Render)
// =====================

const express = require("express");
const cors = require("cors");

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

function originAllowed(origin) {
  if (!origin) return true;
  if (origin.includes("lovable.app")) return true;
  if (origin.includes("leenscore.com")) return true;
  return false;
}

app.use(
  cors({
    origin: function (origin, cb) {
      if (originAllowed(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-ia11-key"],
  })
);

app.options("/*", cors());

// FETCH SAFE
const _fetch = global.fetch;
if (typeof _fetch !== "function") {
  console.error("Global fetch missing. Use Node 18+ on Render.");
  process.exit(1);
}

// ENV
const IA11_KEY = process.env.IA11_API_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const HTTP_TIMEOUT_MS = Number.parseInt(process.env.HTTP_TIMEOUT_MS || "8000", 10);
const MAX_SERPER_QUERIES_ENV = Number.parseInt(process.env.MAX_SERPER_QUERIES || "4", 10);
const SIMILARITY_STRICT_MODE = String(process.env.SIMILARITY_STRICT_MODE || "false").toLowerCase() === "true";

// =====================
// RATE LIMIT (RAM) — simple & efficace
// =====================
const RATE_LIMIT_STANDARD = Number.parseInt(process.env.RATE_LIMIT_PER_MIN || "10", 10);

const RATE_LIMIT_PRO = Number.parseInt(
  process.env.RATE_LIMIT_PER_MIN_PRO ||
    process.env.RATE_LIMIT_PER_MIN_P ||
    process.env.RATE_LIMIT_PRO_PER_MIN ||
    "30",
  10
);

const RATE_STORE = new Map(); // key -> { windowStart, count }
const RATE_WINDOW_MS = 60 * 1000;

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function rateLimitCheck(req, tier, limitPerMin) {
  if (!Number.isFinite(limitPerMin) || limitPerMin <= 0) return { ok: true };

  const ip = getClientIp(req);
  const key = `${tier}:${ip}`;
  const now = Date.now();

  const cur = RATE_STORE.get(key);
  if (!cur || now - cur.windowStart >= RATE_WINDOW_MS) {
    RATE_STORE.set(key, { windowStart: now, count: 1 });
    return { ok: true };
  }

  cur.count += 1;

  if (cur.count > limitPerMin) {
    const msLeft = RATE_WINDOW_MS - (now - cur.windowStart);
    const retryAfterSec = Math.max(1, Math.ceil(msLeft / 1000));
    return { ok: false, retryAfterSec };
  }

  return { ok: true };
}

// HEALTH
app.get("/", (req, res) => {
  res.json({ status: "ok", engine: "IA11 Ultra Pro" });
});

// ================= SERPER SEARCH =================
async function serperSearch(query, lang, num = 5) {
  console.log("🔎 SERPER QUERY:", query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const r = await _fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, gl: "us", hl: lang || "en", num }),
      signal: controller.signal,
    });

    const j = await r.json();
    console.log("📥 SERPER RESULTS:", (j.organic || []).length);

    return { ok: true, items: (j.organic || []).slice(0, Math.max(1, num)) };
  } catch (e) {
    const msg =
      e?.name === "AbortError" ? `timeout after ${HTTP_TIMEOUT_MS}ms` : (e?.message || "unknown error");
    console.log("❌ SERPER ERROR:", msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ================= IA11 PRO CORE (Brutal Standard + WOW PRO) =================

// Helpers
function safeLower(v) {
  return (v || "").toString().toLowerCase();
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString();
  } catch {
    return u || "";
  }
}

function domainOf(u) {
  try {
    const url = new URL(u);
    return (url.hostname || "").replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function stripSpaces(s) {
  return (s || "").toString().replace(/\s+/g, " ").trim();
}

function normalizeQuery(q) {
  return stripSpaces(safeLower(q))
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9\s\u00C0-\u017F]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const t = normalizeQuery(s).split(" ").filter(Boolean);
  return t.length ? t : [];
}

function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function levenshtein(a, b) {
  a = a || "";
  b = b || "";
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similarityScore(q1, q2) {
  const n1 = normalizeQuery(q1);
  const n2 = normalizeQuery(q2);

  if (!n1 || !n2) return 0;

  if (n1 === n2) return 1;

  const t1 = tokenize(n1);
  const t2 = tokenize(n2);

  const jac = jaccard(t1, t2);

  const maxLen = Math.max(n1.length, n2.length);
  const lev = levenshtein(n1, n2);
  const levSim = maxLen === 0 ? 0 : 1 - lev / maxLen;

  // Weighted blend
  const sim = 0.65 * jac + 0.35 * levSim;

  return clamp(sim, 0, 1);
}

function shouldTreatAsSameQuery(q1, q2) {
  // Strict mode = higher threshold
  const threshold = SIMILARITY_STRICT_MODE ? 0.86 : 0.78;
  return similarityScore(q1, q2) >= threshold;
}

// ================= CACHE (RAM) =================
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const SERPER_CACHE = new Map(); // key -> { ts, value }

function cacheKeyForSerper(query, lang) {
  return `${normalizeQuery(query)}::${(lang || "en").toLowerCase()}`;
}

function getCachedSerper(query, lang) {
  const key = cacheKeyForSerper(query, lang);
  const hit = SERPER_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    SERPER_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedSerper(query, lang, value) {
  const key = cacheKeyForSerper(query, lang);
  SERPER_CACHE.set(key, { ts: Date.now(), value });
}

// Similar-query cache lookup (to avoid paying Serper on typos/small variations)
function getCachedSerperSimilar(query, lang) {
  const langKey = (lang || "en").toLowerCase();
  const norm = normalizeQuery(query);

  // quick pass
  for (const [k, entry] of SERPER_CACHE.entries()) {
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      SERPER_CACHE.delete(k);
      continue;
    }
    const [cachedNorm, cachedLang] = k.split("::");
    if (cachedLang !== langKey) continue;

    if (cachedNorm === norm) return entry.value;

    if (shouldTreatAsSameQuery(cachedNorm, norm)) {
      return entry.value;
    }
  }
  return null;
}

// =====================
// STANDARD CORE (Option B : 70% texte + 30% mini reality-check Serper 1 query)
// =====================

function computeWritingScore(text) {
  const t = stripSpaces(text);
  if (!t) return 0;

  // Simple heuristics: caps, emojis, exclamation spam, length sanity
  const len = t.length;
  const caps = (t.match(/[A-ZÀ-ÖØ-Þ]/g) || []).length;
  const letters = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  const capsRatio = letters ? caps / letters : 0;

  const exclam = (t.match(/!/g) || []).length;
  const qmarks = (t.match(/\?/g) || []).length;

  const emojis = (t.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;

  let score = 75;

  // caps penalty
  if (capsRatio > 0.15) score -= 12;
  if (capsRatio > 0.3) score -= 20;

  // punctuation spam penalty
  if (exclam >= 3) score -= 8;
  if (exclam >= 6) score -= 14;
  if (qmarks >= 4) score -= 6;

  // emoji penalty
  if (emojis >= 4) score -= 10;
  if (emojis >= 8) score -= 18;

  // very short text reduces certainty
  if (len < 50) score -= 10;
  if (len < 25) score -= 18;

  // very long text: mild penalty (noise)
  if (len > 1500) score -= 6;

  return clamp(Math.round(score), 0, 100);
}

function labelFromScore(language, score) {
  const l = (language || "en").toLowerCase();
  const fr = l.startsWith("fr");

  if (score >= 80) return fr ? "Très crédible" : "Very credible";
  if (score >= 65) return fr ? "Crédible" : "Credible";
  if (score >= 50) return fr ? "Moyen" : "Mixed";
  if (score >= 35) return fr ? "Douteux" : "Dubious";
  return fr ? "Très douteux" : "Very dubious";
}

function computeStandard(text, language) {
  const writingScore = computeWritingScore(text);
  const l = (language || "en").toLowerCase();
  const fr = l.startsWith("fr");

  // score texte de base
  let textScore = writingScore;

  // cap -> éviter "faux/vrai", rester guide
  let capApplied = false;
  let capReason = "";

  // if extreme claims patterns, lower the base
  const t = safeLower(text);
  if (/(100%|certain|preuve absolue|impossible|toujours|jamais)/i.test(t)) {
    capApplied = true;
    capReason = fr
      ? "Formulations absolues détectées, prudence augmentée."
      : "Absolute phrasing detected; increased caution.";
    textScore = Math.max(35, textScore - 12);
  }

  const claimToCheck = extractMainClaim(text);

  const summary = fr
    ? "Analyse Standard : cohérence du texte + mini vérification web sur un point prioritaire."
    : "Standard analysis: text coherence + a minimal web check on one key point.";

  const bullets = {
    whatWeDid: fr ? "Lecture rapide du style et de la prudence." : "Quick read of style and prudence.",
    whatWeDid2: fr ? "Mini vérification web (1 requête) sur un claim prioritaire." : "Minimal web check (1 query) on a key claim.",
    proTease: fr
      ? "PRO : preuves + sources + explication complète."
      : "PRO: evidence + sources + full explanation.",
  };

  return {
    summary,
    textScore,
    bullets,
    standard: {
      writingScore,
      capApplied,
      capReason,
      claimToCheck,
    },
  };
}

function extractMainClaim(text) {
  const t = stripSpaces(text);
  if (!t) return "";
  // Take first sentence-ish
  const first = t.split(/[\.\n]/)[0];
  return stripSpaces(first).slice(0, 180);
}

function looksLikeVerifiableClaim(claim) {
  const c = safeLower(claim || "");
  if (!c) return false;
  if (c.length < 12) return false;
  if (/(je pense|opinion|feel|j'aime|j’aime|à mon avis|imo|imho)/i.test(c)) return false;
  return true;
}

async function runStandardRealityCheck(text, language, claimHint) {
  try {
    if (!SERPER_KEY) {
      return { used: false, realityScore: 55, verdict: null, checkedClaim: null };
    }

    const claim = stripSpaces(claimHint || extractMainClaim(text));
    const l = (language || "en").toLowerCase();
    const fr = l.startsWith("fr");

    if (!claim) return { used: false, realityScore: 55, verdict: null, checkedClaim: null };

    // CACHED? exact or similar
    const cached = getCachedSerperSimilar(claim, l);
    if (cached) {
      // Minimal “reality score” from cached results
      const realityScore = estimateRealityFromSearch(cached, fr);
      return {
        used: true,
        fromCache: true,
        realityScore,
        verdict: fr ? "Mini vérif via cache." : "Mini check via cache.",
        checkedClaim: claim,
      };
    }

    const sr = await serperSearch(claim, l, 5);
    if (!sr.ok) {
      return { used: false, realityScore: 55, verdict: sr.error || null, checkedClaim: claim };
    }

    setCachedSerper(claim, l, sr.items);

    const realityScore = estimateRealityFromSearch(sr.items, fr);

    return {
      used: true,
      fromCache: false,
      realityScore,
      verdict: fr
        ? "Mini vérification web effectuée (1 requête)."
        : "Minimal web check completed (1 query).",
      checkedClaim: claim,
    };
  } catch (e) {
    return { used: false, realityScore: 55, verdict: e.message || "error", checkedClaim: null };
  }
}

function estimateRealityFromSearch(items, fr) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 55;

  // Heuristic: if many high-trust domains appear, higher confidence
  const trusted = ["wikipedia.org", "britannica.com", "who.int", "cdc.gov", "nih.gov", "un.org", "oecd.org", "worldbank.org", "statcan.gc.ca", "gouv.qc.ca", "gc.ca"];
  let trustHits = 0;

  for (const it of list) {
    const d = domainOf(it.link || it.url || "");
    if (trusted.includes(d)) trustHits++;
  }

  if (trustHits >= 2) return 70;
  if (trustHits === 1) return 63;
  return 55;
}

// =====================
// PRO CORE (Evidence + buckets + sources)
// =====================

function reliabilityFromDomain(domain) {
  const d = (domain || "").toLowerCase();
  if (!d) return "unknown";

  const high = [
    "who.int",
    "cdc.gov",
    "nih.gov",
    "un.org",
    "oecd.org",
    "worldbank.org",
    "statcan.gc.ca",
    "gc.ca",
    "gouv.qc.ca",
    "nature.com",
    "science.org",
    "nejm.org",
    "thelancet.com",
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "nytimes.com",
    "washingtonpost.com",
    "theguardian.com",
    "economist.com",
    "britannica.com",
    "wikipedia.org"
  ];

  const medium = [
    "medium.com",
    "forbes.com",
    "bloomberg.com",
    "cnbc.com",
    "theconversation.com",
    "wired.com",
    "theverge.com"
  ];

  if (high.includes(d)) return "high";
  if (medium.includes(d)) return "medium";
  return "low";
}

function stanceHeuristic(text, claim) {
  // Very lightweight stance: unknown/neutral by default
  // (You can upgrade later with NLP)
  return "neutral";
}

async function runProEvidence(text, language) {
  const l = (language || "en").toLowerCase();
  const fr = l.startsWith("fr");

  const claim = stripSpaces(extractMainClaim(text)) || stripSpaces(text).slice(0, 200);

  // Queries (max controlled)
  const q1 = claim;
  const q2 = `fact check ${claim}`;
  const q3 = `${claim} source`;
  const q4 = `${claim} statistics`;

  const queries = [q1, q2, q3, q4].filter(Boolean).slice(0, clamp(MAX_SERPER_QUERIES_ENV, 1, 4));

  let allItems = [];
  let usedQueries = 0;
  let fromCache = false;

  for (const q of queries) {
    // Try cache exact/similar
    const cached = getCachedSerperSimilar(q, l);
    if (cached) {
      fromCache = true;
      allItems = allItems.concat(cached);
      usedQueries++;
      continue;
    }

    const sr = await serperSearch(q, l, 5);
    usedQueries++;

    if (sr.ok) {
      setCachedSerper(q, l, sr.items);
      allItems = allItems.concat(sr.items);
    } else {
      // ignore failures, keep going
    }
  }

  // Normalize serper item format into {title,url,domain,snippet}
  const normalized = (allItems || []).map((it) => {
    const url = normalizeUrl(it.link || it.url || "");
    const domain = domainOf(url);
    return {
      title: it.title || "",
      url,
      domain,
      snippet: it.snippet || it.description || "",
      reliability: reliabilityFromDomain(domain),
      stance: stanceHeuristic(text, claim),
    };
  });

  // De-dup by url
  const seen = new Set();
  const items = [];
  for (const it of normalized) {
    if (!it.url) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    items.push(it);
  }

  // Buckets (simple)
  const buckets = {
    corroborates: [],
    contradicts: [],
    neutral: [],
  };

  for (const it of items.slice(0, 12)) {
    // placeholder: keep neutral
    buckets.neutral.push({
      title: it.title,
      url: it.url,
      domain: it.domain,
      snippet: it.snippet,
    });
  }

  const evidence = buildEvidenceScore(items, fr);

  return {
    claim,
    items,
    buckets,
    queriesUsed: usedQueries,
    fromCache,
    evidence,
  };
}

function buildEvidenceScore(items, fr) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return {
      evidenceScore: 45,
      confidence: 10,
      strongRefute: false,
      notes: [fr ? "Peu de sources trouvées." : "Few sources found."],
    };
  }

  let score = 55;
  let confidence = 20;
  let high = 0;
  let med = 0;
  let low = 0;

  for (const it of list.slice(0, 10)) {
    if (it.reliability === "high") high++;
    else if (it.reliability === "medium") med++;
    else low++;
  }

  score += high * 10 + med * 4 - low * 2;
  confidence += high * 12 + med * 5 - low * 2;

  score = clamp(Math.round(score), 5, 95);
  confidence = clamp(Math.round(confidence), 5, 95);

  return {
    evidenceScore: score,
    confidence,
    strongRefute: false,
    notes: [],
  };
}

function computeProFinalScore(text, language, writingScore, evidenceScore, strongRefute, verifiable) {
  // Weighted blend
  let score = Math.round(0.35 * writingScore + 0.65 * evidenceScore);

  // If strong refutation, crush score (but not absolute)
  if (strongRefute) score = Math.min(score, 18);

  // If claim not verifiable, mild penalty
  if (!verifiable) score -= 8;

  return clamp(score, 0, 100);
}

function buildProExplanation(language, claim, evidence, buckets) {
  const l = (language || "en").toLowerCase();
  const fr = l.startsWith("fr");

  const evScore = evidence?.evidenceScore ?? 0;
  const conf = evidence?.confidence ?? 0;

  const intro = fr
    ? `Explication PRO (guide de crédibilité, pas un verdict).`
    : `PRO explanation (credibility guidance, not an absolute verdict).`;

  const claimLine = fr
    ? `Claim analysé : ${claim || "(non spécifié)"}`
    : `Analyzed claim: ${claim || "(not specified)"}`;

  const scoreLine = fr
    ? `Score preuves : ${evScore}/100 — Confiance : ${conf}/100.`
    : `Evidence score: ${evScore}/100 — Confidence: ${conf}/100.`;

  const bucketLine = fr
    ? `Sources triées : corroboration / contradiction / neutre (selon signaux simples).`
    : `Sources grouped: corroboration / contradiction / neutral (simple signals).`;

  const cautions = fr
    ? `Limites : les résultats dépendent des sources accessibles et du contexte.`
    : `Limits: results depend on accessible sources and context.`;

  return [intro, claimLine, scoreLine, bucketLine, cautions].join("\n");
}

// =====================
// MAIN API (Lovable-compatible)
// =====================

// Optional auth: if IA11_API_KEY is set, require x-ia11-key header
function authCheck(req, res) {
  if (!IA11_KEY) return true;
  if (req.headers["x-ia11-key"] !== IA11_KEY) {
    res.status(401).json({ error: "Invalid key" });
    return false;
  }
  return true;
}

async function analyzeCore(req, { content, analysisType, language }) {
  const text = content;
  const mode = safeLower(analysisType) === "pro" ? "pro" : "standard";

  // RATE LIMIT (Standard vs Pro)
  const limit = mode === "pro" ? RATE_LIMIT_PRO : RATE_LIMIT_STANDARD;
  const rl = rateLimitCheck(req, mode, limit);
  if (!rl.ok) {
    const err = new Error("RATE_LIMIT");
    err.httpStatus = 429;
    err.retryAfterSec = rl.retryAfterSec;
    err.limitPerMin = limit;
    err.analysisType = mode;
    throw err;
  }

  // -----------------------
  // STANDARD
  // -----------------------
  if (mode === "standard") {
    const standardOut = computeStandard(text, language);

    // 1 mini check Serper sur 1 claim prioritaire (sans afficher de sources à l'utilisateur)
    const reality = await runStandardRealityCheck(text, language, standardOut?.standard?.claimToCheck);
    const realityScore = typeof reality?.realityScore === "number" ? reality.realityScore : 55;

    const finalScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(0.7 * (standardOut.textScore || 0) + 0.3 * realityScore)
      )
    );

    const l = (language || "en").toLowerCase();
    const fr = l.startsWith("fr");

    const summary = `${standardOut.summary} ${
      standardOut?.bullets?.proTease ||
      (fr ? "PRO : preuves + sources + explication complète." : "PRO: evidence + sources + full explanation.")
    }`;

    // Breakdown minimal, compatible UI (points 0..100)
    const breakdown = {
      sources: { points: 0, reason: fr ? "Standard : pas de liens affichés (tease PRO)." : "Standard: no links displayed (PRO tease)." },
      factual: { points: Math.round(realityScore), reason: reality?.verdict || "" },
      tone: { points: Math.round(standardOut?.standard?.writingScore ?? standardOut?.textScore ?? 50), reason: fr ? "Qualité d'écriture et prudence." : "Writing quality and prudence." },
      context: { points: 55, reason: fr ? "Contexte limité sans lecture d'article complet." : "Limited context without full-article reading." },
      transparency: { points: 60, reason: fr ? "Guide de crédibilité, pas un verdict absolu." : "Credibility guidance, not an absolute verdict." },
    };

    return {
      analysisType: "standard",
      result: {
        analysisType: "standard",
        score: finalScore,
        label: labelFromScore(language, finalScore),
        summary,
        articleSummary: "",
        confidence: 0.35,
        breakdown,
        sources: [],
        standard: {
          textScore: standardOut.textScore,
          realityScore,
          bullets: standardOut.bullets,
          details: {
            writingScore: standardOut?.standard?.writingScore,
            capApplied: standardOut?.standard?.capApplied,
            capReason: standardOut?.standard?.capReason,
            claimChecked: reality?.checkedClaim || standardOut?.standard?.claimToCheck || null,
            realityVerdict: reality?.verdict || null,
            realityUsed: !!reality?.used,
          },
        },
      },
    };
  }

  // -----------------------
  // PRO
  // -----------------------
  if (!SERPER_KEY) {
    const err = new Error("Missing SERPER_API_KEY");
    err.httpStatus = 500;
    throw err;
  }

  const writingScore = computeWritingScore(text);
  const proSearch = await runProEvidence(text, language);

  const verifiable = looksLikeVerifiableClaim(proSearch?.claim || text);

  const evidenceScore = proSearch?.evidence?.evidenceScore ?? 45;
  const confidencePct = proSearch?.evidence?.confidence ?? 10; // 0..100-ish
  const strongRefute = proSearch?.evidence?.strongRefute ?? false;

  const finalScore = computeProFinalScore(
    text,
    language,
    writingScore,
    evidenceScore,
    strongRefute,
    verifiable
  );

  const explanation = buildProExplanation(
    language,
    proSearch.claim,
    proSearch.evidence,
    proSearch.buckets
  );

  const l = (language || "en").toLowerCase();
  const fr = l.startsWith("fr");

  const summary = fr
    ? (strongRefute
        ? "Sources fiables consultées : contradiction forte. Crédibilité très faible."
        : "Analyse PRO basée sur preuves : sources consultées et justification détaillée.")
    : (strongRefute
        ? "Reliable sources consulted: strong contradiction. Very low credibility."
        : "PRO evidence-based analysis: sources consulted and detailed justification.");

  const sources = (proSearch.items || []).slice(0, 8).map((it) => ({
    title: it.title,
    url: it.url,
    domain: it.domain,
    reliability: it.reliability,
    stance: it.stance,
    snippet: it.snippet,
  }));

  const breakdown = {
    sources: { points: Math.max(10, Math.min(100, Math.round(evidenceScore))), reason: fr ? "Qualité/fiabilité des sources et cohérence." : "Source quality/reliability and coherence." },
    factual: { points: Math.max(10, Math.min(100, Math.round(evidenceScore))), reason: fr ? "Alignement avec des sources vérifiables." : "Alignment with verifiable sources." },
    tone: { points: Math.max(10, Math.min(100, Math.round(writingScore))), reason: fr ? "Prudence, formulations, signes d'exagération." : "Prudence, phrasing, exaggeration signals." },
    context: { points: verifiable ? 70 : 45, reason: verifiable ? (fr ? "Affirmation vérifiable." : "Verifiable claim.") : (fr ? "Affirmation floue/difficile à vérifier." : "Vague/hard-to-verify claim.") },
    transparency: { points: 75, reason: fr ? "Méthode et limites expliquées, pas de vérité absolue." : "Method and limits stated; no absolute truth claims." },
  };

  return {
    analysisType: "pro",
    result: {
      analysisType: "pro",
      score: finalScore,
      label: labelFromScore(language, finalScore),
      summary,
      articleSummary: "",
      confidence: Math.max(0.05, Math.min(0.95, (Number(confidencePct) || 10) / 100)),
      breakdown,
      corroboration: {
        corroborates: (proSearch.buckets.corroborates || []).slice(0, 3),
        contradicts: (proSearch.buckets.contradicts || []).slice(0, 3),
        neutral: (proSearch.buckets.neutral || []).slice(0, 3),
      },
      pro: {
        writingScore,
        evidenceScore,
        strongRefute,
        explanation,
        claim: proSearch.claim,
        buckets: {
          corroborates: (proSearch.buckets.corroborates || []).slice(0, 3),
          contradicts: (proSearch.buckets.contradicts || []).slice(0, 3),
          neutral: (proSearch.buckets.neutral || []).slice(0, 3),
        },
        queriesUsed: proSearch.queriesUsed,
        fromCache: proSearch.fromCache,
        notes: proSearch.evidence.notes || [],
      },
      sources,
    },
  };
}

app.post("/analyze", async (req, res) => {
  try {
    if (!authCheck(req, res)) return;

    const { content, analysisType, language } = req.body || {};
    if (!content) return res.status(400).json({ error: "content required" });

    const out = await analyzeCore(req, { content, analysisType, language });

    return res.json({
      status: "ok",
      engine: "IA11 Ultra Pro",
      analysisType: out.analysisType,
      result: out.result,
    });
  } catch (e) {
    const status = e.httpStatus || 500;
    if (status === 429) {
      res.set("Retry-After", String(e.retryAfterSec || 10));
      return res.status(429).json({
        error: "Rate limit exceeded",
        analysisType: e.analysisType || "standard",
        limitPerMin: e.limitPerMin || 0,
        retryAfterSec: e.retryAfterSec || 10,
      });
    }
    return res.status(status).json({ error: e.message || "IA11_ERROR" });
  }
});

// Legacy endpoint (older clients): { text, mode, language }
app.post("/v1/analyze", async (req, res) => {
  try {
    if (!authCheck(req, res)) return;

    const { text, mode, language } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });

    const out = await analyzeCore(req, { content: text, analysisType: mode, language });

    return res.json({
      status: "ok",
      engine: "IA11 Ultra Pro",
      analysisType: out.analysisType,
      result: out.result,
    });
  } catch (e) {
    const status = e.httpStatus || 500;
    if (status === 429) {
      res.set("Retry-After", String(e.retryAfterSec || 10));
      return res.status(429).json({
        error: "Rate limit exceeded",
        analysisType: e.analysisType || "standard",
        limitPerMin: e.limitPerMin || 0,
        retryAfterSec: e.retryAfterSec || 10,
      });
    }
    return res.status(status).json({ error: e.message || "IA11_ERROR" });
  }
});

// Translate an already computed analysis WITHOUT new web search.
// Input: { analysisData, targetLanguage }
app.post("/translate-analysis", async (req, res) => {
  try {
    if (!authCheck(req, res)) return;

    const { analysisData, targetLanguage } = req.body || {};
    if (!analysisData || typeof analysisData !== "object") {
      return res.status(400).json({ error: "analysisData required" });
    }

    const lang = (targetLanguage || "en").toLowerCase();
    const fr = lang.startsWith("fr");

    // Normalize shape: accept either {result:{...}} or already the result object
    const root = analysisData.result ? analysisData : { analysisType: analysisData.analysisType, result: analysisData };
    const result = root.result || {};

    const analysisType = root.analysisType || result.analysisType || "pro";

    // Copy and rebuild only the language-dependent strings
    const translated = JSON.parse(JSON.stringify(root));

    translated.analysisType = analysisType;
    translated.result.analysisType = analysisType;

    // Recompute label + summary in target language
    const score = Number(result.score ?? 0);
    translated.result.label = labelFromScore(lang, score);

    if (analysisType === "pro") {
      const strongRefute = !!result?.pro?.strongRefute;
      translated.result.summary = fr
        ? (strongRefute
            ? "Sources fiables consultées : contradiction forte. Crédibilité très faible."
            : "Analyse PRO basée sur preuves : sources consultées et justification détaillée.")
        : (strongRefute
            ? "Reliable sources consulted: strong contradiction. Very low credibility."
            : "PRO evidence-based analysis: sources consulted and detailed justification.");

      // Rebuild explanation if we have the pieces
      const claim = result?.pro?.claim || "";
      const evidenceScore = result?.pro?.evidenceScore ?? 45;
      const confidence = Math.round((Number(result.confidence || 0.1) * 100));
      const evidence = {
        evidenceScore,
        confidence,
        strongRefute: !!result?.pro?.strongRefute,
        notes: Array.isArray(result?.pro?.notes) ? result.pro.notes : [],
      };
      const buckets = result?.pro?.buckets || {
        corroborates: result?.corroboration?.corroborates || [],
        contradicts: result?.corroboration?.contradicts || [],
        neutral: result?.corroboration?.neutral || [],
      };

      translated.result.pro.explanation = buildProExplanation(lang, claim, evidence, buckets);

      // Breakdown reasons language
      translated.result.breakdown = translated.result.breakdown || {};
      translated.result.breakdown.sources = {
        points: Number(translated.result.breakdown.sources?.points ?? Math.round(evidenceScore)),
        reason: fr ? "Qualité/fiabilité des sources et cohérence." : "Source quality/reliability and coherence.",
      };
      translated.result.breakdown.factual = {
        points: Number(translated.result.breakdown.factual?.points ?? Math.round(evidenceScore)),
        reason: fr ? "Alignement avec des sources vérifiables." : "Alignment with verifiable sources.",
      };
      translated.result.breakdown.tone = {
        points: Number(translated.result.breakdown.tone?.points ?? 60),
        reason: fr ? "Prudence, formulations, signes d'exagération." : "Prudence, phrasing, exaggeration signals.",
      };
      translated.result.breakdown.context = {
        points: Number(translated.result.breakdown.context?.points ?? 55),
        reason: fr ? "Contexte et vérifiabilité." : "Context and verifiability.",
      };
      translated.result.breakdown.transparency = {
        points: Number(translated.result.breakdown.transparency?.points ?? 70),
        reason: fr ? "Méthode et limites expliquées." : "Method and limits stated.",
      };
    } else {
      // Standard: keep the computed summary, just swap the PRO tease sentence if present
      const base = String(result.summary || "");
      const teaseFR = "PRO : preuves + sources + explication complète.";
      const teaseEN = "PRO: evidence + sources + full explanation.";

      if (fr) {
        translated.result.summary = base.replace(teaseEN, teaseFR);
      } else {
        translated.result.summary = base.replace(teaseFR, teaseEN);
      }

      // Breakdown reasons language
      translated.result.breakdown = translated.result.breakdown || {};
      translated.result.breakdown.sources = {
        points: Number(translated.result.breakdown.sources?.points ?? 0),
        reason: fr ? "Standard : pas de liens affichés (tease PRO)." : "Standard: no links displayed (PRO tease).",
      };
      translated.result.breakdown.transparency = {
        points: Number(translated.result.breakdown.transparency?.points ?? 60),
        reason: fr ? "Guide de crédibilité, pas un verdict absolu." : "Credibility guidance, not an absolute verdict.",
      };
    }

    return res.json({
      status: "ok",
      engine: "IA11 Ultra Pro",
      analysisType: translated.analysisType,
      result: translated.result,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "IA11_TRANSLATE_ERROR" });
  }
});

// Screenshot / Image analysis (lightweight, no heavy OCR libs).
// Input: { imageData, language, analysisType, contextText }
// Output: { ocr:{cleaned_text}, image_signals:{...}, analysis:{...} }
app.post("/analyze-image", async (req, res) => {
  try {
    if (!authCheck(req, res)) return;

    const { imageData, language, analysisType, contextText } = req.body || {};

    const cleaned = (contextText || "").toString().trim();

    // Minimal signals (placeholders) — you can upgrade later with real CV/OCR.
    const image_signals = {
      screenshot_likelihood: "unknown",
      compression_artifacts: "unknown",
      font_consistency: "unknown",
      metadata_flags: [],
      manipulation_probability: "unknown",
    };

    const warning =
      cleaned.length === 0
        ? "OCR not enabled on IA11 yet. Provide contextText to run text-based analysis."
        : null;

    let analysis = null;

    // If we have text context, we can produce a real analysis immediately.
    if (cleaned.length > 0) {
      const out = await analyzeCore(req, { content: cleaned, analysisType, language });
      analysis = { analysisType: out.analysisType, result: out.result };
    }

    return res.json({
      status: "ok",
      engine: "IA11 Ultra Pro",
      ocr: {
        cleaned_text: cleaned,
        raw_text: cleaned,
      },
      image_signals,
      analysis,
      warning,
      visual_text_mismatch: null,
      visual_description: null,
    });
  } catch (e) {
    const status = e.httpStatus || 500;
    if (status === 429) {
      res.set("Retry-After", String(e.retryAfterSec || 10));
      return res.status(429).json({
        error: "Rate limit exceeded",
        analysisType: e.analysisType || "standard",
        limitPerMin: e.limitPerMin || 0,
        retryAfterSec: e.retryAfterSec || 10,
      });
    }
    return res.status(status).json({ error: e.message || "IA11_IMAGE_ERROR" });
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("IA11 Ultra Pro running on port", PORT);
});
