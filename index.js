const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- Helpers ---
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

// --- Auth: API key required ---
function requireApiKey(req, res, next) {
  const expected = process.env.IA11_API_KEY;
  const provided = req.header("x-ia11-key");

  if (!expected) {
    return res.status(500).json({
      status: "error",
      error: { code: "MISCONFIGURED", message: "IA11_API_KEY is missing on server" },
    });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({
      status: "error",
      error: { code: "UNAUTHORIZED", message: "Missing or invalid API key" },
    });
  }
  next();
}

// --- Rate limits (Standard < Pro) ---
const limiterStandard = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 10),
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterPro = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN_PRO || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Basic routes ---
app.get("/", (req, res) => {
  res.send("IA11 API is running");
});

// So your browser test doesn't say "Cannot GET"
app.get("/v1/analyze", (req, res) => {
  res.send("OK. Use POST /v1/analyze with JSON { text, mode } and header x-ia11-key.");
});

// --- Main endpoint ---
app.post(
  "/v1/analyze",
  requireApiKey,
  (req, res, next) => {
    const mode = normalizeMode(req.body?.mode);
    req._ia11Mode = mode;

    // Premium tiers use the "pro" limiter for now (simple + safe)
    if (mode === "pro" || mode === "premium" || mode === "premium_plus") return limiterPro(req, res, next);
    return limiterStandard(req, res, next);
  },
  (req, res) => {
    const started = nowMs();
    const requestId = makeId();

    const mode = req._ia11Mode || "standard";
    const text = String(req.body?.text || "").trim();

    if (!text) {
      return res.status(400).json({
        status: "error",
        requestId,
        engine: "IA11",
        mode,
        error: { code: "INVALID_INPUT", message: "Missing text" },
      });
    }

    // --- MOCK analysis for now (stable contract) ---
    // Later: replace only this part with real IA11 logic, keep the same output shape.
    const response = {
      status: "success",
      requestId,
      engine: "IA11",
      mode,
      result: {
        score: text.length < 80 ? 45 : 85,
        riskLevel: text.length < 80 ? "high" : "low",
        summary: "Simple IA11 test scoring (length-based).",
        reasons: [text.length < 80 ? "Text too short." : "Text has enough context."],
        confidence: text.length < 80 ? 0.55 : 0.88,

      sources: [
            { url: "https://example.com/source1", title: "Example source 1", publisher: "Example", trustBadge: "medium" },
            { url: "https://example.com/source1", title: "Example source 1 (duplicate)", publisher: "Example", trustBadge: "medium" },
            { url: "https://example.com/source2", title: "Example source 2", publisher: "Example", trustBadge: "high" }
              ].filter((s, i, arr) => arr.findIndex(x => x.url === s.url) === i),

      },
      meta: {
        tookMs: nowMs() - started,
        version: "v1",
      },
    };

    return res.json(response);
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("IA11 API listening on port", PORT));
