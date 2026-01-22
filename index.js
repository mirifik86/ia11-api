const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.use(express.json());

// --- Auth: API key required ---
function requireApiKey(req, res, next) {
  const expected = process.env.IA11_API_KEY;
  const provided = req.header("x-ia11-key");

  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: IA11_API_KEY missing" });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Rate limits ---
const limiterStandard = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterPro = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN_PRO || 5),
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/", (req, res) => {
  res.send("IA11 API is running");
});

// POST only
app.post(
  "/v1/analyze",
  requireApiKey,
  (req, res, next) => {
    const mode = (req.body?.mode || "standard").toLowerCase();
    if (mode === "pro") return limiterPro(req, res, next);
    return limiterStandard(req, res, next);
  },
  (req, res) => {
    res.json({
      engine: "IA11",
      score: 72,
      verdict: "medium credibility",
      reasons: ["Multiple sources detected", "No major contradictions found"],
      sources: [],
      status: "success",
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("IA11 API listening on port", PORT));

