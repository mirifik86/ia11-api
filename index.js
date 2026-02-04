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
  try {
    const r = await _fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, gl: "us", hl: lang || "en" }),
    });

    if (!r.ok) return { ok: false, error: "Serper error" };
    const j = await r.json();

    return { ok: true, items: (j.organic || []).slice(0, 5) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ================= IA11 PRO CORE (Claims + Evidence + Scoring) =================

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

// Petit classement simple (ça évite de donner le même poids à un blog random qu’à un site officiel)
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

// Découpe simple en “claims” (max 3). Ça évite d’analyser un pavé comme une seule phrase.
function extractClaims(text) {
  const t = (text || "").trim();
  if (!t) return [];

  const raw = t
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Si c’est court → 1 claim
  if (t.length < 180) return [t];

  // Sinon → 2-3 claims max
  return raw.slice(0, 3);
}

function buildQueriesForClaim(claim, uiLanguage, mode) {
  const lang = (uiLanguage || "en").toLowerCase();
  const isFr = lang.startsWith("fr");
  const isPro = safeLower(mode) === "pro";

  const proExtras = isFr
    ? [
        `${claim} source officielle`,
        `${claim} communiqué officiel`,
        `${claim} vérification des faits`,
      ]
    : [
        `${claim} official source`,
        `${claim} press release`,
        `${claim} fact check`,
      ];

  const base = [
    claim,
    `"${claim}"`,
  ];

  // Standard = moins de requêtes, PRO = plus de profondeur
  return isPro ? base.concat(proExtras).slice(0, 5) : base.slice(0, 2);
}

function stanceFromSnippet(snippet) {
  const s = safeLower(snippet);

  const refuteWords = ["false", "debunk", "hoax", "myth", "not true", "refuted", "misleading", "fake", "faux", "canular", "démenti", "dementi", "trompeur"];
  const supportWords = ["confirmed", "official", "announced", "statement", "report", "according to", "communiqué", "communique", "déclare", "declare", "rapport"];

  let refute = 0;
  let support = 0;

  for (const w of refuteWords) if (s.includes(w)) refute++;
  for (const w of supportWords) if (s.includes(w)) support++;

  if (refute > support) return "refute";
  if (support > refute) return "support";
  return "unknown";
}

function scoreEvidence(items, claimCount) {
  const list = items || [];
  if (list.length === 0) {
    return { score: 45, confidence: 20, notes: ["no_sources"] };
  }

  // Qualité moyenne des domaines + diversité
  const domains = new Set();
  let relSum = 0;

  let support = 0;
  let refute = 0;

  for (const it of list) {
    const domain = getDomain(it.link || it.url || "");
    const rel = domainReliability(domain);
    relSum += rel;
    if (domain) domains.add(domain);

    const stance = stanceFromSnippet(it.snippet || it.description || "");
    if (stance === "support") support++;
    if (stance === "refute") refute++;
  }

  const avgRel = relSum / Math.max(1, list.length);
  const diversity = domains.size;

  // Contradiction simple : il y a du “support” ET du “refute”
  const contradictions = support > 0 && refute > 0;

  // Score principal
  let score = 50;

  // Fiabilité
  if (avgRel >= 85) score += 22;
  else if (avgRel >= 70) score += 14;
  else score += 6;

  // Diversité (évite 5 résultats du même site)
  if (diversity >= 6) score += 18;
  else if (diversity >= 4) score += 12;
  else if (diversity >= 2) score += 6;

  // Volume (sans sur-valoriser)
  if (list.length >= 10) score += 6;
  else if (list.length >= 5) score += 3;

  // Pénalité contradictions
  if (contradictions) score -= 14;

  // Pénalité si plusieurs claims mais peu de preuves
  if (claimCount >= 2 && list.length < 5) score -= 6;

  // Clamp 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Confiance (différent du score)
  let confidence = 30;
  confidence += Math.round((avgRel - 50) * 0.6);
  confidence += Math.min(20, diversity * 3);
  if (contradictions) confidence -= 15;
  confidence = Math.max(0, Math.min(100, confidence));

  const notes = [];
  if (contradictions) notes.push("contradictions_detected");
  if (avgRel >= 85) notes.push("high_quality_sources");
  if (diversity >= 4) notes.push("diverse_sources");

  return { score, confidence, notes };
}

function makeSummary(lang, score, confidence, hasContradictions) {
  const l = (lang || "en").toLowerCase();
  const fr = l.startsWith("fr");

  if (fr) {
    if (score >= 80 && confidence >= 70 && !hasContradictions)
      return "Sources nombreuses et fiables. Cohérence élevée.";
    if (hasContradictions)
      return "Sources partagées ou contradictoires. Prudence recommandée.";
    if (score >= 65)
      return "Plusieurs sources trouvées, crédibilité modérée à bonne.";
    return "Peu de preuves solides trouvées. Crédibilité faible à vérifier.";
  } else {
    if (score >= 80 && confidence >= 70 && !hasContradictions)
      return "Many reliable sources found. High consistency.";
    if (hasContradictions)
      return "Sources appear mixed or contradictory. Caution recommended.";
    if (score >= 65)
      return "Several sources found, moderate to good credibility.";
    return "Limited solid evidence found. Low credibility, needs verification.";
  }
}

async function serperMultiSearch(text, mode, uiLanguage, opts = {}) {
  const claims = extractClaims(text);
  const allQueries = [];
  let allItems = [];
  let okCount = 0;
  let lastError = null;

  // PRO = plus de profondeur, Standard = plus léger
  const isPro = safeLower(mode) === "pro";

  for (const claim of claims) {
    const queries = buildQueriesForClaim(claim, uiLanguage, isPro ? "pro" : "standard");
    allQueries.push(...queries);

    for (const q of queries) {
      try {
        const out = await serperSearch(q, uiLanguage);
        if (out.ok) {
          okCount++;
          allItems = allItems.concat(out.items || []);
        } else {
          lastError = out.error || lastError;
        }
      } catch (e) {
        lastError = e?.message || lastError;
      }
    }
  }

  // Dédup + enrichissement domain + reliability
  const deduped = dedupeItems(allItems).slice(0, isPro ? 12 : 6);
  const enriched = deduped.map((it) => {
    const link = it.link || it.url || "";
    const domain = getDomain(link);
    return {
      title: it.title || "",
      link,
      snippet: it.snippet || it.description || "",
      domain,
      reliability: domainReliability(domain),
    };
  });

  // Contradictions globales (simple)
  let support = 0;
  let refute = 0;
  for (const it of enriched) {
    const stance = stanceFromSnippet(it.snippet || "");
    if (stance === "support") support++;
    if (stance === "refute") refute++;
  }
  const hasContradictions = support > 0 && refute > 0;

  const scoring = scoreEvidence(enriched, claims.length);

  return {
    ok: okCount > 0,
    claims,
    items: enriched,
    hasContradictions,
    score: scoring.score,
    confidence: scoring.confidence,
    notes: scoring.notes,
    error: okCount > 0 ? null : lastError || "Unknown search error",
    queries: allQueries,
  };
}

app.post("/v1/analyze", async (req, res) => {
  try {
    if (req.headers["x-ia11-key"] !== IA11_KEY)
      return res.status(401).json({ error: "Invalid key" });

    if (!SERPER_KEY)
      return res.status(500).json({ error: "Missing SERPER_API_KEY" });

    const { text, mode, language } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });

    // mode attendu: "standard" ou "pro"
    const normalizedMode = safeLower(mode) === "pro" ? "pro" : "standard";

    const search = await serperMultiSearch(text, normalizedMode, language);

    const summary = makeSummary(
      language,
      search.score,
      search.confidence,
      !!search.hasContradictions
    );

    res.json({
      status: "ok",
      engine: "IA11 Ultra Pro",
      result: {
        // Champs “compatibles Lovable”
        score: search.score,
        summary,
        sources: search.items || [],

        // Champs “bonus” (Lovable peut les ignorer)
        confidence: search.confidence,
        claims: search.claims || [],
        notes: search.notes || [],
        contradictions: !!search.hasContradictions,
        queriesUsed: (search.queries || []).slice(0, 10),
        mode: normalizedMode,
      },
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
