const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("IA11 API is running");
});

app.post("/v1/analyze", (req, res) => {
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
