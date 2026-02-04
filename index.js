// =====================
// IA11 — LeenScore Engine (Render)
// =====================

const express = require("express");
const cors = require("cors");

const app = express();
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

// HEALTH
app.get("/", (req, res) => {
  res.json({ status: "ok", engine: "IA11 Ultra Pro" });
});

// ================= SERPER SEARCH =================
async function serperSearch(query, lang) {
  console.log("🔎 SERPER QUERY:", query);   // <-- AJOUT

  try {
    const r = await _fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, gl: "us", hl: lang || "en" }),
    });

    const j = await r.json();

    console.log("📥 SERPER RESULTS:", (j.organic || []).length); // <-- AJOUT

    return { ok: true, items: (j.organic || []).slice(0, 5) };
  } catch (e) {
    console.log("❌ SERPER ERROR:", e.message); // <-- AJOUT
    return { ok: false, error: e.message };
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

  // Si c’est court + contient structure factuelle → vérifiable
  if (t.length < 220 && (kwHit || hasNumbers || hasYear) && verbHit) return true;

  // Même si plus long, si mots “poste officiel” + verbes factuels
  if (kwHit && verbHit) return true;

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

// ---------------- PRO (1 à 3 Serper max) : dictature de la preuve + sources cliquables ----------------

// Mini cache mémoire (évite de payer Serper 20 fois pour la même phrase)
const PRO_CACHE = new Map(); // key -> { expiresAt, payload }
const PRO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days


function cacheGet(key) {
  const v = PRO_CACHE.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    PRO_CACHE.delete(key);
    return null;
  }
  return v.payload;
}

function cacheSet(key, payload) {
  PRO_CACHE.set(key, { expiresAt: Date.now() + PRO_CACHE_TTL_MS, payload });
}

function normalizeClaimForCache(text, lang) {
  const t = safeLower(text || "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .slice(0, 220);
  return `${(lang || "en").toLowerCase()}::${t}`;
}

function extractMainClaim(text) {
  const t = (text || "").trim();
  if (!t) return "";
  // prend la 1re phrase courte (sinon début)
  const parts = t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
  return (parts[0] || t).trim().slice(0, 240);
}

function stanceFromText(snippetOrTitle) {
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

function scoreEvidenceBrutal(enrichedItems) {
  const list = enrichedItems || [];
  if (list.length === 0) {
    return {
      evidenceScore: 45,
      confidence: 20,
      hasContradictions: false,
      strongRefute: false,
      strongSupport: false,
      notes: ["no_sources"],
    };
  }

  // Stats
  const domains = new Set();
  let relSum = 0;

  let support = 0;
  let refute = 0;
  let unknown = 0;

  for (const it of list) {
    const rel = it.reliability || 50;
    relSum += rel;
    if (it.domain) domains.add(it.domain);

    const stance = it.stance || "unknown";
    if (stance === "support") support++;
    else if (stance === "refute") refute++;
    else unknown++;
  }

  const avgRel = relSum / Math.max(1, list.length);
  const diversity = domains.size;

  const hasContradictions = support > 0 && refute > 0;

  // “Forte contradiction” = refute domine + sources pas mauvaises
  const strongRefute = refute >= Math.max(2, support + 1) && avgRel >= 70;
  const strongSupport = support >= Math.max(2, refute + 1) && avgRel >= 70;

  // Score evidence brut
  let evidenceScore = 50;

  // Qualité
  if (avgRel >= 85) evidenceScore += 20;
  else if (avgRel >= 70) evidenceScore += 12;
  else evidenceScore += 6;

  // Diversité
  if (diversity >= 5) evidenceScore += 12;
  else if (diversity >= 3) evidenceScore += 8;
  else if (diversity >= 2) evidenceScore += 4;

  // Pénalités
  if (hasContradictions) evidenceScore -= 10;

  // Verdict brutal
  if (strongRefute) evidenceScore = Math.min(evidenceScore, 12);
  if (strongSupport) evidenceScore = Math.max(evidenceScore, 80);

  evidenceScore = Math.max(0, Math.min(100, Math.round(evidenceScore)));

  // Confiance
  let confidence = 35;
  confidence += Math.round((avgRel - 50) * 0.6);
  confidence += Math.min(20, diversity * 4);
  if (hasContradictions) confidence -= 10;
  if (strongRefute || strongSupport) confidence += 10;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const notes = [];
  if (hasContradictions) notes.push("mixed_signals");
  if (strongRefute) notes.push("strong_refutation");
  if (strongSupport) notes.push("strong_corroboration");
  if (avgRel >= 85) notes.push("high_quality_sources");

  return { evidenceScore, confidence, hasContradictions, strongRefute, strongSupport, notes };
}

function buildProExplanation(lang, claim, evidence, buckets) {
  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");

  const { strongRefute, strongSupport, hasContradictions, confidence } = evidence;

  if (fr) {
    if (strongRefute) {
      return `Analyse des éléments disponibles : les sources consultées contredisent clairement l’affirmation (« ${claim} »). À ce stade, elle apparaît très probablement incorrecte. Niveau de confiance : ${confidence}/100. Limite : cette conclusion dépend des sources accessibles publiquement au moment de l’analyse.`;
    }
    if (strongSupport) {
      return `Analyse des éléments disponibles : plusieurs sources fiables corroborent l’affirmation (« ${claim} »). À ce stade, elle apparaît probablement correcte. Niveau de confiance : ${confidence}/100. Limite : la qualité dépend des sources accessibles publiquement au moment de l’analyse.`;
    }
    if (hasContradictions) {
      return `Analyse des éléments disponibles : les sources consultées présentent des signaux partagés autour de l’affirmation (« ${claim} »). À ce stade, prudence recommandée. Niveau de confiance : ${confidence}/100.`;
    }
    return `Analyse des éléments disponibles : les sources consultées apportent des éléments limités ou indirects sur l’affirmation (« ${claim} »). À ce stade, impossible de conclure solidement. Niveau de confiance : ${confidence}/100.`;
  } else {
    if (strongRefute) {
      return `Evidence review: consulted sources clearly contradict the claim ("${claim}"). At this stage, it appears very likely incorrect. Confidence: ${confidence}/100. Limitation: depends on publicly available sources at analysis time.`;
    }
    if (strongSupport) {
      return `Evidence review: multiple reliable sources corroborate the claim ("${claim}"). At this stage, it appears likely correct. Confidence: ${confidence}/100. Limitation: depends on publicly available sources at analysis time.`;
    }
    if (hasContradictions) {
      return `Evidence review: consulted sources show mixed signals around the claim ("${claim}"). Caution is recommended. Confidence: ${confidence}/100.`;
    }
    return `Evidence review: consulted sources provide limited or indirect support regarding the claim ("${claim}"). No solid conclusion can be made. Confidence: ${confidence}/100.`;
  }
}

async function runProEvidence(text, lang) {
  const claim = extractMainClaim(text);
  const cacheKey = normalizeClaimForCache(claim, lang);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const queries = buildProQueries(claim, lang);

  let allItems = [];
  let okCount = 0;
  let lastError = null;

  // Max 3 requêtes, et on s’arrête tôt si on a déjà assez de matière
  for (const q of queries) {
    try {
      const out = await serperSearch(q, lang);
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
    if (fastDedup.length >= 8) break;
  }

  const deduped = dedupeItems(allItems).slice(0, 10);
  const enriched = deduped.map((it) => {
    const link = it.link || it.url || "";
    const domain = getDomain(link);
    const title = it.title || "";
    const snippet = it.snippet || it.description || "";
    const reliability = domainReliability(domain);
    const stance = stanceFromText(`${title} ${snippet}`);

    return {
      title,
      url: link,
      link, // compat
      snippet,
      domain,
      reliability,
      stance,
    };
  });

  // Buckets (wow)
  const buckets = { corroborates: [], contradicts: [], neutral: [] };
  for (const it of enriched) {
    if (it.stance === "support") buckets.corroborates.push(it);
    else if (it.stance === "refute") buckets.contradicts.push(it);
    else buckets.neutral.push(it);
  }

  const evidence = scoreEvidenceBrutal(enriched);

  const payload = {
    ok: okCount > 0,
    claim,
    queriesUsed: queries,
    items: enriched,
    buckets,
    evidence,
    error: okCount > 0 ? null : lastError || "Unknown search error",
  };

  cacheSet(cacheKey, payload);
  return { ...payload, fromCache: false };
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

app.post("/v1/analyze", async (req, res) => {
  try {
    if (req.headers["x-ia11-key"] !== IA11_KEY)
      return res.status(401).json({ error: "Invalid key" });

    const { text, mode, language } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });

    const normalizedMode = safeLower(mode) === "pro" ? "pro" : "standard";

    // STANDARD: 0 Serper
    if (normalizedMode === "standard") {
      const standardOut = computeStandard(text, language);

      return res.json({
        status: "ok",
        engine: "IA11 Ultra Pro",
        result: {
          mode: "standard",
          score: standardOut.score,
          label: labelFromScore(language, standardOut.score),
          summary: standardOut.summary,
          sources: [], // Standard = aucun lien web
          standard: standardOut.standard,
        },
      });
    }

    // PRO: nécessite Serper
    if (!SERPER_KEY)
      return res.status(500).json({ error: "Missing SERPER_API_KEY" });

    const writingScore = computeWritingScore(text);
    const verifiable = looksLikeVerifiableClaim(text);

    const proSearch = await runProEvidence(text, language);

    const evidenceScore = proSearch.evidence.evidenceScore;
    const confidence = proSearch.evidence.confidence;
    const strongRefute = proSearch.evidence.strongRefute;

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
    res.status(500).json({ error: e.message });
  }
});

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("IA11 Ultra Pro running on port", PORT);
});
