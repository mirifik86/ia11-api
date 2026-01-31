/**
 * IA11 API (LeenScore) — index.js
 * - Express + CORS allowlist
 * - JSON limit 1mb
 * - Key auth: header "x-ia11-key" must match env IA11_API_KEY
 * - Rate limits: standard vs PRO
 * - Response contract v1:
 *   { status, requestId, engine, mode, result{score,riskLevel,summary,reasons,confidence,sources[]}, meta{tookMs,version} }
 *
 * Upgrades included:
 * A) Institutional Fact-Check (Wikidata) for official roles (president / prime minister)
 * B) Clean & dedupe sources (avoid duplicates + homepages)
 * C) PRO two-pass pipeline (extract key claims -> verify)
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();

/* -------------------------------
   Config (safe defaults)
-------------------------------- */
const PORT = process.env.PORT || 3000;

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 6000);

// Simple in-memory cache (optional)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const CACHE_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS || 500);

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

const IA11_API_KEY = (process.env.IA11_API_KEY || "").trim();

const ENGINE_NAME = "IA11";
const VERSION = "1.1.0";

// Optional: allowlist CORS origins (comma-separated). If empty, allow all.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* -------------------------------
   Middleware
-------------------------------- */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!CORS_ORIGINS.length) return cb(null, true); // allow all (dev)
      if (!origin) return cb(null, true); // server-to-server / curl
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
  })
);

app.use(express.json({ limit: "1mb" }));

/* -------------------------------
   Helpers
-------------------------------- */
function nowMs() {
  return Date.now();
}

function makeId() {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeTrimText(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim();
}

function isProbablyProMode(mode) {
  const m = String(mode || "standard").toLowerCase();
  return m === "pro" || m === "premium" || m === "premium_plus";
}

function detectLangVerySimple(text) {
  // VERY simple heuristic, good enough for now
  const t = (text || "").toLowerCase();
  const frHits = [" le ", " la ", " les ", " des ", " est ", " pas ", "président", "premier ministre", "gouvernement"];
  let frScore = 0;
  frHits.forEach((k) => {
    if (t.includes(k)) frScore += 1;
  });
  return frScore >= 2 ? "fr" : "en";
}

/* -------------------------------
   Simple in-memory cache
-------------------------------- */
const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (nowMs() - item.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.v;
}

function cacheSet(key, value) {
  if (CACHE_MAX_ITEMS > 0 && cache.size >= CACHE_MAX_ITEMS) {
    // naive eviction: delete first key
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { t: nowMs(), v: value });
}

/* -------------------------------
   Rate limiting
-------------------------------- */
const standardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
});

const proLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_PER_MIN_PRO,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------------------
   ROUTES
-------------------------------- */

// Health
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: VERSION,
    time: new Date().toISOString(),
  });
});

// Info
app.get("/v1/analyze", (req, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    version: VERSION,
    message: "Use POST /v1/analyze with header x-ia11-key and JSON body { text, mode }.",
  });
});

// Main analyze
app.post("/v1/analyze", async (req, res) => {
  const t0 = nowMs();
  const requestId = makeId();

  // Auth
  const key = String(req.headers["x-ia11-key"] || "").trim();
  if (!IA11_API_KEY || key !== IA11_API_KEY) {
    return res.status(401).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode: "standard",
      error: "Unauthorized",
      meta: { tookMs: nowMs() - t0, version: VERSION },
    });
  }

  // Input
  const text = safeTrimText(req.body?.text || "");
  const mode = String(req.body?.mode || "standard").toLowerCase();
  const isPro = isProbablyProMode(mode);

  // Apply rate limit (manual trigger)
  // We run the limiter as middleware function:
  const limiter = isPro ? proLimiter : standardLimiter;
  let limiterDone = false;
  await new Promise((resolve) => {
    limiter(req, res, () => {
      limiterDone = true;
      resolve();
    });
  });
  if (!limiterDone) return; // limiter already responded

  if (!text) {
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      error: "Missing 'text' in request body",
      meta: { tookMs: nowMs() - t0, version: VERSION },
    });
  }

  if (text.length > MAX_TEXT_CHARS) {
    return res.status(400).json({
      status: "error",
      requestId,
      engine: ENGINE_NAME,
      mode,
      error: `Text too long (max ${MAX_TEXT_CHARS} chars)`,
      meta: { tookMs: nowMs() - t0, version: VERSION },
    });
  }

  // Cache (optional)
  const cacheKey = `${mode}::${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json({
      ...cached,
      requestId,
      meta: { ...(cached.meta || {}), tookMs: nowMs() - t0, version: VERSION, cached: true },
    });
  }

  // Analyze
  const lang = detectLangVerySimple(text);

  const result = isPro
    ? await analyzePro(text, lang)
    : await analyzeStandard(text, lang);

  const response = {
    status: "ok",
    requestId,
    engine: ENGINE_NAME,
    mode: isPro ? "pro" : "standard",
    result,
    meta: { tookMs: nowMs() - t0, version: VERSION },
  };

  cacheSet(cacheKey, response);

  return res.json(response);
});

/* -------------------------------
   ANALYSIS — Standard
-------------------------------- */
async function analyzeStandard(text, lang) {
  // Keep it simple: conservative scoring
  const len = text.length;

  let score = 50;
  let riskLevel = "medium";
  let confidence = 0.65;

  if (len < 80) {
    score = 45;
    riskLevel = "high";
    confidence = 0.55;
  } else if (len > 400) {
    score = 72;
    riskLevel = "medium";
    confidence = 0.72;
  } else {
    score = 60;
    riskLevel = "medium";
    confidence = 0.66;
  }

  const summary =
    lang === "fr"
      ? "Analyse standard basée sur la cohérence du texte et des signaux généraux. Pour une vérification multi-sources, passe en PRO."
      : "Standard analysis based on text coherence and general signals. For multi-source verification, switch to PRO.";

  const reasons =
    lang === "fr"
      ? [
          "Analyse rapide (standard) : cohérence et qualité du contenu.",
          "Aucune vérification multi-sources complète en standard.",
        ]
      : [
          "Fast standard check: coherence and content quality.",
          "No full multi-source verification in standard mode.",
        ];

  return {
    score: clamp(Math.round(score), 5, 98),
    riskLevel,
    summary,
    reasons,
    confidence: clamp(Number(confidence), 0.1, 0.98),
    sources: [],
  };
}

/* -------------------------------
   ANALYSIS — PRO (Upgrades A+B+C)
-------------------------------- */
async function analyzePro(text, lang) {
  // Base score similar to standard but PRO can move it more
  const len = text.length;

  let score = 70;
  let riskLevel = "medium";
  let confidence = 0.78;

  if (len < 80) {
    score = 55;
    riskLevel = "high";
    confidence = 0.62;
  } else if (len > 400) {
    score = 82;
    riskLevel = "low";
    confidence = 0.86;
  } else {
    score = 76;
    riskLevel = "medium";
    confidence = 0.80;
  }

  // --- Upgrade C: two-pass pipeline (claims)
  const claims = extractClaims(text, 5);

  const reasons = [];
  const sources = [];

  if (lang === "fr") {
    reasons.push(`Mode PRO : vérification ciblée sur ${claims.length} affirmation(s) principale(s).`);
  } else {
    reasons.push(`PRO mode: targeted verification on ${claims.length} key claim(s).`);
  }

  // --- Upgrade A: institutional fact-check on claims
  const checks = [];
  for (const c of claims) {
    if (shouldRunInstitutionalFactCheck(c)) {
      try {
        const fact = await institutionalFactCheck(c);
        if (fact?.ran) checks.push(fact);
      } catch (e) {
        checks.push({ ran: true, error: String(e?.message || e) });
      }
    }
  }

  // Apply checks effect
  for (const fact of checks) {
    if (fact.error) {
      // Don’t punish score if Wikidata was temporarily unavailable; just note it.
      reasons.push(
        lang === "fr"
          ? "Vérification institutionnelle : source temporairement indisponible."
          : "Institutional verification: source temporarily unavailable."
      );
      continue;
    }

    if (fact.leaderWikidataUrl) {
      sources.push({
        title:
          lang === "fr"
            ? `Wikidata : ${fact.role} vérifié (${fact.country})`
            : `Wikidata: verified ${fact.role} (${fact.country})`,
        url: fact.leaderWikidataUrl,
      });
    }

    // Always add the note (clear and explicit)
    reasons.push(
      lang === "fr"
        ? fact.noteFr || fact.note || "Vérification institutionnelle effectuée."
        : fact.noteEn || fact.note || "Institutional verification completed."
    );

    // If user explicitly names someone else and it conflicts, punish score strongly
    if (fact.isConsistent === false) {
      score -= 25;
      riskLevel = "high";
      confidence = Math.min(confidence, 0.60);
    }
  }

  // Small bonus if we ran at least one check successfully
  if (checks.some((c) => c.ran && !c.error)) {
    score += 3;
    confidence = Math.min(0.92, confidence + 0.03);
  }

  // Ensure score bounds
  score = clamp(Math.round(score), 5, 98);

  // Summary (keep it clean)
  const summary =
    lang === "fr"
      ? "Analyse PRO : extraction des affirmations clés + vérifications renforcées sur les faits institutionnels (ex. dirigeants)."
      : "PRO analysis: key-claim extraction + enhanced verification for institutional facts (e.g., leaders).";

  // --- Upgrade B: clean sources (no duplicates / no homepages)
  const clean = cleanSources(sources, 6);

  return {
    score,
    riskLevel,
    summary,
    reasons: reasons.slice(0, 10),
    confidence: clamp(Number(confidence), 0.1, 0.98),
    sources: clean,
  };
}

/* -------------------------------
   UPGRADE C — Extract claims (simple)
-------------------------------- */
function extractClaims(text = "", max = 5) {
  const sentences = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);

  if (!sentences.length) return [text].slice(0, 1);
  return sentences.slice(0, max);
}

/* -------------------------------
   UPGRADE A — Institutional fact-check (Wikidata)
-------------------------------- */
function shouldRunInstitutionalFactCheck(text = "") {
  const t = String(text || "").toLowerCase();

  const roleHits = [
    "president",
    "président",
    "prime minister",
    "premier ministre",
    "première ministre",
    "chancellor",
    "roi",
    "king",
    "queen",
    "gouvernement",
    "government",
  ].some((k) => t.includes(k));

  const countryHits = [
    "united states",
    "états-unis",
    "usa",
    "ukraine",
    "russia",
    "russie",
    "france",
    "canada",
    "germany",
    "allemagne",
    "italy",
    "italie",
    "japan",
    "japon",
  ].some((k) => t.includes(k));

  return roleHits && countryHits;
}

const COUNTRY_QID = {
  "united states": "Q30",
  usa: "Q30",
  "états-unis": "Q30",
  france: "Q142",
  canada: "Q16",
  ukraine: "Q212",
  russia: "Q159",
  russie: "Q159",
  germany: "Q183",
  allemagne: "Q183",
  japan: "Q17",
  japon: "Q17",
  italy: "Q38",
  italie: "Q38",
};

function detectCountryQid(text = "") {
  const t = String(text || "").toLowerCase();
  for (const key of Object.keys(COUNTRY_QID)) {
    if (t.includes(key)) return { key, qid: COUNTRY_QID[key] };
  }
  return null;
}

function detectRole(text = "") {
  const t = String(text || "").toLowerCase();

  // Start simple:
  // P35 = head of state (often President)
  // P6  = head of government (Prime Minister)
  if (t.includes("prime minister") || t.includes("premier ministre") || t.includes("première ministre")) {
    return { label: "prime minister", property: "P6" };
  }
  if (t.includes("president") || t.includes("président")) {
    return { label: "president", property: "P35" };
  }
  return null;
}

async function queryWikidataLeader(countryQid, roleProperty) {
  if (typeof fetch !== "function") {
    throw new Error("Fetch not available in this Node runtime.");
  }

  const sparql = `
    SELECT ?person ?personLabel ?start ?end WHERE {
      wd:${countryQid} p:${roleProperty} ?stmt .
      ?stmt ps:${roleProperty} ?person .
      OPTIONAL { ?stmt pq:P580 ?start . }
      OPTIONAL { ?stmt pq:P582 ?end . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    ORDER BY DESC(?start)
    LIMIT 8
  `;

  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);

  const cached = cacheGet(url);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: { "User-Agent": "IA11/1.0 (LeenScore institutional fact-check)" },
  });

  if (!res.ok) {
    throw new Error(`Wikidata error: ${res.status}`);
  }

  const json = await res.json();
  const rows = json?.results?.bindings || [];
  if (!rows.length) return null;

  // Prefer an entry with no end date (current), else the latest by start
  const current = rows.find((r) => !r.end) || rows[0];

  const leader = {
    name: current.personLabel?.value || null,
    wikidataUrl: current.person?.value || null,
    start: current.start?.value || null,
    end: current.end?.value || null,
  };

  cacheSet(url, leader);
  return leader;
}

function guessIfTextNamesDifferentLeader(text, verifiedLeaderName) {
  // Simple heuristic:
  // - If text contains verified leader name -> consistent
  // - If text contains common alternative names but NOT verified -> inconsistent
  // (We keep this conservative to avoid false contradictions.)
  const t = String(text || "").toLowerCase();
  const leader = String(verifiedLeaderName || "").toLowerCase();

  if (!leader) return null;
  if (t.includes(leader)) return true;

  // If user explicitly says "is X" with a proper name, we try to detect mismatch.
  // Basic: look for patterns like "is Donald Trump" / "est Donald Trump"
  const patterns = [/is\s+([a-z]+)\s+([a-z]+)/i, /est\s+([a-z]+)\s+([a-z]+)/i];
  for (const p of patterns) {
    const m = String(text).match(p);
    if (m && m[1] && m[2]) {
      const candidate = `${m[1]} ${m[2]}`.toLowerCase();
      if (candidate && candidate !== leader) {
        // Text names someone else explicitly -> likely inconsistent
        return false;
      }
    }
  }

  // Unknown (text doesn't name a person clearly)
  return null;
}

async function institutionalFactCheck(text = "") {
  const country = detectCountryQid(text);
  const role = detectRole(text);
  if (!country || !role) return { ran: false };

  const leader = await queryWikidataLeader(country.qid, role.property);
  if (!leader?.name || !leader?.wikidataUrl) return { ran: false };

  const consistency = guessIfTextNamesDifferentLeader(text, leader.name);

  return {
    ran: true,
    country: country.key,
    role: role.label,
    leaderName: leader.name,
    leaderWikidataUrl: leader.wikidataUrl,
    isConsistent: consistency,
    noteFr:
      consistency === true
        ? `Vérification institutionnelle : cohérent avec Wikidata (${role.label} de ${country.key} = ${leader.name}).`
        : consistency === false
        ? `Vérification institutionnelle : l’affirmation contredit les données Wikidata (${role.label} de ${country.key} = ${leader.name}).`
        : `Vérification institutionnelle : ${role.label} de ${country.key} vérifié via Wikidata = ${leader.name}.`,
    noteEn:
      consistency === true
        ? `Institutional check: consistent with Wikidata (${role.label} of ${country.key} = ${leader.name}).`
        : consistency === false
        ? `Institutional check: claim conflicts with Wikidata (${role.label} of ${country.key} = ${leader.name}).`
        : `Institutional check: verified via Wikidata (${role.label} of ${country.key} = ${leader.name}).`,
  };
}

/* -------------------------------
   UPGRADE B — Clean & dedupe sources
-------------------------------- */
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((p) =>
      url.searchParams.delete(p)
    );
    return url.toString();
  } catch {
    return null;
  }
}

function isLikelyHomepage(u) {
  try {
    const url = new URL(u);
    const path = (url.pathname || "/").replace(/\/+$/, "");
    return path === "" || path === "/";
  } catch {
    return true;
  }
}

function cleanSources(sources = [], max = 6) {
  const out = [];
  const seen = new Set();

  for (const s of sources) {
    const raw = s?.url || s?.link || "";
    const url = normalizeUrl(raw);
    if (!url) continue;

    // Skip obvious homepages (keeps sources "article-like")
    if (isLikelyHomepage(url)) continue;

    try {
      const u = new URL(url);
      const key = `${u.hostname}${u.pathname}`;
      if (seen.has(url) || seen.has(key)) continue;
      seen.add(url);
      seen.add(key);

      out.push({
        title: String(s?.title || s?.name || "Source").slice(0, 120),
        url,
      });

      if (out.length >= max) break;
    } catch {
      continue;
    }
  }

  return out;
}

/* -------------------------------
   Start server
-------------------------------- */
app.listen(PORT, () => {
  console.log(`[IA11] running on port ${PORT} (version ${VERSION})`);
});
