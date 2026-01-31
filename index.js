/**
 * IA11 - Credibility Intelligence Engine (LeenScore)
 * Single-file production server (Node/Express) for Render.
 *
 * ENV required:
 * - IA11_API_KEY="your_primary_key"
 * Optional:
 * - IA11_API_KEYS="key1,key2,key3"  (comma-separated)
 * - RATE_LIMIT_PER_MIN="30"
 * - RATE_LIMIT_PER_MIN_PRO="60"
 * - ENGINE_VERSION="1.3.1-pro-compatible"
 * - WEB_EVIDENCE_PROVIDER="bing" (default "bing")
 * - BING_API_KEY="..." (for PRO web evidence)
 * - BING_ENDPOINT="https://api.bing.microsoft.com/v7.0/search"
 *
 * Headers accepted:
 * - x-ia11-key: <key> (required)
 * - x-ui-lang: fr|en|... (optional)
 * - x-tier: standard|pro (optional)
 *
 * Body accepted:
 * - { text: "...", language: "fr", analysisType: "standard"|"pro" }
 * - or { content: "..." } (alias)
 */

import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Engine identity
const ENGINE_NAME = "IA11";
const ENGINE_VERSION = (process.env.ENGINE_VERSION || "1.3.0-pro-compatible").toString().trim();
const PORT = parseInt(process.env.PORT || "10000", 10);

// ---- Auth keys (trimmed)
const IA11_API_KEY_RAW = (process.env.IA11_API_KEY || "").toString().trim();
const IA11_API_KEYS_RAW = (process.env.IA11_API_KEYS || "").toString().trim();

// ---- Rate limits
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);
const RATE_LIMIT_PER_MIN_PRO = parseInt(process.env.RATE_LIMIT_PER_MIN_PRO || "60", 10);

// ---- Web evidence (optional, PRO)
const WEB_EVIDENCE_PROVIDER = ((process.env.WEB_EVIDENCE_PROVIDER || "bing") + "").toLowerCase().trim();
const BING_API_KEY = (process.env.BING_API_KEY || "").toString().trim();
const BING_ENDPOINT = (process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search").toString().trim();

// ---- Key set
const allowedKeys = new Set(
  [
    IA11_API_KEY_RAW,
    ...IA11_API_KEYS_RAW.split(",").map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean)
);

// ---- Simple in-memory rate limiter (per key)
const buckets = new Map(); // key -> { windowStartMs, count, countPro }

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
  // Keep anything but normalize common
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("en")) return "en";
  return raw;
}

function detectMode(bodyType, headerTier) {
  const raw = (bodyType || headerTier || "standard").toString().toLowerCase().trim();
  if (raw === "pro" || raw === "premium" || raw === "premium_plus") return "pro";
  return "standard";
}

function authAndRateLimit(req) {
  const incoming = safeStr(req.headers["x-ia11-key"]).trim();
  const tier = safeStr(req.headers["x-tier"]).toLowerCase().trim();
  const mode = detectMode(req.body?.analysisType, tier);

  if (!incoming || !allowedKeys.has(incoming)) {
    return { ok: false, status: 401, error: "Clé API invalide." };
  }

  const key = incoming;
  const limit = mode === "pro" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const t = nowMs();
  const windowMs = 60_000;
  const bucket = buckets.get(key) || { windowStartMs: t, count: 0, countPro: 0 };

  if (t - bucket.windowStartMs >= windowMs) {
    bucket.windowStartMs = t;
    bucket.count = 0;
    bucket.countPro = 0;
  }

  if (mode === "pro") bucket.countPro += 1;
  else bucket.count += 1;

  const used = mode === "pro" ? bucket.countPro : bucket.count;

  buckets.set(key, bucket);

  if (used > limit) {
    return { ok: false, status: 429, error: "Trop de requêtes. Réessayez dans une minute." };
  }

  return { ok: true, mode };
}

// -----------------------------
// Scoring + PRO logic (Lovable-compatible outputs)
// -----------------------------

function scoreSignals(text) {
  const t = text.trim();
  const lower = t.toLowerCase();

  const length = t.length;
  const hasUrl = /(https?:\/\/|www\.)/i.test(t);
  const hasNumbers = /\d/.test(t);
  const hasDateLike = /\b(19|20)\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t);
  const hasProperNames = /\b[A-Z][a-z]{2,}\b/.test(t); // weak proxy
  const hasQuotes = /["“”«»]/.test(t);
  const hasQuestion = /\?/.test(t);

  const sensational = /\b(choc|incroyable|scandale|honteux|100%|preuve absolue|tout le monde sait|on nous cache|complot)\b/i.test(lower);
  const hedging = /\b(peut-?être|probablement|il semble|selon|d'après|aurait|pourrait|serait)\b/i.test(lower);

  // simple citation cues
  const citesSourceWords = /\b(source|référence|rapport|étude|communiqué|document|article)\b/i.test(lower);

  // Basic “claim structure”: short, absolute claims are riskier
  const isVeryShort = length < 40;
  const isShort = length < 90;

  // Build points by dimensions (Lovable UI expects breakdown categories)
  const breakdown = {
    sources: { points: 0, reason: "" },
    factual: { points: 0, reason: "" },
    tone: { points: 0, reason: "" },
    context: { points: 0, reason: "" },
    transparency: { points: 0, reason: "" },
  };

  // SOURCES
  let sourcesPts = 0;
  if (hasUrl) sourcesPts += 18;
  if (citesSourceWords) sourcesPts += 10;
  if (!hasUrl && !citesSourceWords) sourcesPts -= 8;
  breakdown.sources.points = clamp(sourcesPts, -20, 25);
  breakdown.sources.reason =
    hasUrl || citesSourceWords
      ? "Présence d’indices de sources (liens / références)."
      : "Aucun indice clair de source ou de référence externe.";

  // FACTUAL
  let factualPts = 0;
  if (hasNumbers) factualPts += 8;
  if (hasDateLike) factualPts += 8;
  if (hasProperNames) factualPts += 6;
  if (isVeryShort) factualPts -= 10;
  if (isShort) factualPts -= 4;
  breakdown.factual.points = clamp(factualPts, -20, 25);
  breakdown.factual.reason =
    factualPts >= 10
      ? "Le texte contient des détails vérifiables (noms/dates/chiffres)."
      : "Peu de détails vérifiables; l’affirmation est difficile à confirmer.";

  // TONE / PRUDENCE
  let tonePts = 0;
  if (sensational) tonePts -= 18;
  if (hedging) tonePts += 10;
  if (hasQuestion) tonePts += 4;
  breakdown.tone.points = clamp(tonePts, -25, 20);
  breakdown.tone.reason =
    sensational
      ? "Tonalité sensationnaliste ou absolue (augmente le risque)."
      : hedging
        ? "Formulation prudente (réduit le risque d’affirmation catégorique)."
        : "Tonalité neutre.";

  // CONTEXT
  let contextPts = 0;
  if (length >= 220) contextPts += 10;
  if (length >= 500) contextPts += 10;
  if (isVeryShort) contextPts -= 12;
  breakdown.context.points = clamp(contextPts, -20, 20);
  breakdown.context.reason =
    contextPts > 0 ? "Contexte suffisant pour interpréter l’affirmation." : "Contexte limité.";

  // TRANSPARENCY (how clear the claim is)
  let transpPts = 0;
  if (hasQuotes) transpPts += 6;
  if (hasUrl) transpPts += 6;
  if (sensational) transpPts -= 6;
  breakdown.transparency.points = clamp(transpPts, -15, 15);
  breakdown.transparency.reason =
    hasUrl || hasQuotes
      ? "Certaines indications facilitent la traçabilité (liens / citations)."
      : "Peu d’indices de traçabilité (pas de lien, citation ou référence).";

  // Aggregate score
  const base = 55;
  const sum =
    breakdown.sources.points +
    breakdown.factual.points +
    breakdown.tone.points +
    breakdown.context.points +
    breakdown.transparency.points;

  let score = clamp(base + sum, 5, 98);

  // Risk level from score
  const riskLevel = score >= 75 ? "low" : score >= 50 ? "medium" : "high";

  // Confidence (0..1) - heuristic
  let confidence = 0.45;
  if (hasUrl) confidence += 0.15;
  if (hasDateLike || hasNumbers) confidence += 0.08;
  if (sensational) confidence -= 0.12;
  if (isVeryShort) confidence -= 0.10;
  confidence = clamp(confidence, 0.2, 0.92);

  // Reasons array (Lovable UI shows "reasons")
  const reasons = [];
  if (!hasUrl && !citesSourceWords) reasons.push("Aucune source ou référence externe explicite n’est fournie.");
  if (sensational) reasons.push("Le texte contient des formulations sensationnalistes ou absolues.");
  if (isVeryShort) reasons.push("Le texte est très court, donc difficile à vérifier ou contextualiser.");
  if (hasDateLike || hasNumbers || hasProperNames) reasons.push("Le texte contient des éléments potentiellement vérifiables (noms/dates/chiffres).");
  if (hedging) reasons.push("La formulation reste prudente (conditionnel / incertitude).");

  if (reasons.length === 0) reasons.push("Analyse basée sur les signaux textuels disponibles.");

  return { score, riskLevel, confidence, reasons, breakdown };
}

// --- Web evidence (PRO). Bing search -> simple stance scoring.
// If no API key configured, returns "limited coverage".
async function fetchBingEvidence(query, max = 5, timeoutMs = 6000) {
  if (!BING_API_KEY) return { ok: false, reason: "no_bing_key", items: [] };

  const url = new URL(BING_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(max));
  url.searchParams.set("mkt", "en-US"); // keep deterministic; UI can translate later if needed
  url.searchParams.set("safeSearch", "Moderate");

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
        provider: "bing",
      }))
      .filter((x) => x.url);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: "bing_error", items: [] };
  } finally {
    clearTimeout(timer);
  }
}

function buildEvidenceSummary(items, claimText) {
  // Very lightweight stance: if snippet contains “false/hoax/not true” vs overlap keywords
  const claim = claimText.toLowerCase();
  const tokens = claim
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 18);

  const negCues = ["false", "hoax", "not true", "debunk", "misleading", "fake", "rumor", "rumeur", "faux", "démenti"];
  const posCues = ["confirmed", "official", "announced", "report", "statement", "communiqué", "rapport", "confirmé"];

  let corroborates = 0;
  let contradicts = 0;

  const sources = items.map((it) => {
    const s = (it.snippet || "").toLowerCase();
    const hasNeg = negCues.some((c) => s.includes(c));
    const hasPos = posCues.some((c) => s.includes(c));
    const overlap = tokens.reduce((acc, t) => (s.includes(t) ? acc + 1 : acc), 0);

    let stance = "context";
    if (hasNeg && !hasPos) stance = "contradicts";
    else if (hasPos && !hasNeg) stance = "corroborates";
    else if (overlap >= 3) stance = "corroborates"; // weak support

    if (stance === "corroborates") corroborates += 1;
    if (stance === "contradicts") contradicts += 1;

    // reliability heuristic: prefer known domains? (very light)
    const reliability =
      /(\.gov|\.edu|who\.int|un\.org|oecd\.org|europa\.eu)/i.test(it.url) ? "high" : overlap >= 3 ? "medium" : "low";

    return {
      title: it.title || it.url,
      url: it.url,
      provider: it.provider || WEB_EVIDENCE_PROVIDER,
      stance,
      reliability,
    };
  });

  let outcome = "uncertain";
  if (corroborates >= 2 && contradicts === 0) outcome = "confirmed";
  if (contradicts >= 1 && corroborates === 0) outcome = "contradicted";
  if (contradicts >= 1 && corroborates >= 1) outcome = "mixed";

  const summary =
    outcome === "confirmed"
      ? "Des sources externes semblent corroborer l’affirmation."
      : outcome === "contradicted"
        ? "Des sources externes semblent contredire l’affirmation."
        : outcome === "mixed"
          ? "Les sources externes sont partagées (corroborations et contradictions)."
          : "Aucune confirmation externe forte n’a été identifiée.";

  const bestLinks = sources
    .filter((s) => s.reliability !== "low")
    .slice(0, 4)
    .map((s) => ({ title: s.title, url: s.url, stance: s.stance, reliability: s.reliability }));

  return {
    corroboration: {
      outcome,
      sourcesConsulted: sources.length,
      sourceTypes: Array.from(new Set(sources.map((s) => s.provider))).filter(Boolean),
      summary,
    },
    sources,
    bestLinks,
    stats: { corroborates, contradicts },
  };
}

function buildSummary(lang, mode, score, riskLevel, corroboration) {
  // Keep it short; UI can show long “PRO explanation” elsewhere
  const fr = {
    low: "Crédibilité élevée : signaux cohérents et risque faible.",
    medium: "Crédibilité moyenne : certains signaux sont solides, mais prudence recommandée.",
    high: "Crédibilité faible : manque de preuves ou signaux à risque.",
  };
  const en = {
    low: "High credibility: coherent signals and low risk.",
    medium: "Moderate credibility: some strong signals, but caution is recommended.",
    high: "Low credibility: limited evidence or higher-risk signals.",
  };

  const base = lang.startsWith("fr") ? fr[riskLevel] : en[riskLevel];

  if (mode === "pro" && corroboration?.outcome) {
    const extraFR =
      corroboration.outcome === "confirmed"
        ? " Des confirmations externes existent."
        : corroboration.outcome === "contradicted"
          ? " Des contradictions externes existent."
          : corroboration.outcome === "mixed"
            ? " Les sources externes sont partagées."
            : " Confirmation externe limitée.";
    const extraEN =
      corroboration.outcome === "confirmed"
        ? " External confirmations exist."
        : corroboration.outcome === "contradicted"
          ? " External contradictions exist."
          : corroboration.outcome === "mixed"
            ? " External sources are mixed."
            : " Limited external confirmation.";
    return base + (lang.startsWith("fr") ? extraFR : extraEN);
  }

  return base;
}

function buildArticleSummary(lang, mode, corroboration) {
  // This is what your UI labels as "Explication PRO" / "articleSummary" often
  if (mode !== "pro") return "";
  if (lang.startsWith("fr")) {
    return "Estimation de la crédibilité par IA11 basée sur les signaux textuels et une vérification externe lorsque disponible.";
  }
  return "Credibility estimate by IA11 based on textual signals and external verification when available.";
}

// -----------------------------
// Routes
// -----------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    message: "IA11 online",
  });
});

app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    usage: "POST /v1/analyze { text|content, language?, analysisType? } with header x-ia11-key",
  });
});

app.post("/v1/analyze", async (req, res) => {
  const t0 = nowMs();
  const requestId = newRequestId();

  // Auth + rate limit
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
        sources: [],
      },
      meta: { tookMs: nowMs() - t0, version: ENGINE_VERSION },
    });
  }

  const mode = gate.mode;

  // Input
  const text = safeStr(req.body?.text || req.body?.content || "").trim();
  const lang = detectLang(req.body?.language, req.headers["x-ui-lang"]);

  if (!text) {
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      result: {
        score: 5,
        riskLevel: "high",
        summary: lang.startsWith("fr") ? "Texte manquant." : "Missing text.",
        reasons: [],
        confidence: 0.2,
        sources: [],
      },
      meta: { tookMs: nowMs() - t0, version: ENGINE_VERSION },
    });
  }

  // Text-only scoring (base)
  const base = scoreSignals(text);

  // PRO evidence (optional)
  let corroboration = { outcome: "uncertain", sourcesConsulted: 0, sourceTypes: [], summary: "" };
  let sources = [];
  let bestLinks = [];
  let coverage = { webCoverage: "limited", sourceDiversity: "low", contradictionsCheck: "not_run" };

  if (mode === "pro") {
    // Use a simple query: first 140 chars without URLs
    const q = text.replace(/https?:\/\/\S+/g, "").slice(0, 140).trim();
    if (WEB_EVIDENCE_PROVIDER === "bing" && BING_API_KEY) {
      const ev = await fetchBingEvidence(q, 5);
      if (ev.ok && ev.items.length) {
        const built = buildEvidenceSummary(ev.items, text);
        corroboration = built.corroboration;
        sources = built.sources;
        bestLinks = built.bestLinks;
        coverage = {
          webCoverage: "limited", // still limited because we only do top results
          sourceDiversity: built.corroboration.sourceTypes.length >= 2 ? "medium" : "low",
          contradictionsCheck: built.stats.contradicts > 0 ? "found" : "none_found",
        };
      } else {
        corroboration = {
          outcome: "uncertain",
          sourcesConsulted: 0,
          sourceTypes: [],
          summary: lang.startsWith("fr")
            ? "Vérification web indisponible (clé manquante ou requête impossible)."
            : "Web verification unavailable (missing key or request failed).",
        };
      }
    } else {
      corroboration = {
        outcome: "uncertain",
        sourcesConsulted: 0,
        sourceTypes: [],
        summary: lang.startsWith("fr")
          ? "Couverture web limitée (aucune clé de recherche configurée)."
          : "Limited web coverage (no search key configured).",
      };
    }
  }

  // Adjust score slightly using corroboration in PRO
  let finalScore = base.score;
  if (mode === "pro") {
    if (corroboration.outcome === "confirmed") finalScore = clamp(finalScore + 10, 5, 98);
    if (corroboration.outcome === "contradicted") finalScore = clamp(finalScore - 12, 5, 98);
    if (corroboration.outcome === "mixed") finalScore = clamp(finalScore - 4, 5, 98);
  }

  const riskLevel = finalScore >= 75 ? "low" : finalScore >= 50 ? "medium" : "high";
  const summary = buildSummary(lang, mode, finalScore, riskLevel, corroboration);
  const articleSummary = buildArticleSummary(lang, mode, corroboration);

  // Ensure breakdown exists (Lovable UI cards rely on it)
  const breakdown = base.breakdown;

  // Output in Lovable-compatible shape:
  // raw: { status, requestId, engine, mode, result:{ score,riskLevel,summary,articleSummary,confidence,reasons,breakdown,corroboration,sources,bestLinks } }
  const out = {
    status: "ok",
    requestId,
    engine: ENGINE_NAME,
    mode,
    analysisType: mode, // for compatibility
    result: {
      score: finalScore,
      riskLevel,
      summary,
      articleSummary,
      confidence: base.confidence,
      reasons: base.reasons,
      breakdown,
      corroboration,
      sources,
      bestLinks,
      // extra: coverage fields (useful for your “Couverture de vérification” UI)
      coverage,
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

// ---- Start
app.listen(PORT, () => {
  console.log(`[IA11] running on :${PORT} | version=${ENGINE_VERSION}`);
  console.log(`[IA11] keys loaded: ${allowedKeys.size > 0 ? "yes" : "no"}`);
  console.log(`[IA11] web provider=${WEB_EVIDENCE_PROVIDER} | bing_key=${BING_API_KEY ? "yes" : "no"}`);
});
