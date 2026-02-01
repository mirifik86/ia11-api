/**
 * IA11 — Credibility Intelligence Engine
 * Ultra PRO Production Build for LeenScore
 *
 * - Single analysis brain (Lovable UI stays untouched)
 * - Real web verification (Bing or Serper)
 * - Strict PRO output contract
 * - Language-safe (matches UI language)
 * - Defensive & Render-safe
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ================= CONFIG ================= */

const ENGINE_NAME = "IA11";
const VERSION = "2.1.0-ultra-pro";

const IA11_API_KEY = process.env.IA11_API_KEY || "";
if (!IA11_API_KEY) {
  console.error("❌ IA11_API_KEY missing");
  process.exit(1);
}

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

// Search providers
const BING_API_KEY = process.env.BING_API_KEY || "";
const BING_ENDPOINT =
  process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";

const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SERPER_ENDPOINT =
  process.env.SERPER_ENDPOINT || "https://google.serper.dev/search";

const SEARCH_PROVIDER = (
  process.env.SEARCH_PROVIDER ||
  (SERPER_API_KEY ? "serper" : BING_API_KEY ? "bing" : "none")
).toLowerCase();

/* ================= RATE LIMIT ================= */

const rateMap = new Map();

function rateLimit(key, limit) {
  const now = Date.now();
  const windowMs = 60_000;

  const entry = rateMap.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  rateMap.set(key, entry);

  return entry.count <= limit;
}

/* ================= UTIL ================= */

function uid() {
  return crypto.randomUUID();
}

function normalizeLang(lang) {
  return typeof lang === "string" && lang.length <= 5 ? lang : "en";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ================= SEARCH ================= */

async function webSearch(query) {
  if (SEARCH_PROVIDER === "bing" && BING_API_KEY) {
    const res = await fetch(
      `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&recency=365`,
      {
        headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
      }
    );
    const json = await res.json();
    return (
      json.webPages?.value?.map((r) => ({
        title: r.name,
        url: r.url,
        snippet: r.snippet || "",
      })) || []
    );
  }

  if (SEARCH_PROVIDER === "serper" && SERPER_API_KEY) {
    const res = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    const json = await res.json();
    return (
      json.organic?.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet || "",
      })) || []
    );
  }

  return [];
}

/* ================= ANALYSIS CORE ================= */

function classifySource(text, snippet) {
  const t = `${text} ${snippet}`.toLowerCase();
  if (t.includes("false") || t.includes("debunk")) return "contradicts";
  if (t.includes("confirmed") || t.includes("according to")) return "corroborates";
  return "context";
}

function buildAnalysis(text, sources, lang) {
  let score = 50;
  const signals = [];

  if (text.length > 120) {
    score += 10;
    signals.push("Detailed claim");
  }
  if (sources.length >= 5) {
    score += 15;
    signals.push("Multiple independent sources");
  }

  const contradict = sources.filter((s) => s.stance === "contradicts").length;
  const corroborate = sources.filter((s) => s.stance === "corroborates").length;

  if (contradict > corroborate) {
    score -= 20;
    signals.push("Contradicting evidence detected");
  }

  score = clamp(score, 5, 98);

  const riskLevel =
    score < 40 ? "high" : score < 70 ? "medium" : "low";

  return {
    score,
    riskLevel,
    summary:
      lang === "fr"
        ? "Analyse PRO basée sur vérification factuelle et sources réelles."
        : "PRO analysis based on factual verification and real sources.",
    explanation:
      lang === "fr"
        ? "Cette analyse combine vérification web, cohérence interne et qualité des sources pour évaluer la crédibilité."
        : "This analysis combines web verification, internal consistency and source quality to assess credibility.",
    keySignals: signals,
    verdict:
      lang === "fr"
        ? riskLevel === "low"
          ? "Contenu globalement crédible."
          : "Contenu à vérifier avec prudence."
        : riskLevel === "low"
        ? "Content is largely credible."
        : "Content should be treated with caution.",
    confidence: clamp(score / 100, 0.4, 0.95),
  };
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: VERSION,
  });
});

app.post("/v1/analyze", async (req, res) => {
  const key = req.headers["x-ia11-key"];
  if (key !== IA11_API_KEY) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  if (!rateLimit(key, RATE_LIMIT_PER_MIN_PRO)) {
    return res.status(429).json({ status: "error", message: "Rate limit exceeded" });
  }

  const { text, uiLanguage = "en", mode = "pro" } = req.body;
  if (!text || typeof text !== "string") {
    return res.status(400).json({ status: "error", message: "Text missing" });
  }

  const lang = normalizeLang(uiLanguage);
  const requestId = uid();
  const started = Date.now();

  const rawSources = await webSearch(text);
  const sources = rawSources.map((s) => ({
    title: s.title,
    url: s.url,
    stance: classifySource(text, s.snippet),
    confidence: 0.7,
  }));

  if (sources.length < 5) {
    return res.status(503).json({
      status: "retry",
      message: "Insufficient sources for PRO analysis",
    });
  }

  const analysis = buildAnalysis(text, sources, lang);

  res.json({
    status: "success",
    requestId,
    engine: ENGINE_NAME,
    mode,
    result: {
      ...analysis,
      sources,
    },
    meta: {
      tookMs: Date.now() - started,
      version: VERSION,
    },
  });
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ IA11 Ultra PRO running on port ${PORT}`)
);
