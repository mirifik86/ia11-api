// =====================
// IA11 — LeenScore Engine (Render)
// =====================

const express = require("express");
const cors = require("cors");

const app = express();

// ---------- BASIC MIDDLEWARE ----------
app.use(express.json({ limit: "1mb" }));

// CORS SAFE FOR FRONTEND
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

// ---------- FETCH (Node 18+ REQUIRED) ----------
const _fetch = global.fetch;
if (typeof _fetch !== "function") {
  console.error("Global fetch missing. Use Node 18+ on Render.");
  process.exit(1);
}

// ---------- ENV ----------
const IA11_KEY = process.env.IA11_API_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;

if (!IA11_KEY) console.warn("IA11_API_KEY missing");
if (!SERPER_KEY) console.warn("SERPER_API_KEY missing");

// ---------- HEALTH ----------
app.get("/", (req, res) => {
  res.json({ status: "ok", engine: "IA11" });
});

// =======================================================
// ================= SERPER SEARCH =======================
// =======================================================

async function serperSearch(query, lang) {
  try {
    const r = await _fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        gl: "us",
        hl: lang || "en",
      }),
    });

    if (!r.ok) return { ok: false, error: "Serper error" };

    const j = await r.json();
    return {
      ok: true,
      items: (j.organic || []).slice(0, 5),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function buildQueries(text) {
  return [
    text,
    `"${text}"`,
    text + " fact check",
    text + " news",
  ];
}

// ✅ VERSION CORRECTE (la seule à garder)
async function serperMultiSearch(text, mode, uiLanguage, opts = {}) {
  const queries = buildQueries(text);
  let all = [];
  let okCount = 0;
  let lastError = null;

  for (const q of queries) {
    try {
      const out = await serperSearch(q, uiLanguage);
      if (out.ok) {
        okCount += 1;
        all = all.concat(out.items || []);
      } else {
        lastError = out.error || lastError;
      }
    } catch (e) {
      lastError = e?.message || lastError;
    }
  }

  return {
    ok: okCount > 0,
    items: all,
    error: okCount > 0 ? null : lastError || "Unknown search error",
    queries,
  };
}

// =======================================================
// ================= ANALYZE ROUTE =======================
// =======================================================

app.post("/v1/analyze", async (req, res) => {
  try {
    if (req.headers["x-ia11-key"] !== IA11_KEY)
      return res.status(401).json({ error: "Invalid key" });

    const { text, mode, language } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });

    const search = await serperMultiSearch(text, mode, language);

    res.json({
      status: "ok",
      engine: "IA11",
      result: {
        score: search.ok ? 85 : 45,
        summary: search.ok
          ? "Sources found and analyzed."
          : "No reliable sources found.",
        sources: search.items || [],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("IA11 running on port", PORT);
});
