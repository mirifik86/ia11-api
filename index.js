const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();

/* -----------------------------
   Config (safe defaults)
------------------------------ */
const PORT = process.env.PORT || 3000;

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 6000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const CACHE_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS || 500);

const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30);

// Optional: allowlist CORS origins (comma-separated). If empty, allow all.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* -----------------------------
   Middleware
------------------------------ */
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

/* -----------------------------
   Helpers
------------------------------ */
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

function normalizeMode(mode) {
  const m = String(mode || "standard").toLowerCase();
  const allowed = new Set(["standard", "pro", "premium", "premium_plus"]);
  return allowed.has(m) ? m : "standard";
}

function normalizeText(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, " ");
}

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function responseOk({ requestId, mode, result, meta }) {
  return {
    status: "ok",
    requestId,
    engine: "IA11",
    mode,
    result,
    meta,
  };
}

function responseError({ requestId, mode, httpCode, code, message, meta }) {
  return {
    httpCode: httpCode || 500,
    body: {
      status: "error",
      requestId,
      engine: "IA11",
      mode,
      error: { code: code || "ERROR", message: message || "Unknown error" },
      meta,
    },
  };
}

/* -----------------------------
   Auth: API key required
------------------------------ */
function requireApiKey(req, res, next) {
  const expected = process.env.IA11_API_KEY;
  const provided = req.header("x-ia11-key");

  if (!expected) {
    const out = responseError({
      requestId: makeId(),
      mode: "standard",
      httpCode: 500,
      code: "MISCONFIGURED",
      message: "IA11_API_KEY is missing on server",
      meta: { tookMs: 0, version: "v1" },
    });
    return res.status(out.httpCode).json(out.body);
  }

  if (!provided || provided !== expected) {
    const out = responseError({
      requestId: makeId(),
      mode: "standard",
      httpCode: 401,
      code: "UNAUTHORIZED",
      message: "Missing or invalid API key",
      meta: { tookMs: 0, version: "v1" },
    });
    return res.status(out.httpCode).json(out.body);
  }

  next();
}

/* -----------------------------
   Rate limiters (by IP)
------------------------------ */
const limiterStandard = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:standard`,
});

const limiterPro = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_PER_MIN_PRO,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:pro`,
});

/* -----------------------------
   Cache (in-memory)
------------------------------ */
const cache = new Map(); // key -> { expiresAt, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  // simple cap
  if (cache.size >= CACHE_MAX_ITEMS) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { expiresAt: nowMs() + CACHE_TTL_MS, value });
}

/* -----------------------------
   Sources helpers (dedup)
------------------------------ */
function toHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function dedupSourcesByUrlAndDomain(sources) {
  const seenUrl = new Set();
  const seenDomain = new Set();
  const out = [];

  for (const s of sources || []) {
    const url = String(s.url || "").trim();
    if (!url) continue;

    const domain = toHostname(url);
    if (!domain) continue;

    if (seenUrl.has(url)) continue;
    if (seenDomain.has(domain)) continue;

    seenUrl.add(url);
    seenDomain.add(domain);

    out.push({
      title: String(s.title || "").trim() || domain,
      publisher: String(s.publisher || "").trim() || domain,
      url,
      trustTier: s.trustTier === "high" || s.trustTier === "medium" || s.trustTier === "low" ? s.trustTier : "medium",
      stance:
        s.stance === "corroborating" || s.stance === "neutral" || s.stance === "contradicting"
          ? s.stance
          : "neutral",
      whyItMatters: String(s.whyItMatters || "").trim(),
    });
  }

  return out;
}

/* -----------------------------
   Routes
------------------------------ */
app.get("/", (req, res) => res.send("IA11 API is running"));

app.get("/v1/analyze", (req, res) => {
  res.send("OK. Use POST /v1/analyze with JSON { text, mode } and header x-ia11-key.");
});

/* -----------------------------
   Main endpoint
------------------------------ */
app.post(
  "/v1/analyze",
  requireApiKey,
  (req, res, next) => {
    const mode = normalizeMode(req.body?.mode);
    req._ia11Mode = mode;

    if (mode === "pro" || mode === "premium" || mode === "premium_plus") return limiterPro(req, res, next);
    return limiterStandard(req, res, next);
  },
  async (req, res) => {
    const started = nowMs();
    const requestId = makeId();
    const mode = req._ia11Mode || "standard";

    try {
      const rawText = req.body?.text;
      const text = normalizeText(rawText);

      if (!text) {
        const out = responseError({
          requestId,
          mode,
          httpCode: 400,
          code: "INVALID_INPUT",
          message: "Missing text",
          meta: { tookMs: nowMs() - started, version: "v1" },
        });
        return res.status(out.httpCode).json(out.body);
      }

      if (text.length > MAX_TEXT_CHARS) {
        const out = responseError({
          requestId,
          mode,
          httpCode: 413,
          code: "TEXT_TOO_LONG",
          message: `Text too long (max ${MAX_TEXT_CHARS} characters)`,
          meta: { tookMs: nowMs() - started, version: "v1" },
        });
        return res.status(out.httpCode).json(out.body);
      }

      // Cache key: normalizedText + mode
      const cacheKey = sha256(`${mode}:${text}`);
      const cached = cacheGet(cacheKey);
      if (cached) {
        return res.json(
          responseOk({
            requestId,
            mode,
            result: cached.result,
            meta: { ...cached.meta, tookMs: nowMs() - started, version: "v1", cacheHit: true },
          })
        );
      }

      /* -------------------------------------------------------
         TODO: Replace ONLY this block with your real IA11 logic.
         Keep the output structure unchanged.
      -------------------------------------------------------- */

      // MOCK scoring (stable contract)
      const score = text.length < 80 ? 45 : 85;
      const riskLevel = text.length < 80 ? "high" : "low";
      const confidence = text.length < 80 ? 0.55 : 0.88;

      // MOCK sources (replace later with real web sources)
      const rawSources = [
        {
          url: "https://example.com/source1",
          title: "Example source 1",
          publisher: "Example",
          trustTier: "medium",
          stance: "neutral",
          whyItMatters: "Example placeholder source.",
        },
        {
          url: "https://example.com/source1",
          title: "Example source 1 (duplicate)",
          publisher: "Example",
          trustTier: "medium",
          stance: "neutral",
          whyItMatters: "Duplicate URL should be removed.",
        },
        {
          url: "https://example.com/source2",
          title: "Example source 2",
          publisher: "Example",
          trustTier: "high",
          stance: "corroborating",
          whyItMatters: "Higher trust example placeholder.",
        },
      ];

      const sources = dedupSourcesByUrlAndDomain(rawSources).slice(0, 10);
      const bestLinks = sources.slice(0, 4); // must be subset of sources

      const result = {
        score,
        riskLevel,
        summary: "IA11 mock analysis (replace with real engine).",
        confidence,
        bestLinks,
        sources,
      };

      const meta = {
        tookMs: nowMs() - started,
        version: "v1",
        degraded: false,
        cacheHit: false,
      };

      const payload = responseOk({ requestId, mode, result, meta });

      // Cache the result (store without requestId/tookMs)
      cacheSet(cacheKey, { result, meta });

      return res.json(payload);
    } catch (err) {
      const out = responseError({
        requestId,
        mode,
        httpCode: 500,
        code: "INTERNAL_ERROR",
        message: "IA11 failed to process the request",
        meta: { tookMs: nowMs() - started, version: "v1", degraded: true },
      });
      return res.status(out.httpCode).json(out.body);
    }
  }
);

app.listen(PORT, () => console.log("IA11 API listening on port", PORT));
