const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Vérifie la clé API
const requireApiKey = (req, res, next) => {
  const expected = process.env.IA11_API_KEY;
  const provided = req.headers["x-ia11-key"];

  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// Limites anti-abus
const limiterStandard = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 30),
});

const limiterPro = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN_PRO || 5 ),
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("IA11 API is running");
});
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
      reasons: [
        "Multiple sources detected",
        "No major contradictions found"
      ],
      sources: [],
      status: "success"
    });
  }
);


  res.json({
    engine: "IA11",
    score: 72,
    verdict: "medium credibility",
    reasons: [
      "Multiple sources detected",
      "No major contradictions found"
    ],
    sources: [],
    status: "success"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("IA11 API listening on port", PORT);
});
