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
    const msg = e?.name === "AbortError" ? `timeout after ${HTTP_TIMEOUT_MS}ms` : (e?.message || "unknown error");
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

function getDomain(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Petit classement simple (évite de donner le même poids à un blog random qu’à un site officiel)
function domainReliability(domain) {
  const d = safeLower(domain);

  // Très forts (officiels / institutions)
  if (d.endsWith(".gov") || d.endsWith(".gouv.fr") || d.endsWith(".gc.ca")) return 100;
  if (d.endsWith(".edu")) return 92;

  // Forts (médias reconnus / encyclopédies)
  const strong = [
    "reuters.com",
    "apnews.com",
    "bbc.co.uk",
    "bbc.com",
    "theguardian.com",
    "nytimes.com",
    "washingtonpost.com",
    "cnn.com",
    "cnbc.com",
    "ft.com",
    "wsj.com",
    "economist.com",
    "npr.org",
    "cbc.ca",
    "radio-canada.ca",
    "canada.ca",
    "who.int",
    "un.org",
    "europa.eu",
    "wikipedia.org",
    "britannica.com",
  ];
  if (strong.includes(d)) return 85;

  // OK (sites “normaux”)
  if (d) return 65;

  // Inconnu
  return 50;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const link = normalizeUrl(it.link || it.url || "");
    if (!link) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    out.push(it);
  }
  return out;
}

// ---------------- STANDARD (0 Serper) : brutal, intelligent, honnête ----------------

function hasUserProvidedSources(text) {
  const t = safeLower(text);
  return (
    t.includes("http://") ||
    t.includes("https://") ||
    t.includes("www.") ||
    t.includes("source:") ||
    t.includes("sources:") ||
    t.includes("selon ") ||
    t.includes("according to ")
  );
}

  function looksLikeVerifiableClaim(text) {
  const t = safeLower(text);

  // Indices simples de “fait vérifiable”
  const hasNumbers = /\d/.test(t);
  const hasYear = /\b(19\d{2}|20\d{2})\b/.test(t);

  const highRiskKeywords = [
    // postes / politique
    "président",
    "president",
    "premier ministre",
    "prime minister",
    "pape",
    "pope",
    "élection",
    "election",
    "guerre",
    "war",
    "ministre",
    "minister",
    "gouvernement",
    "government",
    "chef d'état",
    "head of state",
    "maire",
    "mayor",
    "ceo",
    "pdg",

    // faits “durs” fréquents
    "capitale",
    "capital",
    "population",
    "habitants",
    "gdp",
    "pib",
    "superficie",
    "area",
    "date",
    "année",
    "year",
  ];

  const verbFact = [
    "est ",
    "sont ",
    "was ",
    "were ",
    "is ",
    "are ",
    "a été",
    "ont été",
    "depuis",
    "since",
    "in ",
  ];

  const kwHit = highRiskKeywords.some((k) => t.includes(k));
  const verbHit = verbFact.some((v) => t.includes(v));

  // Patterns “capitale / capital of” même sans mots-clés “poste”
  const capitalPattern =
    /\bcapitale\b/.test(t) ||
    /\bcapital\b/.test(t) ||
    /\bcapital\s+of\b/.test(t) ||
    /\bcapitale\s+(du|de la|de l'|des)\b/.test(t);

  // Si c’est court + contient structure factuelle → vérifiable
  if (t.length < 220 && (kwHit || hasNumbers || hasYear || capitalPattern) && verbHit) return true;

  // Même si plus long, si mots “fait dur” + verbes factuels
  if ((kwHit || capitalPattern) && verbHit) return true;

  return false;
}


function computeWritingScore(text) {
  const t = (text || "").trim();
  if (!t) return 0;

  let score = 70;

  const lower = safeLower(t);

  // Pénalités “style manipulation”
  const exclam = (t.match(/!/g) || []).length;
  const allCapsRatio =
    t.length > 30 ? (t.replace(/[^A-Z]/g, "").length / t.length) : 0;

  if (exclam >= 3) score -= 12;
  if (allCapsRatio > 0.25) score -= 15;
  if (lower.includes("100%") || lower.includes("certain") || lower.includes("c'est sûr") || lower.includes("proof")) score -= 8;

  // Bonus “prudence”
  if (lower.includes("il semble") || lower.includes("probablement") || lower.includes("peut-être") || lower.includes("selon") || lower.includes("à ce stade")) score += 6;

  // Pénalité si ultra court
  if (t.length < 20) score -= 12;

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));
  return score;
}

function computeStandard(text, lang) {
  const writingScore = computeWritingScore(text);
  const providedSources = hasUserProvidedSources(text);
  const verifiable = looksLikeVerifiableClaim(text);

  // Risque factuel (wow: clair et assumé)
  let factualRisk = "Low";
  if (verifiable && !providedSources) factualRisk = "High";
  else if (verifiable) factualRisk = "Medium";

  // Score final Standard = brutal si fait vérifiable sans source
  let final = writingScore;

  let cap = 100;
  let capReason = null;

  if (factualRisk === "High") {
    cap = 35;
    capReason = "Verifiable factual claim without any provided source.";
  } else if (factualRisk === "Medium") {
    cap = 55;
    capReason = "Verifiable claim with limited/unclear sourcing.";
  }

  final = Math.min(final, cap);

  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");

  const summary = fr
    ? (factualRisk === "High"
        ? "Affirmation vérifiable sans preuve fournie. Score Standard volontairement sévère."
        : "Analyse Standard : formulation + risque de crédibilité (sans vérification web).")
    : (factualRisk === "High"
        ? "Verifiable claim without proof provided. Standard score is intentionally strict."
        : "Standard analysis: writing + credibility risk (no web verification).");

  return {
    score: final,
    summary,
    standard: {
      writingScore,
      factualRisk: fr ? (factualRisk === "High" ? "Élevé" : factualRisk === "Medium" ? "Moyen" : "Faible") : factualRisk,
      capApplied: cap,
      capReason: capReason
        ? (fr
            ? "Affirmation hautement vérifiable sans source dans le texte. Standard = formulation + risque, pas les faits."
            : "Highly verifiable claim with no source in text. Standard = writing + risk, not factual verification.")
        : null,
    },
    sources: [], // Standard = 0 sources web
  };
}
// ================= STANDARD: Mini "Reality Check" (1 Serper max) =================
// Objectif: éviter qu’une absurdité factuelle ("Le Canada est une ville") sorte crédible en Standard.
// - 1 requête Serper MAX
// - pénalité claire si contradiction évidente
async function runStandardRealityCheck(text, lang) {
  // Si pas de clé Serper, on ne bloque pas le Standard (fallback sans web).
  if (!SERPER_KEY) {
    return { used: false, penalty: 0, note: "no_serper_key", sources: [] };
  }

  const query = buildStandardRealityQuery(text, lang);
  if (!query) return { used: false, penalty: 0, note: "no_query", sources: [] };

  const sr = await serperSearch(query, lang, 5);
  if (!sr.ok) return { used: false, penalty: 0, note: "serper_error", sources: [] };

  const items = (sr.items || []).slice(0, 5);
  const evalOut = evaluateObviousContradiction(text, items, lang);

  const sources = items.slice(0, 3).map((it) => ({
    title: it.title,
    url: it.link,
    domain: getDomain(it.link),
    snippet: it.snippet || "",
  }));

  return {
    used: true,
    penalty: evalOut.penalty,
    verdict: evalOut.verdict,
    note: evalOut.note,
    query,
    sources,
  };
}

function buildStandardRealityQuery(text, lang) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");

  // Sujet (ex: "Canada" dans "Le Canada est ...")
  const subject =
    (t.match(/\b(?:le|la|l')\s*([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'-]{2,})/i) || [])[1] ||
    (t.match(/\b([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'-]{2,})\b/) || [])[1] ||
    "";

  const mentionsCity = /\b(ville|city)\b/i.test(t);
  const mentionsCountry = /\b(pays|country)\b/i.test(t);

  // Requête spéciale pour le cas "X est une ville/pays"
  if (subject && (mentionsCity || mentionsCountry)) {
    if (mentionsCity) {
      return fr
        ? `${subject} est une ville ou un pays`
        : `${subject} is a city or a country`;
    }
    if (mentionsCountry) {
      return fr
        ? `${subject} est un pays ou une ville`
        : `${subject} is a country or a city`;
    }
  }

  // Fallback: on garde la phrase courte + intention "définition"
  const short = t.length > 140 ? t.slice(0, 140) : t;
  return fr ? `${short} définition` : `${short} definition`;
}

function evaluateObviousContradiction(text, items, lang) {
  const t = (text || "").toLowerCase();

  const claimCity = /\b(ville|city)\b/.test(t);
  const claimCountry = /\b(pays|country)\b/.test(t);

  // On lit titre + snippet des 3 premiers résultats
  const top = (items || []).slice(0, 3).map((it) => `${it.title || ""} ${it.snippet || ""}`.toLowerCase()).join(" ");

  const evidenceCity = /\b(ville|city|municipality|town)\b/.test(top);
  const evidenceCountry = /\b(pays|country|sovereign|nation)\b/.test(top);

  // Pénalité "contradiction évidente"
  if (claimCity && evidenceCountry && !evidenceCity) {
    return {
      verdict: "contradiction",
      penalty: 28,
      note: "Claim says CITY, top sources describe COUNTRY.",
    };
  }

  if (claimCountry && evidenceCity && !evidenceCountry) {
    return {
      verdict: "contradiction",
      penalty: 28,
      note: "Claim says COUNTRY, top sources describe CITY.",
    };
  }

  // Sinon: petite pénalité si c’est une affirmation vérifiable (sans aller trop loin)
  const verifiable = looksLikeVerifiableClaim(text);
  if (verifiable) {
    return { verdict: "uncertain", penalty: 6, note: "Verifiable claim: light risk penalty (Standard)." };
  }

  return { verdict: "none", penalty: 0, note: "No obvious contradiction detected." };
}

// ---------------- PRO (1 à 3 Serper max) : dictature de la preuve + sources cliquables ----------------

// Mini cache mémoire (évite de payer Serper 20 fois pour la même intention)
// SAFE SWITCH:
// - off   => cache exact seulement (comme avant)
// - on    => Option C (sens + garde-fous + mini-Serper si borderline)
// - debug => Option C + logs clairs
const SIM_CACHE_MODE = (process.env.SIM_CACHE_MODE || process.env.IA11_CACHE_MODE || "on").toLowerCase();

// Niveau 1: cache exact (clé normalisée)
// Niveau 2: cache "similarité" (même sens + garde-fous)
const PRO_CACHE = new Map(); // key -> { expiresAt, payload, profile, createdAt }
const PRO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Pour éviter de scanner un cache infini (RAM), on limite les comparaisons
const PRO_CACHE_MAX_SCAN = 1500;

// Stopwords simples (FR/EN) pour extraire le "sujet"
const STOP_FR = new Set([
  "le","la","les","un","une","des","du","de","d","au","aux","a","à","en","dans","sur","sous","chez",
  "et","ou","mais","donc","or","ni","car","que","qui","quoi","dont","où",
  "est","sont","été","etre","être","avait","ont","avoir",
  "ce","cet","cette","ces","cela","ça","se","sa","son","ses","leur","leurs","mon","ma","mes","ton","ta","tes","nos","vos",
  "plus","moins","tres","très","pas","ne","non","oui",
  "il","elle","ils","elles","on","nous","vous","tu","je","j",
  "aujourd","hui","hier","demain"
]);

const STOP_EN = new Set([
  "the","a","an","and","or","but","so","because","of","to","in","on","at","by","for","with","from","as",
  "is","are","was","were","be","been","being","have","has","had",
  "this","that","these","those","it","its","they","them","we","you","i",
  "not","no","yes","very","more","less","than"
]);

// Mini table de synonymes (juste pour capturer les cas fréquents, pas pour être parfait)
function synonymMapToken(tok, lang) {
  const t = tok;
  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");

  // === Ultra Pro: synonymes "sens" (FR/EN) ===
  // Ville
  if (t === "city" || t === "town") return "ville";
  if (t === "ville") return "ville";

  // Pays
  if (t === "country") return "pays";
  if (t === "pays") return "pays";

  // États-Unis / USA
  if (t === "united" || t === "states" || t === "america" || t === "american") return "usa";
  if (t === "etats" || t === "etat" || t === "unis" || t === "américains" || t === "americains") return "usa";
  if (t === "états" || t === "état") return "usa";

  // Nord (petit bonus utile)
  if (t === "above" || t === "over") return "north";
  if (t === "north" || t === "northern") return "north";
  if (t === "au-dessus" || t === "dessus") return "nord";
  if (t === "nord" || t === "nordest" || t === "nord-ouest") return "nord";

  // Amérique
  if (t === "amérique" || t === "amerique") return "amerique";

  return t;
}


function purgeExpiredProCache() {
  const now = Date.now();
  for (const [k, v] of PRO_CACHE.entries()) {
    if (!v || now > v.expiresAt) PRO_CACHE.delete(k);
  }
}

function cacheGet(key) {
  const v = PRO_CACHE.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    PRO_CACHE.delete(key);
    return null;
  }
  return v.payload;
}

// profile optionnel: { tokens:Set<string>, topicKey:string }
function cacheSet(key, payload, profile) {
  PRO_CACHE.set(key, {
    expiresAt: Date.now() + PRO_CACHE_TTL_MS,
    createdAt: Date.now(),
    payload,
    profile: profile || null,
  });
}

function normalizeClaimForCache(text, lang) {
  // Niveau 1 (exact): clé stable, robuste aux ponctuations/espaces
  const t = safeLower(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // enlève accents
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .slice(0, 220);

  return `${(lang || "en").toLowerCase()}::${t}`;
}

function buildProSimilarityProfile(text, lang) {
  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");
  // Stopwords combinés + mots génériques fréquents qui polluent la similarité
  const stop = new Set([
    ...STOP_FR,
    ...STOP_EN,

  // bruit générique
  "est", "des", "plus",
  "situe", "situé", "situer",
  "america", "amerique", "amérique",

  // adjectifs “décoratifs” qui ne doivent pas coûter des crédits Serper
  // FR
  "gros","grosse","grand","grande","petit","petite",
  "enorme","énorme","immense","gigantesque",
  "grosser","petiter", // au cas où (fautes)
  "grands","grandes","petits","petites","grosses",

  // EN
  "big","small","large","huge","tiny","massive","giant"
]);



  const cleaned = safeLower(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);

  const rawTokens = cleaned.split(" ").filter(Boolean);

  const tokens = new Set();
  for (let tok of rawTokens) {
    if (!tok) continue;
    if (tok.length <= 2) continue;
    if (stop.has(tok)) continue;
    tok = synonymMapToken(tok, lang);
    if (!tok || tok.length <= 2) continue;
    if (stop.has(tok)) continue;
    tokens.add(tok);
  }

  // Sujet (garde-fou): top 4 tokens triés
  // TopicKey "ancré" pour stabiliser les reformulations (Canada / USA)
const anchors = ["canada", "usa", "etats", "unis", "états", "united", "states"];
const anchorHits = anchors.filter(a => tokens.has(a));

const topicKey = (anchorHits.length >= 2)
  ? anchorHits.slice(0, 2).sort().join("|")
  : Array.from(tokens).sort().slice(0, 2).join("|");


  return { tokens, topicKey };
}

function jaccardSimilarity(aSet, bSet) {
  if (!aSet || !bSet) return 0;
  const a = aSet.size;
  const b = bSet.size;
  if (a === 0 || b === 0) return 0;

  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;

  const union = a + b - inter;
  const base = union <= 0 ? 0 : inter / union;

  // Ultra Pro boost: si le "noyau" (top tokens) est identique, on pousse le score
  const coreA = Array.from(aSet).sort().slice(0, 2).join("|");
  const coreB = Array.from(bSet).sort().slice(0, 2).join("|");
  if (coreA && coreA === coreB) return Math.min(1, base + 0.25);

  return base;
}

// Option C: sens + garde-fous + mini-Serper si borderline
// Option C: sens + garde-fous + mini-Serper si borderline
function proCacheLookupBySimilarity(claim, lang, exactKey, profile) {
  purgeExpiredProCache();

  // 1) exact cache
  const exactPayload = cacheGet(exactKey);
  if (exactPayload) {
    return { hit: true, tier: "exact", payload: exactPayload, matchedKey: exactKey, score: 1 };
  }

  // SAFE: mode OFF => on ne fait PAS de similarité
  if (SIM_CACHE_MODE === "off") return { hit: false };

  // 2) similarité
  let best = null;
  let scanned = 0;

  for (const [k, entry] of PRO_CACHE.entries()) {
    if (!entry || !entry.payload) continue;
    if (!entry.profile || !entry.profile.tokens) continue;

    scanned++;
    if (scanned > PRO_CACHE_MAX_SCAN) break;

    // Garde-fou sujet: topicKey identique (évite les faux matchs)
    if (profile.topicKey && entry.profile.topicKey && profile.topicKey !== entry.profile.topicKey) continue;

    const sim = jaccardSimilarity(profile.tokens, entry.profile.tokens);
    if (!best || sim > best.score) best = { key: k, score: sim, payload: entry.payload };
  }

  if (!best) return { hit: false };

    const HIGH = SIMILARITY_STRICT_MODE ? 0.80 : 0.74; // plus strict = moins de faux "cache hit"
    const MID  = SIMILARITY_STRICT_MODE ? 0.68 : 0.60; // borderline plus rare


  if (best.score >= HIGH) {
    return { hit: true, tier: "similar", payload: best.payload, matchedKey: best.key, score: best.score };
  }

  if (best.score >= MID) {
    return { hit: true, tier: "borderline", payload: best.payload, matchedKey: best.key, score: best.score };
  }

  return { hit: false };
}

function extractMainClaim(text) {
  const t = (text || "").trim();
  if (!t) return "";
  // prend la 1re phrase courte (sinon début)
  const parts = t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
  return (parts[0] || t).trim().slice(0, 240);
}

  function stanceFromText(snippetOrTitle) {
  // Fallback (quand on ne peut pas comparer au claim)
  const s = safeLower(snippetOrTitle);

  const refuteWords = [
    "false", "debunk", "hoax", "myth", "not true", "refuted", "misleading", "fake",
    "faux", "canular", "démenti", "dementi", "trompeur", "incorrect", "inexact"
  ];

  const supportWords = [
    "confirmed", "official", "announced", "statement", "report", "according to",
    "communiqué", "communique", "déclare", "declare", "rapport", "evidence", "verified"
  ];

  let refute = 0;
  let support = 0;

  for (const w of refuteWords) if (s.includes(w)) refute++;
  for (const w of supportWords) if (s.includes(w)) support++;

  if (refute > support) return "refute";
  if (support > refute) return "support";
  return "unknown";
}

function stripDiacritics(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normText(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEntityName(s) {
  return normText(s)
    .replace(/\b(the|a|an|la|le|les|l|de|du|des|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSetFromText(s) {
  const toks = normText(s).split(" ").filter((t) => t.length >= 3);
  return new Set(toks);
}

function overlapCount(setA, setB) {
  let c = 0;
  for (const t of setA) if (setB.has(t)) c++;
  return c;
}

// Détecte une claim de type “X est la capitale du/de Y” ou “X is the capital of Y”
function extractCapitalClaimParts(claim) {
  const raw = (claim || "").trim();
  if (!raw) return null;

  // FR
  const fr = raw.match(/^(.*?)\s+(est|serait)\s+(la\s+)?capitale\s+(du|de la|de l'|des)\s+(.*)$/i);
  if (fr) {
    const city = fr[1].trim();
    const country = fr[5].trim();
    if (city && country) return { city, country, lang: "fr" };
  }

  // EN
  const en = raw.match(/^(.*?)\s+(is|was|would be)\s+(the\s+)?capital\s+of\s+(.*)$/i);
  if (en) {
    const city = en[1].trim();
    const country = en[4].trim();
    if (city && country) return { city, country, lang: "en" };
  }

  return null;
}

// Extrait “la capitale de X est Y” / “capital of X is Y”
function extractCapitalFromSnippet(snippet) {
  const s = (snippet || "").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // EN: "The capital of Canada is Ottawa"
  let m = s.match(/capital\s+of\s+([^.,;:()\n]+?)\s+(is|was)\s+([^.,;:()\n]+)/i);
  if (m) return { country: m[1].trim(), capital: m[3].trim() };

  // EN: "Ottawa is the capital of Canada"
  m = s.match(/([^.,;:()\n]+?)\s+(is|was)\s+(the\s+)?capital\s+of\s+([^.,;:()\n]+)/i);
  if (m) return { capital: m[1].trim(), country: m[4].trim() };

  // FR: "La capitale du Canada est Ottawa"
  m = s.match(/capitale\s+(du|de la|de l'|des)\s+([^.,;:()\n]+?)\s+est\s+([^.,;:()\n]+)/i);
  if (m) return { country: m[2].trim(), capital: m[3].trim() };

  // FR: "Ottawa est la capitale du Canada"
  m = s.match(/([^.,;:()\n]+?)\s+est\s+(la\s+)?capitale\s+(du|de la|de l'|des)\s+([^.,;:()\n]+)/i);
  if (m) return { capital: m[1].trim(), country: m[5].trim() };

  return null;
}

/**
 * Compare un résultat web au claim.
 * Retourne un stance *contre le claim*, pas juste “mots positifs/négatifs”.
 */
function classifyItemAgainstClaim(claim, title, snippet, lang) {
  const combined = `${title || ""} ${snippet || ""}`.trim();

  const claimTokens = tokenSetFromText(claim);
  const itemTokens = tokenSetFromText(combined);

  const ov = overlapCount(claimTokens, itemTokens);

  // Relevance simple (0..100)
  let relevance = 25;
  if (ov >= 6) relevance = 95;
  else if (ov >= 4) relevance = 80;
  else if (ov >= 2) relevance = 60;
  else if (ov >= 1) relevance = 45;

  // 1) Cas capital/capitale (critique)
  const cap = extractCapitalClaimParts(claim);
  if (cap) {
    const found = extractCapitalFromSnippet(combined);
    if (found) {
      const claimCity = normalizeEntityName(cap.city);
      const foundCapital = normalizeEntityName(found.capital);
      const claimCountry = normalizeEntityName(cap.country);
      const foundCountry = normalizeEntityName(found.country || "");

      const countryLooksSame =
        !!claimCountry &&
        !!foundCountry &&
        (foundCountry.includes(claimCountry) || claimCountry.includes(foundCountry) || overlapCount(tokenSetFromText(claimCountry), tokenSetFromText(foundCountry)) >= 1);

      if (countryLooksSame) {
        if (foundCapital && claimCity && foundCapital !== claimCity) {
          return { stance: "refute", relevance: 95, strength: 95, reason: "capital_mismatch", extracted: { capital: found.capital, country: found.country } };
        }
        if (foundCapital && claimCity && foundCapital === claimCity) {
          return { stance: "support", relevance: 95, strength: 90, reason: "capital_match", extracted: { capital: found.capital, country: found.country } };
        }
      }
    }

    return { stance: "unknown", relevance: Math.max(relevance, 55), strength: 0, reason: "capital_unresolved", extracted: null };
  }

  // 2) Fallback: seulement si pertinent
  const fallback = stanceFromText(combined);
  if (relevance >= 60) return { stance: fallback, relevance, strength: fallback === "unknown" ? 0 : 55, reason: "fallback_keywords", extracted: null };

  return { stance: "unknown", relevance, strength: 0, reason: "low_relevance", extracted: null };
}


// Requêtes PRO: max 3, ultra ciblées
function buildProQueries(claim, lang) {
  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");
  const c = (claim || "").trim();
  const lower = safeLower(c);

  const queries = [];

  // 1) La claim brute (toujours)
  if (c) queries.push(c);

  // 2) Si ça ressemble à un poste officiel → requête “current + poste”
  const looksOfficial =
    lower.includes("président") ||
    lower.includes("president") ||
    lower.includes("prime minister") ||
    lower.includes("premier ministre") ||
    lower.includes("pape") ||
    lower.includes("pope");

  if (looksOfficial) {
    queries.push(fr ? `président actuel ${c}` : `current ${c}`);
  } else {
    // sinon fact-check simple
    queries.push(fr ? `${c} vérification des faits` : `${c} fact check`);
  }

  // 3) Requête “official source” (seulement si pro et claim pas trop longue)
  if (c && c.length < 160) {
    queries.push(fr ? `${c} source officielle` : `${c} official source`);
  }

  return queries.slice(0, 3);
}

function scoreEvidenceBrutal(enrichedItems, verifiable) {
  const list = enrichedItems || [];
  if (list.length === 0) {
    return {
      evidenceScore: verifiable ? 40 : 45,
      confidence: 20,
      hasContradictions: false,
      strongRefute: false,
      strongSupport: false,
      notes: ["no_sources"],
    };
  }

  const domains = new Set();

  let relSum = 0;
  let relvSum = 0;

  // Poids “contre le claim”
  let supportW = 0;
  let refuteW = 0;

  let support = 0;
  let refute = 0;
  let unknown = 0;

  for (const it of list) {
    const rel = it.reliability || 50;
    const relv = typeof it.relevance === "number" ? it.relevance : 50;

    relSum += rel;
    relvSum += relv;
    if (it.domain) domains.add(it.domain);

    const stance = it.stance || "unknown";
    if (stance === "support") support++;
    else if (stance === "refute") refute++;
    else unknown++;

    // Poids: qualité * pertinence (0..1.0)
    const w = (Math.max(0, Math.min(100, rel)) / 100) * (Math.max(0, Math.min(100, relv)) / 100);

    if (stance === "support") supportW += w;
    else if (stance === "refute") refuteW += w;
  }

  const avgRel = relSum / Math.max(1, list.length);
  const avgRelevance = relvSum / Math.max(1, list.length);
  const diversity = domains.size;

  const hasContradictions = supportW > 0.3 && refuteW > 0.3;

  // “Forte” = poids largement dominant + un minimum de qualité/pertinence
  const strongRefute =
    refuteW >= Math.max(0.9, supportW * 2.0) && avgRel >= 65 && avgRelevance >= 55;

  const strongSupport =
    supportW >= Math.max(0.9, refuteW * 2.0) && avgRel >= 65 && avgRelevance >= 55;

  // Base
  let evidenceScore = 50;

  // 1) Pertinence d'abord
  if (avgRelevance >= 80) evidenceScore += 10;
  else if (avgRelevance >= 60) evidenceScore += 6;
  else evidenceScore -= 8;

  // 2) Qualité (mais pas “cadeau”)
  if (avgRel >= 85) evidenceScore += 10;
  else if (avgRel >= 70) evidenceScore += 6;
  else evidenceScore += 2;

  // 3) Diversité (petit bonus)
  if (diversity >= 5) evidenceScore += 6;
  else if (diversity >= 3) evidenceScore += 4;
  else if (diversity >= 2) evidenceScore += 2;

  // 4) Direction (support vs refute)
  const diff = supportW - refuteW;
  evidenceScore += Math.round(diff * 25);

  // Contradictions
  if (hasContradictions) evidenceScore -= 8;

  // Verdict brutal
  if (strongRefute) evidenceScore = Math.min(evidenceScore, 12);
  if (strongSupport) evidenceScore = Math.max(evidenceScore, 82);

  const notes = [];
  if (hasContradictions) notes.push("mixed_signals");
  if (strongRefute) notes.push("strong_refutation");
  if (strongSupport) notes.push("strong_corroboration");
  if (avgRel >= 85) notes.push("high_quality_sources");
  if (avgRelevance < 50) notes.push("low_relevance");

  // Si vérifiable MAIS pas de verdict clair → prudence (retour “comme avant”)
  if (verifiable && !strongSupport && !strongRefute) {
    notes.push("no_clear_verdict");
    evidenceScore = Math.min(evidenceScore, 55);
  }

  evidenceScore = Math.max(0, Math.min(100, Math.round(evidenceScore)));

  // Confiance
  let confidence = 35;
  confidence += Math.round((avgRel - 50) * 0.5);
  confidence += Math.round((avgRelevance - 50) * 0.4);
  confidence += Math.min(18, diversity * 3);
  if (hasContradictions) confidence -= 10;
  if (strongRefute || strongSupport) confidence += 10;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  return { evidenceScore, confidence, hasContradictions, strongRefute, strongSupport, notes };
}

async function runProEvidence(text, lang) {
    // Le claim (le coeur du fact-check)
  const claim = extractMainClaim(text);

  // Verifiable = on doit être strict (capitale, dates, chiffres, etc.)
  const verifiable = looksLikeVerifiableClaim(claim || text);

  // Cache basé sur le claim (pas sur le texte complet)
  const rawForCache = (claim || text || "").slice(0, 500);
  const cacheKey = normalizeClaimForCache(rawForCache, lang);
  const profile = buildProSimilarityProfile(rawForCache, lang);


  // 1) lookup cache (exact -> similar -> borderline)
  const hit = proCacheLookupBySimilarity(claim, lang, cacheKey, profile);

  // DEBUG: voir ce que IA11 “pense”
  if (SIM_CACHE_MODE === "debug") {
    console.log("🧠 SIM_CACHE_MODE:", SIM_CACHE_MODE, "topicKey:", profile.topicKey, "tokens:", Array.from(profile.tokens).slice(0, 12));
    console.log("🧠 CACHE LOOKUP:", hit);
  }

  // HIT exact / similar: 0$ Serper
  if (hit && hit.hit && (hit.tier === "exact" || hit.tier === "similar")) {
    // Bonus: alias la nouvelle formulation vers le même payload
    if (hit.tier === "similar") {
      cacheSet(cacheKey, hit.payload, profile);
    }

    if (SIM_CACHE_MODE === "debug") {
      console.log("🧠 CACHE HIT:", { tier: hit.tier, score: hit.score, matchedKey: hit.matchedKey });
    }

    return {
      ...hit.payload,
      fromCache: true,
      cacheHit: { tier: hit.tier, score: hit.score, matchedKey: hit.matchedKey },
    };
  }

  // HIT borderline: mini-Serper (moins de résultats) pour sécuriser la crédibilité
  const isBorderline = !!(hit && hit.hit && hit.tier === "borderline");

  const queries = buildProQueries(claim, lang);

  let allItems = [];
  let okCount = 0;
  let lastError = null;

  // SAFE: si OFF, on force le comportement “normal” (3 requêtes / 5 résultats)
  const baseMax = Math.max(1, Math.min(8, MAX_SERPER_QUERIES_ENV || 4));
  const maxQueries = (SIM_CACHE_MODE === "off") ? 3 : (isBorderline ? 1 : baseMax);
  const numPerQuery = (SIM_CACHE_MODE === "off") ? 5 : (isBorderline ? 3 : 5);


  if (SIM_CACHE_MODE === "debug") {
    console.log("🧠 SERPER PLAN:", { isBorderline, maxQueries, numPerQuery, queriesPreview: queries.slice(0, 3) });
  }

  for (let i = 0; i < Math.min(maxQueries, queries.length); i++) {
    const q = queries[i];

    try {
      const out = await serperSearch(q, lang, numPerQuery);
      if (out.ok) {
        okCount++;
        allItems = allItems.concat(out.items || []);
      } else {
        lastError = out.error || lastError;
      }
    } catch (e) {
      lastError = e?.message || lastError;
    }

    // Stop early: si on a déjà 8 items dédupliqués, c’est suffisant pour un verdict pro
    const fastDedup = dedupeItems(allItems);
    if (SIM_CACHE_MODE !== "off" && !isBorderline && fastDedup.length >= 8) break;
  }

     const deduped = dedupeItems(allItems).slice(0, 10);
  const enriched = deduped.map((it) => {
    const link = it.link || it.url || "";
    const domain = getDomain(link);
    const title = it.title || "";
    const snippet = it.snippet || it.description || "";
    const reliability = domainReliability(domain);

    const cls = classifyItemAgainstClaim(claim, title, snippet, lang);

    return {
      title,
      url: link,
      link, // compat
      snippet,
      domain,
      reliability,
      stance: cls.stance,
      relevance: cls.relevance,
      strength: cls.strength,
      stanceReason: cls.reason,
      extracted: cls.extracted || null,
    };
  });


  // Buckets (wow)
  const buckets = { corroborates: [], contradicts: [], neutral: [] };
  for (const it of enriched) {
    if (it.stance === "support") buckets.corroborates.push(it);
    else if (it.stance === "refute") buckets.contradicts.push(it);
    else buckets.neutral.push(it);
  }

   
    const evidence = scoreEvidenceBrutal(enriched, verifiable);
    


  const payload = {
    ok: okCount > 0,
    claim,
    queriesUsed: queries,
    items: enriched,
    buckets,
    evidence,
    error: okCount > 0 ? null : lastError || "Unknown search error",
  };

  // Si borderline et Serper n'a rien donné: fallback prudent sur le cache similaire
  if (SIM_CACHE_MODE !== "off" && isBorderline && okCount === 0 && hit && hit.payload) {
    const fallback = {
      ...hit.payload,
      ok: hit.payload.ok || false,
      fromCache: true,
      cacheHit: { tier: "borderline-fallback", score: hit.score, matchedKey: hit.matchedKey },
      note: (lang || "en").toLowerCase().startsWith("fr")
        ? "Mini-recherche web indisponible; réutilisation prudente d’un résultat similaire en cache."
        : "Mini web search unavailable; cautiously reusing a similar cached result.",
    };

    cacheSet(cacheKey, fallback, profile);

    if (SIM_CACHE_MODE === "debug") {
      console.log("🧠 BORDERLINE FALLBACK USED");
    }

    return { ...fallback, fromCache: true };
  }

  cacheSet(cacheKey, payload, profile);

  if (SIM_CACHE_MODE === "debug") {
    console.log("🧠 CACHE STORE:", { cacheKey, topicKey: profile.topicKey, okCount, isBorderline });
  }

  return {
    ...payload,
    fromCache: false,
    cacheHit: (SIM_CACHE_MODE === "off")
      ? null
      : (isBorderline ? { tier: "borderline-mini", score: hit.score, matchedKey: hit.matchedKey } : null)
  };
}

function computeProFinalScore(text, lang, writingScore, evidenceScore, strongRefute, verifiable) {
  // Score PRO = 80% preuve + 20% écriture (ultra logique)
  let pro = Math.round(0.2 * writingScore + 0.8 * evidenceScore);

  // Règle anti-absurde : si forte contradiction, ça ne monte JAMAIS
  if (strongRefute) pro = Math.min(pro, 15);

  // Si c’est non vérifiable (opinion), on évite de “punir” trop fort
  if (!verifiable && pro < 35) pro = 35;

  // Clamp
  pro = Math.max(0, Math.min(100, pro));
  return pro;
}

function labelFromScore(lang, score) {
  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");

  if (fr) {
    if (score >= 80) return "HAUTE CRÉDIBILITÉ";
    if (score >= 65) return "BONNE CRÉDIBILITÉ";
    if (score >= 50) return "CRÉDIBILITÉ MODÉRÉE";
    if (score >= 30) return "FAIBLE CRÉDIBILITÉ";
    return "TRÈS FAIBLE CRÉDIBILITÉ";
  } else {
    if (score >= 80) return "HIGH CREDIBILITY";
    if (score >= 65) return "GOOD CREDIBILITY";
    if (score >= 50) return "MODERATE CREDIBILITY";
    if (score >= 30) return "LOW CREDIBILITY";
    return "VERY LOW CREDIBILITY";
  }
}

// ---------------- ROUTE ----------------

// ---------------- ROUTE ----------------

app.post("/v1/analyze", async (req, res) => {
  try {
    if (req.headers["x-ia11-key"] !== IA11_KEY)
      return res.status(401).json({ error: "Invalid key" });

    const { text, mode, language } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });

    const normalizedMode = safeLower(mode) === "pro" ? "pro" : "standard";
    // RATE LIMIT (Standard vs Pro)
    const limit = normalizedMode === "pro" ? RATE_LIMIT_PRO : RATE_LIMIT_STANDARD;
    const rl = rateLimitCheck(req, normalizedMode, limit);
      
      if (!rl.ok) {
        res.set("Retry-After", String(rl.retryAfterSec));
        return res.status(429).json({
          error: "Rate limit exceeded",
          mode: normalizedMode,
          limitPerMin: limit,
          retryAfterSec: rl.retryAfterSec,
        });
      }

     // STANDARD: 1 mini Serper (max) pour éviter les absurdités factuelles
    if (normalizedMode === "standard") {
      const standardOut = computeStandard(text, language);

      // Mini "reality check" (1 recherche max) => pénalité si contradiction évidente
      const reality = await runStandardRealityCheck(text, language);
      const penalty = reality?.penalty || 0;

      const adjustedScore = Math.max(0, Math.round(standardOut.score - penalty));

      const l = (language || "en").toLowerCase();
      const fr = l.startsWith("fr");

      const extraLine = reality?.used
        ? (reality.verdict === "contradiction"
            ? (fr ? "Mini-vérification web: contradiction évidente détectée." : "Mini web check: obvious contradiction detected.")
            : (fr ? "Mini-vérification web: aucun conflit évident (signal léger)." : "Mini web check: no obvious conflict (light signal)."))
        : (fr ? "Mini-vérification web indisponible." : "Mini web check unavailable.");

      const summary = `${standardOut.summary} ${extraLine}`;

      return res.json({
        status: "ok",
        engine: "IA11 Ultra Pro",
        result: {
          mode: "standard",
          score: adjustedScore,
          label: labelFromScore(language, adjustedScore),
          summary,
          // Standard: on montre seulement quelques liens (si utilisés) pour guider sans faire un PRO déguisé
          sources: (reality?.sources || []).slice(0, 3),
          standard: {
            ...standardOut.standard,
            realityCheck: {
              used: !!reality?.used,
              penaltyApplied: penalty,
              verdict: reality?.verdict || null,
              query: reality?.query || null,
            },
          },
        },
      });
    }


    // PRO: nécessite Serper
    if (!SERPER_KEY)
      return res.status(500).json({ error: "Missing SERPER_API_KEY" });

    const writingScore = computeWritingScore(text);

    const proSearch = await runProEvidence(text, language);

    const verifiable = looksLikeVerifiableClaim(proSearch?.claim || text);

    const evidenceScore = proSearch?.evidence?.evidenceScore ?? 45;
    const confidence = proSearch?.evidence?.confidence ?? 10;
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

    // Sources cliquables (title + url + domain)
    const sources = (proSearch.items || []).slice(0, 8).map((it) => ({
      title: it.title,
      url: it.url,
      domain: it.domain,
      reliability: it.reliability,
      stance: it.stance,
      snippet: it.snippet,
    }));

    return res.json({
      status: "ok",
      engine: "IA11 Ultra Pro",
      result: {
        mode: "pro",
        score: finalScore,
        label: labelFromScore(language, finalScore),
        summary,
        confidence,
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
        sources, // <-- Lovable peut afficher ça en liens cliquables
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});



// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("IA11 Ultra Pro running on port", PORT);
});
