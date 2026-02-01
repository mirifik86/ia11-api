/**
 * IA11 - Credibility Intelligence Engine (Express)
 * Version: 1.1 (Ultra PRO / WOW)
 *
 * Upgrades included:
 * 1) Multi-country public roles (US/Canada/France/UK) with verified facts via Bing (runtime)
 * 2) Smarter claim extraction (better sentences, bullets, and "fact-like" detection)
 * 3) PRO output "wow": sources bucketed (corroborate/contradict/neutral), verified facts + corrections
 *
 * Routes:
 * - GET /                 -> health + quick instructions
 * - GET /v1/analyze        -> engine status
 * - POST /v1/analyze       -> main analysis (protected by x-ia11-key)
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto"); // 

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- ENV --------------------
const ENGINE_NAME = "IA11";
const VERSION = "1.1";

const IA11_API_KEY = process.env.IA11_API_KEY || "";

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

const BING_API_KEY = process.env.BING_API_KEY || "";
const BING_ENDPOINT =
  process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";

// --- WEB SEARCH PROVIDERS ---
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || (SERPER_API_KEY ? "serper" : (BING_API_KEY ? "bing" : "none"))).toLowerCase();


// Optional: stricter guardrail list (OFF unless you provide CRITICAL_FACTS_JSON)
let CRITICAL_FACTS = [];
try {
  const raw = process.env.CRITICAL_FACTS_JSON || "";
  if (raw.trim()) CRITICAL_FACTS = JSON.parse(raw);
} catch {
  CRITICAL_FACTS = [];
}

// -------------------- HELPERS --------------------
function nowMs() {
  return Date.now();
}

function safeStr(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function makeId() {
  return crypto.randomBytes(10).toString("hex");
}

function scoreToRisk(score) {
  if (score >= 80) return "low";
  if (score >= 55) return "medium";
  return "high";
}

function detectLikelyLang(text) {
  const t = safeStr(text);
  const frHints =
    /\b(le|la|les|des|une|un|est|président|premier ministre|aujourd'hui|selon)\b/i;
  const hasAccents = /[àâäçéèêëîïôöùûüÿœ]/i.test(t);
  return hasAccents || frHints.test(t) ? "fr" : "en";
}

function isProUser(req) {
  // Wire this later from your payment layer if you want (JWT, etc.)
  const plan = safeStr(req.headers["x-leenscore-plan"]).toLowerCase();
  return plan === "pro" || plan === "premium" || plan === "premium_plus";
}

// -------------------- RATE LIMIT (simple in-memory) --------------------
const buckets = new Map(); // key -> { count, resetAt }

function rateLimit(req, isPro) {
  const ip =
    safeStr(req.headers["cf-connecting-ip"]) ||
    safeStr(req.headers["x-forwarded-for"]) ||
    req.ip ||
    "unknown";
  const key = `${ip}:${isPro ? "pro" : "std"}`;
  const limit = isPro ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;
  const now = nowMs();

  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true, remaining: limit - 1 };
  }

  if (b.count >= limit) {
    return { ok: false, retryAfterMs: b.resetAt - now };
  }

  b.count += 1;
  return { ok: true, remaining: limit - b.count };
}

// -------------------- SOURCES NORMALIZATION + BUCKETING --------------------
function domainCredibility(domain) {
  const d = safeStr(domain).toLowerCase();
  if (!d) return 0.5;

  // High trust
  if (d.endsWith(".gov") || d.includes("canada.ca") || d.includes("gouv.fr")) return 0.9;
  if (d.includes("whitehouse.gov") || d.includes("usa.gov")) return 0.92;
  if (d.includes("parliament.uk") || d.includes("gov.uk")) return 0.9;

  // Medium-high trust
  if (d.includes("britannica.com")) return 0.86;
  if (d.includes("wikipedia.org")) return 0.75;

  // Big outlets
  const big = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "nytimes.com",
    "theguardian.com",
  ];
  if (big.some((x) => d.includes(x))) return 0.78;

  return 0.6;
}

function normalizeSources(sources) {
  const arr = Array.isArray(sources) ? sources : [];
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const url = safeStr(s?.url).trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const domain = safeStr(s?.domain).trim();
    const stance = safeStr(s?.stance).trim() || "neutral"; // "corroborate" | "contradict" | "neutral"

    out.push({
      title: safeStr(s?.title).trim() || url,
      url,
      domain,
      stance,
      credibility:
        typeof s?.credibility === "number"
          ? s.credibility
          : domainCredibility(domain),
      snippet: safeStr(s?.snippet).trim(),
    });
  }
  return out.slice(0, 12);
}

function bucketSources(sources) {
  const buckets = { corroborate: [], contradict: [], neutral: [] };
  const list = Array.isArray(sources) ? sources : [];
  for (const s of list) {
    const stance = safeStr(s?.stance).toLowerCase();
    if (stance === "corroborate") buckets.corroborate.push(s);
    else if (stance === "contradict") buckets.contradict.push(s);
    else buckets.neutral.push(s);
  }

  // Sort inside buckets by credibility desc
  for (const k of Object.keys(buckets)) {
    buckets[k] = buckets[k].sort((a, b) => (b.credibility || 0) - (a.credibility || 0)).slice(0, 6);
  }

  return buckets;
}

// -------------------- BING EVIDENCE --------------------
async function fetchBingEvidence(query, count = 6) {
  if (!BING_API_KEY) return [];

  const url = new URL(BING_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(clamp(count, 3, 10)));
  url.searchParams.set("textDecorations", "false");
  url.searchParams.set("textFormat", "raw");
  url.searchParams.set("safeSearch", "Moderate");

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
  });

  if (!resp.ok) return [];

  const data = await resp.json();
  const items = data?.webPages?.value || [];
  return items.map((it) => {
    const u = safeStr(it?.url);
    let domain = "";
    try {
      domain = new URL(u).hostname;
    } catch {}
    return {
      title: safeStr(it?.name),
      url: u,
      domain,
      snippet: safeStr(it?.snippet),
      credibility: domainCredibility(domain),
      stance: "neutral",
    };
  });
}

async function buildEvidence(claims, lang) {
  if (!BING_API_KEY) return { items: [], webUsed: false };

  const top = (Array.isArray(claims) ? claims : []).slice(0, 4);
  const joined = top.map((c) => safeStr(c?.text)).filter(Boolean).join(" | ");

  // Better search query: include verify keywords + keep it tight
  const q =
    lang === "fr"
      ? `vérifier affirmation: ${joined}`
      : `verify claim: ${joined}`;

  const web = await fetchBingEvidence(q, 8);

  // Keep & normalize
  const sorted = web.sort((a, b) => (b.credibility || 0) - (a.credibility || 0));
  return { items: normalizeSources(sorted), webUsed: true };
}

// -------------------- SMART CLAIM EXTRACTION (Upgrade #2) --------------------
function looksLikeClaim(s) {
  const t = safeStr(s).trim();
  if (t.length < 12) return false;

  // "Fact-like" markers
  const hasNumbers = /\b\d{1,4}\b/.test(t);
  const hasStrongVerb = /\b(is|are|was|were|has|have|born|elected|killed|won|est|sont|était|a été|né|née|élu|élue|a gagné)\b/i.test(t);
  const hasEntityHint = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3}\b/.test(t);

  // Avoid pure questions
  const isQuestion = /\?\s*$/.test(t);

  if (isQuestion) return false;
  if (hasNumbers && hasStrongVerb) return true;
  if (hasEntityHint && hasStrongVerb) return true;

  // fallback
  return t.length >= 30;
}

function extractCoreClaims(text) {
  const raw = safeStr(text).trim();
  if (!raw) return [];

  // Split lines first (bullets)
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^\s*[-•\*]+\s*/g, "").trim())
    .filter(Boolean);

  // Then split long lines into sentences
  const parts = [];
  for (const line of lines) {
    const chunks = line
      .split(/(?<=[\.\!\?])\s+/g)
      .map((x) => x.trim())
      .filter(Boolean);
    parts.push(...chunks);
  }

  // Keep "claim-like" sentences first
  const claimish = parts.filter(looksLikeClaim);

  // If nothing claim-like, keep a safe fallback
  const finalParts = (claimish.length ? claimish : parts).slice(0, 8);

  return finalParts.map((c, idx) => ({ id: `c${idx + 1}`, text: c }));
}

// -------------------- OPTIONAL GUARDRAIL (no dangerous hardcodes) --------------------
function applyCriticalFactsGuard(text, lang) {
  const t = safeStr(text).toLowerCase();
  if (!CRITICAL_FACTS.length) return null;

  const now = new Date();
  for (const f of CRITICAL_FACTS) {
    const type = safeStr(f.type).toLowerCase();
    if (type !== "office_holder") continue;

    const validFrom = f.validFrom ? new Date(f.validFrom) : null;
    const validTo = f.validTo ? new Date(f.validTo) : null;
    if (validFrom && now < validFrom) continue;
    if (validTo && now > validTo) continue;

    const role = safeStr(f.role).toLowerCase();
    const juris = safeStr(f.jurisdiction).toLowerCase();
    const val = safeStr(f.value).toLowerCase();

    const targetsRole = role && t.includes(role);
    const targetsJuris = juris && t.includes(juris);
    if (!targetsRole || !targetsJuris || !val) continue;

    const containsCorrect = t.includes(val);
    if (containsCorrect) continue;

    const hasPersonName = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(text || "");
    if (!hasPersonName) continue;

    return {
      triggered: true,
      message:
        lang === "fr"
          ? "Garde-fou: sujet officiel sensible. IA11 exige des preuves externes solides."
          : "Guardrail: sensitive official topic. IA11 requires strong external evidence.",
      fact: f,
    };
  }

  return null;
}

// -------------------- VERIFIED PUBLIC FACTS (Upgrade #1 + WOW) --------------------
// Targets you can expand anytime (ultra scalable)
const PUBLIC_ROLE_TARGETS = [
  {
    id: "us_president",
    langQueries: {
      fr: "président actuel des États-Unis âge date de naissance",
      en: "current president of the United States age birth date",
    },
    triggers: [
      /président (américain|americain)/i,
      /président des états-?unis/i,
      /president of the united states/i,
      /\bUS president\b/i,
    ],
    label: { fr: "Président actuel des États-Unis", en: "Current U.S. President" },
  },
  {
    id: "canada_pm",
    langQueries: {
      fr: "premier ministre actuel du Canada âge date de naissance",
      en: "current prime minister of Canada age birth date",
    },
    triggers: [
      /premier ministre (du|du canada|canadien)/i,
      /prime minister of canada/i,
      /\bCanada prime minister\b/i,
    ],
    label: { fr: "Premier ministre actuel du Canada", en: "Current Prime Minister of Canada" },
  },
  {
    id: "france_president",
    langQueries: {
      fr: "président actuel de la France âge date de naissance",
      en: "current president of France age birth date",
    },
    triggers: [
      /président (de la )?france/i,
      /president of france/i,
    ],
    label: { fr: "Président actuel de la France", en: "Current President of France" },
  },
  {
    id: "uk_pm",
    langQueries: {
      fr: "premier ministre actuel du Royaume-Uni âge date de naissance",
      en: "current prime minister of the United Kingdom age birth date",
    },
    triggers: [
      /premier ministre (du )?royaume-?uni/i,
      /prime minister of the united kingdom/i,
      /prime minister of the uk/i,
    ],
    label: { fr: "Premier ministre actuel du Royaume-Uni", en: "Current UK Prime Minister" },
  },
];

function monthToNumber(monthName) {
  const m = safeStr(monthName).toLowerCase();
  const map = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  };
  return map[m] || 0;
}

function computeAgeFromBirth(year, month, day) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (!y || !mo || !d) return null;

  const now = new Date();
  let age = now.getFullYear() - y;
  const hadBirthday =
    now.getMonth() + 1 > mo ||
    (now.getMonth() + 1 === mo && now.getDate() >= d);
  if (!hadBirthday) age -= 1;
  return age;
}

function parseBirthDate(snippet) {
  const s = safeStr(snippet);

  // EN: "born June 14, 1946"
  let m = s.match(/\bborn\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (m) return { month: m[1], day: Number(m[2]), year: Number(m[3]) };

  // FR: "né le 14 juin 1946"
  m = s.match(/\bné[e]?\s+le\s+(\d{1,2})\s+([A-Za-zéèêàâîïôöùûüçœ]+)\s+(\d{4})/i);
  if (m) return { day: Number(m[1]), month: m[2], year: Number(m[3]) };

  return null;
}

function extractLikelyPersonName(titleOrSnippet) {
  const txt = safeStr(titleOrSnippet);

  // "X - Wikipedia" / "X — Wikipedia"
  const wiki = txt.match(/^(.+?)\s[-—]\s(Wikipedia|Wikipédia)\b/i);
  if (wiki && wiki[1] && wiki[1].trim().length <= 60) return wiki[1].trim();

  // Generic "Firstname Lastname"
  const m = txt.match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})\b/);
  if (!m) return "";
  const candidate = m[1].trim();

  const bad = [
    "United States", "États Unis", "White House", "Wikipedia", "President of", "Président de",
    "Prime Minister", "Premier ministre", "Royaume-Uni", "United Kingdom", "Canada", "France",
  ];
  if (bad.some((b) => candidate.toLowerCase().includes(b.toLowerCase()))) return "";

  return candidate;
}

function pickBestPublicFactResult(results) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const preferred = [
    "whitehouse.gov",
    "usa.gov",
    "canada.ca",
    "parliament.uk",
    "gov.uk",
    "elysee.fr",
    "gouv.fr",
    "britannica.com",
    "wikipedia.org",
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
  ];

  const scored = results
    .map((r) => {
      const domain = safeStr(r.domain).toLowerCase();
      const prefIdx = preferred.findIndex((p) => domain.includes(p));
      const prefScore = prefIdx === -1 ? 999 : prefIdx;
      return { r, prefScore, c: Number(r.credibility || 0) };
    })
    .sort((a, b) => a.prefScore - b.prefScore || b.c - a.c);

  return scored[0]?.r || null;
}

function findTargetsInText(text) {
  const t = safeStr(text);
  const hits = [];
  for (const target of PUBLIC_ROLE_TARGETS) {
    if (target.triggers.some((rx) => rx.test(t))) hits.push(target);
  }
  return hits;
}

function extractClaimedAge(text) {
  const t = safeStr(text).toLowerCase();
  const m = t.match(/\b(\d{1,3})\s*(ans|years?)\b/);
  return m ? Number(m[1]) : null;
}

function mentionsWoman(text) {
  const t = safeStr(text).toLowerCase();
  return t.includes("femme") || t.includes("woman") || t.includes("female");
}

async function buildPublicFacts(text, lang) {
  const t = safeStr(text);
  const L = lang || detectLikelyLang(t);

  const targets = findTargetsInText(t);
  if (!targets.length) return { facts: [], corrections: [], contradictions: [], sources: [] };

  const facts = [];
  const corrections = [];
  const contradictions = [];
  const sources = [];

  const claimedAge = extractClaimedAge(t);
  const claimedWoman = mentionsWoman(t);

  for (const target of targets) {
    const query = target.langQueries[L] || target.langQueries.en;
    const web = await fetchBingEvidence(query, 7);
    const best = pickBestPublicFactResult(web);
    if (!best) continue;

    const name =
      extractLikelyPersonName(best.title) ||
      extractLikelyPersonName(best.snippet);

    const bd = parseBirthDate(best.snippet || "");
    let age = null;
    if (bd) {
      const mo = monthToNumber(bd.month);
      age = computeAgeFromBirth(bd.year, mo, bd.day);
    }

    const label = target.label[L] || target.label.en;

    // Verified fact line (WOW)
    facts.push(
      L === "fr"
        ? `Fait vérifié : ${label} = ${name || "non déterminé"}${age ? ` (≈ ${age} ans)` : ""}.`
        : `Verified fact: ${label} = ${name || "undetermined"}${age ? ` (≈ ${age} years old)` : ""}.`
    );

    // Corrections / contradictions:
    // If user says "woman 20 years old" etc., we can't infer gender reliably from Bing snippet,
    // so we correct using name + age if we have it, and we flag mismatch if age is far off.
    if (claimedAge != null && age != null) {
      const diff = Math.abs(claimedAge - age);
      if (diff >= 8) {
        contradictions.push(
          L === "fr"
            ? `Âge incohérent : tu dis ${claimedAge} ans, les sources publiques indiquent ≈ ${age} ans.`
            : `Age mismatch: you claim ${claimedAge}, public sources indicate ≈ ${age}.`
        );
      }
    }

    // If the text doesn't mention the real name, it's likely contradicting the "who" claim.
    if (name) {
      const userMentionsName = t.toLowerCase().includes(name.toLowerCase());
      if (!userMentionsName) {
        corrections.push(
          L === "fr"
            ? `Correction : ${label} est ${name}${age ? ` (≈ ${age} ans)` : ""}.`
            : `Correction: ${label} is ${name}${age ? ` (≈ ${age} years old)` : ""}.`
        );
      }
    }

    // Sources stance:
    // If we have corrections/contradictions, treat as "contradict" for the user's claim.
    const stance = (corrections.length || contradictions.length) ? "contradict" : "corroborate";

    sources.push({
      title: best.title,
      url: best.url,
      domain: best.domain,
      stance,
      credibility: best.credibility || 0.8,
      snippet: best.snippet,
    });
  }

  return { facts, corrections, contradictions, sources: normalizeSources(sources) };
}

// -------------------- SCORING (Standard + PRO WOW) --------------------
function computeStandardScore({ text, lang }) {
  const t = safeStr(text);

  if (t.length < 80) {
    return {
      score: 45,
      riskLevel: "high",
      summary:
        lang === "fr"
          ? "Texte trop court : pas assez de contexte pour analyser correctement."
          : "Text too short: not enough context to analyze properly.",
      reasons: [
        lang === "fr" ? "Contexte insuffisant" : "Low context",
        lang === "fr" ? "Détails vérifiables limités" : "Limited verifiable details",
      ],
      confidence: 0.55,
      sources: [],
      sourcesBuckets: bucketSources([]),
      keyPoints: {
        confirmed: 0,
        uncertain: 0,
        contradicted: 0,
        limited: true,
      },
      verifiedFacts: [],
      corrections: [],
      meta: { webUsed: false },
    };
  }

  // Medium conservative baseline
  const score = 70;
  return {
    score,
    riskLevel: scoreToRisk(score),
    summary:
      lang === "fr"
        ? "Analyse standard : résultat prudent (preuves externes limitées)."
        : "Standard analysis: cautious result (limited external evidence).",
    reasons: [
      lang === "fr" ? "Analyse prudente" : "Cautious analysis",
      lang === "fr" ? "Preuves externes non garanties" : "External evidence not guaranteed",
    ],
    confidence: 0.62,
    sources: [],
    sourcesBuckets: bucketSources([]),
    keyPoints: {
      confirmed: 0,
      uncertain: 0,
      contradicted: 0,
      limited: true,
    },
    verifiedFacts: [],
    corrections: [],
    meta: { webUsed: false },
  };
}

function computeProScoreBase({ text, claims, evidenceItems, lang }) {
  const t = safeStr(text);

  let score = 80;          // PRO baseline higher
  let confidence = 0.82;   // PRO baseline higher
  const reasons = [];

  const items = Array.isArray(evidenceItems) ? evidenceItems : [];
  const credibleCount = items.filter((s) => (s.credibility || 0) >= 0.75).length;

  if (items.length === 0) {
    score -= 18;
    confidence -= 0.22;
    reasons.push(
      lang === "fr"
        ? "Peu de preuves web solides trouvées (ou web désactivé)."
        : "Few strong web proofs found (or web disabled)."
    );
  } else if (credibleCount >= 2) {
    score += 8;
    confidence += 0.06;
    reasons.push(
      lang === "fr"
        ? "Plusieurs sources crédibles appuient ou cadrent le contexte."
        : "Multiple credible sources support or frame the context."
    );
  } else {
    score -= 6;
    reasons.push(
      lang === "fr"
        ? "Sources trouvées, mais crédibilité mitigée."
        : "Sources found, but credibility is mixed."
    );
  }

  // Claim richness (better extraction)
  const claimCount = Array.isArray(claims) ? claims.length : 0;
  if (claimCount <= 1 && t.length < 140) {
    score -= 12;
    confidence -= 0.12;
    reasons.push(
      lang === "fr"
        ? "Énoncé trop court / trop vague : vérification robuste limitée."
        : "Too short / too vague: robust verification is limited."
    );
  } else {
    reasons.push(
      lang === "fr"
        ? "Affirmations détectées et structurées pour vérification."
        : "Claims detected and structured for verification."
    );
  }

  score = clamp(score, 5, 98);
  confidence = clamp(confidence, 0.35, 0.95);

  return {
    score,
    riskLevel: scoreToRisk(score),
    summary:
      lang === "fr"
        ? "Analyse PRO : synthèse basée sur signaux + preuves web."
        : "PRO analysis: synthesis based on signals + web evidence.",
    reasons,
    confidence,
    sources: normalizeSources(items),
    meta: { webUsed: items.length > 0 },
  };
}

function buildKeyPointsFromBuckets(buckets, hasContradiction) {
  // IMPORTANT:
  // - "INCERTAIN" must NEVER be used as a fallback when there are ZERO sources.
  // - If no sources were found/returned, UI must show 0/0/0 and label it as "vérification limitée".
  const b = buckets || { corroborate: [], contradict: [], neutral: [] };
  const total =
    (b.corroborate || []).length + (b.contradict || []).length + (b.neutral || []).length;

  if (total === 0) {
    return { confirmed: 0, uncertain: 0, contradicted: 0, limited: true };
  }

  // If we have sources, we can show a simple signal:
  const confirmed = (b.corroborate || []).length ? 1 : 0;
  const contradicted = hasContradiction || (b.contradict || []).length ? 1 : 0;
  const uncertain = contradicted || confirmed ? 0 : 1;

  return { confirmed, uncertain, contradicted, limited: false };
}


// -------------------- ROUTES --------------------
app.get("/", (req, res) => {
  res.json({
    status: "ready",
    message: "Use POST /v1/analyze with x-ia11-key header",
    engine: ENGINE_NAME,
    webEvidenceProvider: (SEARCH_PROVIDER === "serper" && SERPER_API_KEY) ? "serper" : (SEARCH_PROVIDER === "bing" && BING_API_KEY) ? "bing" : "none",
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "IA11 engine running",
    engine: ENGINE_NAME,
    version: VERSION,
    webEvidenceProvider: (SEARCH_PROVIDER === "serper" && SERPER_API_KEY) ? "serper" : (SEARCH_PROVIDER === "bing" && BING_API_KEY) ? "bing" : "none",
  });
});

app.post("/v1/analyze", async (req, res) => {
  const started = nowMs();
  const requestId = makeId();

  // Auth
  const key = safeStr(req.headers["x-ia11-key"]);
  if (!IA11_API_KEY || key !== IA11_API_KEY) {
    return res.status(401).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: "unknown",
      result: {
        score: 0,
        riskLevel: "high",
        summary: "Unauthorized",
        reasons: ["Missing or invalid x-ia11-key"],
        confidence: 0.2,
        sources: [],
        sourcesBuckets: bucketSources([]),
        keyPoints: { confirmed: 0, uncertain: 0, contradicted: 0, limited: true },
        verifiedFacts: [],
        corrections: [],
      },
      meta: { tookMs: nowMs() - started, version: VERSION },
    });
  }

  const isPro = isProUser(req);
  const rl = rateLimit(req, isPro);
  if (!rl.ok) {
    return res.status(429).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: isPro ? "pro" : "standard",
      result: {
        score: 0,
        riskLevel: "high",
        summary: "Rate limited",
        reasons: ["Too many requests"],
        confidence: 0.2,
        sources: [],
        sourcesBuckets: bucketSources([]),
        keyPoints: { confirmed: 0, uncertain: 0, contradicted: 0, limited: true },
        verifiedFacts: [],
        corrections: [],
      },
      meta: {
        tookMs: nowMs() - started,
        version: VERSION,
        retryAfterMs: rl.retryAfterMs,
      },
    });
  }

  const text = safeStr(req.body?.text).trim();
  // --- WEB SEARCH (SERPER or BING) ---
  let sources = [];
  try {
    if (text) {
      if (SEARCH_PROVIDER === "serper" && SERPER_API_KEY) {
        const response = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: text, num: 5 }),
        });
        const data = await response.json();
        if (Array.isArray(data?.organic)) {
          sources = data.organic.slice(0, 5).map((r) => ({
            title: r.title,
            link: r.link,
            snippet: r.snippet,
          }));
        }
      } else if (SEARCH_PROVIDER === "bing" && BING_API_KEY) {
        const url = `${BING_ENDPOINT}?q=${encodeURIComponent(text)}&count=5&mkt=en-US&safeSearch=Moderate`; 
        const response = await fetch(url, {
          headers: {
            "Ocp-Apim-Subscription-Key": BING_API_KEY,
          },
        });
        const data = await response.json();
        const items = data?.webPages?.value;
        if (Array.isArray(items)) {
          sources = items.slice(0, 5).map((r) => ({
            title: r.name,
            link: r.url,
            snippet: r.snippet,
          }));
        }
      }
    }
  } catch (err) {
    console.error("Web search failed", err);
    sources = [];
  }

  const mode =
    safeStr(req.body?.mode).toLowerCase() || (isPro ? "pro" : "standard");
  const forcedLang = safeStr(req.body?.uiLanguage || req.body?.lang || req.body?.language).trim().toLowerCase();
  const lang = forcedLang === "fr" || forcedLang === "en" ? forcedLang : detectLikelyLang(text);

  if (!text) {
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      result: {
        score: 0,
        riskLevel: "high",
        summary: lang === "fr" ? "Texte manquant" : "Missing text",
        reasons: [lang === "fr" ? "Champ 'text' requis" : "'text' field is required"],
        confidence: 0.2,
        sources: [],
        sourcesBuckets: bucketSources([]),
        keyPoints: { confirmed: 0, uncertain: 0, contradicted: 0, limited: true },
        verifiedFacts: [],
        corrections: [],
      },
      meta: { tookMs: nowMs() - started, version: VERSION },
    });
  }

  try {
    const out = await analyze({ text, mode, lang, requestId });
    return res.json({
      status: "success",
      requestId,
      engine: ENGINE_NAME,
      mode: out.mode,
      result: out.result,
      meta: {
        tookMs: nowMs() - started,
        version: VERSION,
      },
    });
  } catch (e) {
    const msg = safeStr(e?.message) || "Unknown error";
    return res.status(500).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      result: {
        score: 0,
        riskLevel: "high",
        summary: lang === "fr" ? "Erreur serveur" : "Server error",
        reasons: [msg],
        confidence: 0.2,
        sources: [],
        sourcesBuckets: bucketSources([]),
        keyPoints: { confirmed: 0, uncertain: 0, contradicted: 0, limited: true },
        verifiedFacts: [],
        corrections: [],
      },
      meta: { tookMs: nowMs() - started, version: VERSION },
    });
  }
});

// -------------------- CORE ANALYZE --------------------
async function analyze({ text, mode, lang, requestId }) {
  const cleanText = safeStr(text).trim();
  const m = mode === "pro" ? "pro" : "standard";

  const guard = applyCriticalFactsGuard(cleanText, lang);

  // STANDARD
  if (m === "standard") {
    const s = computeStandardScore({ text: cleanText, lang });

    if (guard?.triggered) {
      s.reasons.unshift(
        lang === "fr"
          ? "Garde-fou activé (zone sensible: faits officiels)."
          : "Guardrail triggered (critical facts area)."
      );
      s.confidence = Math.min(s.confidence, 0.6);
      s.score = Math.max(20, s.score - 8);
      s.riskLevel = scoreToRisk(s.score);
    }

    s.sourcesBuckets = bucketSources(s.sources);
    s.keyPoints = buildKeyPointsFromBuckets(s.sourcesBuckets, false);

    return {
      mode: "standard",
      result: {
        score: s.score,
        riskLevel: s.riskLevel,
        statusKey: s.keyPoints?.limited ? "LIMITE" : (s.keyPoints?.contradicted ? "CONTREDIT" : (s.keyPoints?.confirmed ? "CONFIRME" : (s.keyPoints?.uncertain ? "INCERTAIN" : "LIMITE"))),
        statusLabel: lang === "fr"
          ? (s.keyPoints?.limited ? "ÉVALUATION LIMITÉE" : (s.keyPoints?.contradicted ? "CONTREDIT" : (s.keyPoints?.confirmed ? "CONFIRMÉ" : "INCERTAIN")))
          : (s.keyPoints?.limited ? "LIMITED EVALUATION" : (s.keyPoints?.contradicted ? "CONTRADICTED" : (s.keyPoints?.confirmed ? "CONFIRMED" : "UNCERTAIN"))),
        badgeText: lang === "fr"
          ? (s.keyPoints?.limited ? "Vérification limitée disponible" : (s.keyPoints?.contradicted ? "Contredit par des sources fiables" : (s.keyPoints?.confirmed ? "Confirmé par des sources fiables" : "Conclusions contradictoires entre sources")))
          : (s.keyPoints?.limited ? "Limited verification available" : (s.keyPoints?.contradicted ? "Contradicted by reliable sources" : (s.keyPoints?.confirmed ? "Confirmed by reliable sources" : "Conflicting conclusions across sources"))),

        counters: { confirmedCount: s.keyPoints?.confirmed || 0, uncertainCount: s.keyPoints?.uncertain || 0, contradictedCount: s.keyPoints?.contradicted || 0 },
        summary: s.summary,
        reasons: s.reasons.slice(0, 10),
        confidence: s.confidence,
        sources: s.sources,
        sourcesBuckets: s.sourcesBuckets,
        keyPoints: s.keyPoints,
        verifiedFacts: [],
        corrections: [],
        meta: {
          tookMs: 1,
          version: VERSION,
          requestId,
          lang,
        },
      },
    };
  }

  // PRO WOW
  const claims = extractCoreClaims(cleanText);
  const evidence = await buildEvidence(claims, lang);
  const base = computeProScoreBase({
    text: cleanText,
    claims,
    evidenceItems: evidence.items,
    lang,
  });

  // Upgrade #1 + WOW: verified public facts for known public roles (multi-country)
  const publicFacts = await buildPublicFacts(cleanText, lang);

  // Combine sources
  let mergedSources = normalizeSources([...(base.sources || []), ...(publicFacts.sources || [])]);

  // Decide contradiction status
  const hasPublicContradiction =
    (publicFacts.corrections && publicFacts.corrections.length) ||
    (publicFacts.contradictions && publicFacts.contradictions.length);

  // If contradiction found, slam score + produce a "wow" summary
  let score = base.score;
  let confidence = base.confidence;
  let summary = base.summary;
  const reasons = [...(base.reasons || [])];

  if (hasPublicContradiction) {
    score = Math.max(5, score - 38);
    confidence = Math.max(0.45, Math.min(confidence, 0.72));

    const firstFact = (publicFacts.facts || [])[0] || "";
    const firstCorrection = (publicFacts.corrections || [])[0] || "";

    summary =
      lang === "fr"
        ? `Ton énoncé est très probablement faux. ${firstCorrection || firstFact}`
        : `Your statement is very likely false. ${firstCorrection || firstFact}`;

    reasons.unshift(
      lang === "fr"
        ? "Contradiction détectée via sources publiques fiables."
        : "Contradiction detected via reliable public sources."
    );

    for (const note of (publicFacts.contradictions || []).slice(0, 3)) reasons.push(note);
  } else if ((publicFacts.facts || []).length) {
    // If we have facts but not contradiction, it adds trust
    score = Math.min(98, score + 6);
    confidence = Math.min(0.95, confidence + 0.04);
    reasons.unshift(
      lang === "fr"
        ? "Faits publics vérifiés ajoutés (effet PRO)."
        : "Verified public facts added (PRO boost)."
    );

    const firstFact = (publicFacts.facts || [])[0] || "";
    summary =
      lang === "fr"
        ? `${summary} ${firstFact}`
        : `${summary} ${firstFact}`;
  }

  // Guardrail reduces confidence slightly (but doesn't hallucinate)
  if (guard?.triggered) {
    score = Math.max(15, score - 10);
    confidence = Math.min(confidence, 0.62);
    reasons.unshift(
      lang === "fr"
        ? "Garde-fou activé (zone sensible: faits officiels)."
        : "Guardrail triggered (critical official topic)."
    );
  }

  score = clamp(score, 5, 98);
  const riskLevel = scoreToRisk(score);

  // Upgrade #3: sources buckets for UI (CONFIRME / CONTREDIT / NEUTRE)
  const sourcesBuckets = bucketSources(mergedSources);
  const keyPoints = buildKeyPointsFromBuckets(sourcesBuckets, Boolean(hasPublicContradiction));

  // Optional short “articleSummary” for UI
  const articleSummary =
    lang === "fr"
      ? "Analyse PRO: preuves triées + faits publics vérifiés quand applicable."
      : "PRO analysis: bucketed evidence + verified public facts when applicable.";

  return {
    mode: "pro",
    result: {
      score,
      riskLevel,
      statusKey: keyPoints?.limited ? "LIMITE" : (keyPoints?.contradicted ? "CONTREDIT" : (keyPoints?.confirmed ? "CONFIRME" : (keyPoints?.uncertain ? "INCERTAIN" : "LIMITE"))),
      statusLabel: lang === "fr"
        ? (keyPoints?.limited ? "ÉVALUATION LIMITÉE" : (keyPoints?.contradicted ? "CONTREDIT" : (keyPoints?.confirmed ? "CONFIRMÉ" : "INCERTAIN")))
        : (keyPoints?.limited ? "LIMITED EVALUATION" : (keyPoints?.contradicted ? "CONTRADICTED" : (keyPoints?.confirmed ? "CONFIRMED" : "UNCERTAIN"))),
      badgeText: lang === "fr"
        ? (keyPoints?.limited ? "Vérification limitée disponible" : (keyPoints?.contradicted ? "Contredit par des sources fiables" : (keyPoints?.confirmed ? "Confirmé par des sources fiables" : "Conclusions contradictoires entre sources")))
        : (keyPoints?.limited ? "Limited verification available" : (keyPoints?.contradicted ? "Contradicted by reliable sources" : (keyPoints?.confirmed ? "Confirmed by reliable sources" : "Conflicting conclusions across sources"))),

      summary,
      reasons: reasons.slice(0, 12),
      confidence,
      // full list + buckets for easy UI rendering
      sources: mergedSources,
      sourcesBuckets,
      // “Points clés PRO” in your UI
      keyPoints,
      // WOW fields
      verifiedFacts: publicFacts.facts || [],
      corrections: publicFacts.corrections || [],
      meta: {
        tookMs: 1,
        version: VERSION,
        requestId,
        articleSummary,
        lang,
        debug: {
          claimsCount: claims.length,
          webUsed: Boolean(evidence.webUsed),
          publicFactsUsed: Boolean((publicFacts.facts || []).length),
          publicContradiction: Boolean(hasPublicContradiction),
        },
      },
    },
  };
}

// -------------------- START --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`IA11 running on port ${port}`);
});
