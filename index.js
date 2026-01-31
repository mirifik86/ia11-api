/** 
 * IA11 API (LeenScore) — index.js (Ultra PRO, "living" analysis)
 *
 * Promise:
 * - Same v1 response contract (stable for LeenScore)
 * - Much smarter scoring (multi-signal + claim extraction)
 * - Language-aware output (matches UI / user language)
 * - PRO mode: real web evidence via provider (Bing by default if key present)
 * - Conservative truth assertions: never confidently claim "false" on weak evidence
 */

import express from "express";
import cors from "cors";
import crypto from "crypto";

// --------------------------
// Env
// --------------------------

const ENGINE_NAME = "IA11";
const ENGINE_VERSION = "1.3.0-beton-arme";
const IA11_API_KEY = process.env.IA11_API_KEY || "";
const WEB_PROVIDER = (process.env.WEB_PROVIDER || "bing").toLowerCase();
const BING_API_KEY = process.env.BING_API_KEY || "";
const BING_ENDPOINT = process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_LIMIT_PER_MIN_PRO = Number(process.env.RATE_LIMIT_PER_MIN_PRO || 60);

// IMPORTANT: In production, set a comma-separated allowlist:
// CORS_ORIGIN="https://solairleens.lovable.app,https://leenscore.com,https://www.leenscore.com"
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

const NOW = new Date();
const NOW_YEAR = NOW.getUTCFullYear();

// --------------------------
// App
// --------------------------

const app = express();

app.set("trust proxy", 1);

// Basic security headers (lightweight, production-friendly)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// CORS allowlist
const ALLOWED_ORIGINS = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl / no-origin requests
      if (!origin) return cb(null, true);

      // If allowlist not set: strict in production, permissive in dev
      if (ALLOWED_ORIGINS.length === 0) {
        if ((process.env.NODE_ENV || "").toLowerCase() !== "production") return cb(null, true);
        return cb(new Error("CORS blocked"));
      }

      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-ia11-key", "x-tier", "x-lang"],
  })
);

app.use(express.json({ limit: "1mb" }));

// --------------------------
// Tiny in-memory rate limiter
// --------------------------

const rateMap = new Map(); // key -> { windowStart, count }

function getClientId(req) {
  // Prefer key-based limiting (stable) but never store/log the raw key
  const rawKey = (req.headers["x-ia11-key"] || "").toString().trim();
  if (rawKey) {
    return "k:" + crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
  }

  // Fallback to real client IP (trust proxy enabled)
  const xff = (req.headers["x-forwarded-for"] || "").toString();
  const ipFromXff = xff.split(",")[0].trim();
  const ip = ipFromXff || req.ip || "unknown";
  return "ip:" + ip;
}

function rateLimit(req, res, next) {
  const tier = (req.headers["x-tier"] || "standard").toString().toLowerCase();
  const limit = tier === "pro" || tier === "premium" || tier === "premium_plus" ? RATE_LIMIT_PER_MIN_PRO : RATE_LIMIT_PER_MIN;

  const clientId = getClientId(req);
  const key = `${clientId}:${tier}`;
  const now = Date.now();
  const windowMs = 60_000;

  const entry = rateMap.get(key) || { windowStart: now, count: 0 };

  if (now - entry.windowStart >= windowMs) {
    entry.windowStart = now;
    entry.count = 0;
  }

  entry.count += 1;
  rateMap.set(key, entry);

  if (entry.count > limit) {
    return res.status(429).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 20,
        riskLevel: "high",
        summary: "Rate limit exceeded.",
        reasons: ["Too many requests in a short period."],
        confidence: 0.5,
        sources: [],
      },
      meta: { tookMs: 0, version: ENGINE_VERSION },
    });
  }

  return next();
}

// --------------------------
// Auth
// --------------------------

function requireKey(req, res, next) {
  const key = req.headers["x-ia11-key"];
  if (!IA11_API_KEY || key !== IA11_API_KEY) {
    return res.status(401).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: "standard",
      result: {
        score: 15,
        riskLevel: "high",
        summary: "Unauthorized.",
        reasons: ["Missing or invalid x-ia11-key."],
        confidence: 0.5,
        sources: [],
      },
      meta: { tookMs: 0, version: ENGINE_VERSION },
    });
  }
  return next();
}

// --------------------------
// Utils
// --------------------------

function requestId() {
  return crypto.randomBytes(8).toString("hex");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeLower(s) {
  return String(s || "").toLowerCase();
}

function safeLen(s) {
  return String(s || "").length;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function urlDomain(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function looksLikeHomeOrSection(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "/").replace(/\/+$/, "/");
    // very short paths are often home/section pages
    if (p === "/" || p.length <= 2) return true;
    // common “section” patterns
    const sections = ["/news/", "/politics/", "/world/", "/us/", "/canada/", "/france/", "/en/", "/articles/", "/story/"];
    const hits = sections.some((s) => p.toLowerCase().startsWith(s));
    return hits && p.split("/").filter(Boolean).length <= 2;
  } catch {
    return true;
  }
}

function cleanSources(sources) {
  const cleaned = (sources || [])
    .filter((s) => s && s.url)
    .map((s) => ({
      name: String(s.name || "").slice(0, 140),
      url: String(s.url || ""),
      snippet: String(s.snippet || "").slice(0, 260),
      domain: urlDomain(s.url),
    }));

  // Deduplicate by URL
  const dedup = uniqBy(cleaned, (x) => x.url);

  // Prefer deeper article URLs over home/section pages
  dedup.sort((a, b) => Number(looksLikeHomeOrSection(a.url)) - Number(looksLikeHomeOrSection(b.url)));

  // Remove duplicates by domain if they are too many
  const byDomain = [];
  const domainCount = new Map();
  for (const s of dedup) {
    const d = s.domain || "unknown";
    const c = (domainCount.get(d) || 0) + 1;
    domainCount.set(d, c);
    if (c <= 2) byDomain.push(s);
  }

  return byDomain.slice(0, 8);
}

function normalizeLang(x) {
  if (!x) return "";
  const v = x.toString().toLowerCase();
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  if (v.startsWith("es")) return "es";
  if (v.startsWith("de")) return "de";
  if (v.startsWith("it")) return "it";
  if (v.startsWith("pt")) return "pt";
  if (v.startsWith("ja")) return "ja";
  if (v.startsWith("ru")) return "ru";
  if (v.startsWith("uk")) return "uk";
  return v.slice(0, 2);
}

function detectLanguage(text) {
  const s = (text || "").toLowerCase();

  // crude heuristic; UI will override via x-lang anyway
  if (/[а-яё]/i.test(s)) return "ru";
  if (/[ぁ-んァ-ン一-龯]/.test(s)) return "ja";

  if (/[àâçéèêëîïôùûüÿœ]/.test(s)) return "fr";
  if (/[ñáéíóúü¡¿]/.test(s)) return "es";
  if (/[ßäöü]/.test(s)) return "de";
  if (/[àèéìòù]/.test(s)) return "it";
  if (/[ãõç]/.test(s)) return "pt";
  if (/[\u0400-\u04FF]/.test(s)) return "ru";
  return "en";
}

// --------------------------
// I18N (9 languages)
// --------------------------

const I18N = {
  en: {
    server_error_summary: "Server error during analysis.",
    server_error_reason: "An internal error occurred.",
    sig_caps: "High uppercase usage can indicate sensational framing.",
    sig_exclam: "Many exclamation marks can indicate emotional framing.",
    sig_allcaps: "ALL-CAPS words can reduce credibility.",
    sig_many_links: "Multiple links without context can be a credibility red flag.",
    sig_no_claims: "No clear, verifiable claim detected.",
    sig_many_claims: "Many claims at once makes verification harder.",
    sig_some_claims: "Some verifiable claims detected.",
    sig_time_sensitive: "Time-sensitive claim: standard mode can’t verify reliably without web evidence.",
    sig_pro_no_web: "PRO requested but web verification is not available (missing provider/key).",
    sig_web_support: "Multiple sources appear to support the claim.",
    sig_web_contradict: "Multiple sources appear to contradict the claim.",
    sig_web_uncertain: "Sources found, but evidence is not strong enough to confirm or refute.",
    sig_web_mixed: "Sources are mixed or unclear; result stays conservative.",
    summary_standard: "Credibility risk: {risk}. {top}",
    summary_pro_supported: "Credibility risk: {risk}. Web evidence tends to support the claim. {top}",
    summary_pro_contradicted: "Credibility risk: {risk}. Web evidence tends to contradict the claim. {top}",
    summary_pro_uncertain: "Credibility risk: {risk}. Web evidence is inconclusive or mixed. {top}",
    no_reasons: "No strong signals detected.",
  },

  fr: {
    server_error_summary: "Erreur serveur pendant l’analyse.",
    server_error_reason: "Une erreur interne est survenue.",
    sig_caps: "Beaucoup de majuscules peut indiquer un ton sensationnaliste.",
    sig_exclam: "Beaucoup de points d’exclamation peut indiquer un ton émotionnel.",
    sig_allcaps: "Des mots en MAJUSCULES peuvent réduire la crédibilité.",
    sig_many_links: "Plusieurs liens sans contexte peuvent être un signal faible.",
    sig_no_claims: "Aucune affirmation claire et vérifiable détectée.",
    sig_many_claims: "Trop d’affirmations à la fois rend la vérification difficile.",
    sig_some_claims: "Quelques affirmations vérifiables détectées.",
    sig_time_sensitive: "Affirmation sensible au temps : sans web, le mode standard ne peut pas confirmer.",
    sig_pro_no_web: "PRO demandé mais la vérification web n’est pas disponible (clé/provider manquant).",
    sig_web_support: "Plusieurs sources semblent corroborer l’affirmation.",
    sig_web_contradict: "Plusieurs sources semblent contredire l’affirmation.",
    sig_web_uncertain: "Des sources existent, mais la preuve est insuffisante pour trancher.",
    sig_web_mixed: "Sources mixtes ou floues : résultat conservateur.",
    summary_standard: "Risque de crédibilité : {risk}. {top}",
    summary_pro_supported: "Risque de crédibilité : {risk}. Les sources web tendent à corroborer. {top}",
    summary_pro_contradicted: "Risque de crédibilité : {risk}. Les sources web tendent à contredire. {top}",
    summary_pro_uncertain: "Risque de crédibilité : {risk}. Les sources web sont mitigées ou insuffisantes. {top}",
    no_reasons: "Aucun signal fort détecté.",
  },

  es: {
    server_error_summary: "Error del servidor durante el análisis.",
    server_error_reason: "Ocurrió un error interno.",
    sig_caps: "El exceso de mayúsculas puede sonar sensacionalista.",
    sig_exclam: "Demasiados signos de exclamación pueden sonar emocionales.",
    sig_allcaps: "PALABRAS EN MAYÚSCULAS pueden reducir credibilidad.",
    sig_many_links: "Muchos enlaces sin contexto pueden ser una señal débil.",
    sig_no_claims: "No se detectó una afirmación clara y verificable.",
    sig_many_claims: "Demasiadas afirmaciones a la vez dificultan la verificación.",
    sig_some_claims: "Se detectaron algunas afirmaciones verificables.",
    sig_time_sensitive: "Afirmación sensible al tiempo: sin web, el modo estándar no puede confirmar.",
    sig_pro_no_web: "PRO solicitado pero la verificación web no está disponible (proveedor/clave faltante).",
    sig_web_support: "Varias fuentes parecen apoyar la afirmación.",
    sig_web_contradict: "Varias fuentes parecen contradecir la afirmación.",
    sig_web_uncertain: "Hay fuentes, pero la evidencia no es suficiente para concluir.",
    sig_web_mixed: "Fuentes mixtas o poco claras: el resultado se mantiene conservador.",
    summary_standard: "Riesgo de credibilidad: {risk}. {top}",
    summary_pro_supported: "Riesgo de credibilidad: {risk}. La evidencia web tiende a apoyar. {top}",
    summary_pro_contradicted: "Riesgo de credibilidad: {risk}. La evidencia web tiende a contradecir. {top}",
    summary_pro_uncertain: "Riesgo de credibilidad: {risk}. La evidencia web es mixta o insuficiente. {top}",
    no_reasons: "No se detectaron señales fuertes.",
  },

  de: {
    server_error_summary: "Serverfehler während der Analyse.",
    server_error_reason: "Ein interner Fehler ist aufgetreten.",
    sig_caps: "Viele Großbuchstaben können reißerisch wirken.",
    sig_exclam: "Viele Ausrufezeichen können emotional wirken.",
    sig_allcaps: "WÖRTER IN GROSSBUCHSTABEN können die Glaubwürdigkeit senken.",
    sig_many_links: "Viele Links ohne Kontext können ein schwaches Warnsignal sein.",
    sig_no_claims: "Keine klare, überprüfbare Behauptung erkannt.",
    sig_many_claims: "Zu viele Behauptungen auf einmal erschweren die Prüfung.",
    sig_some_claims: "Einige überprüfbare Behauptungen erkannt.",
    sig_time_sensitive: "Zeitkritische Behauptung: ohne Web kann der Standardmodus nicht zuverlässig prüfen.",
    sig_pro_no_web: "PRO angefragt, aber Webprüfung nicht verfügbar (Provider/Key fehlt).",
    sig_web_support: "Mehrere Quellen scheinen die Behauptung zu stützen.",
    sig_web_contradict: "Mehrere Quellen scheinen der Behauptung zu widersprechen.",
    sig_web_uncertain: "Quellen vorhanden, aber Belege reichen nicht für ein Urteil.",
    sig_web_mixed: "Gemischte/unklare Quellenlage: Ergebnis bleibt konservativ.",
    summary_standard: "Glaubwürdigkeitsrisiko: {risk}. {top}",
    summary_pro_supported: "Glaubwürdigkeitsrisiko: {risk}. Web-Belege stützen eher. {top}",
    summary_pro_contradicted: "Glaubwürdigkeitsrisiko: {risk}. Web-Belege widersprechen eher. {top}",
    summary_pro_uncertain: "Glaubwürdigkeitsrisiko: {risk}. Web-Belege sind gemischt oder unzureichend. {top}",
    no_reasons: "Keine starken Signale erkannt.",
  },

  it: {
    server_error_summary: "Errore del server durante l’analisi.",
    server_error_reason: "Si è verificato un errore interno.",
    sig_caps: "Troppe maiuscole possono sembrare sensazionalistiche.",
    sig_exclam: "Troppi punti esclamativi possono sembrare emotivi.",
    sig_allcaps: "PAROLE IN MAIUSCOLO possono ridurre la credibilità.",
    sig_many_links: "Molti link senza contesto possono essere un segnale debole.",
    sig_no_claims: "Nessuna affermazione chiara e verificabile rilevata.",
    sig_many_claims: "Troppe affermazioni insieme rendono la verifica difficile.",
    sig_some_claims: "Alcune affermazioni verificabili rilevate.",
    sig_time_sensitive: "Affermazione sensibile al tempo: senza web, la modalità standard non può confermare.",
    sig_pro_no_web: "PRO richiesto ma la verifica web non è disponibile (provider/chiave mancante).",
    sig_web_support: "Più fonti sembrano supportare l’affermazione.",
    sig_web_contradict: "Più fonti sembrano contraddire l’affermazione.",
    sig_web_uncertain: "Fonti trovate, ma prove insufficienti per decidere.",
    sig_web_mixed: "Fonti miste o poco chiare: risultato conservativo.",
    summary_standard: "Rischio di credibilità: {risk}. {top}",
    summary_pro_supported: "Rischio di credibilità: {risk}. Le prove web tendono a supportare. {top}",
    summary_pro_contradicted: "Rischio di credibilità: {risk}. Le prove web tendono a contraddire. {top}",
    summary_pro_uncertain: "Rischio di credibilità: {risk}. Le prove web sono miste o insufficienti. {top}",
    no_reasons: "Nessun segnale forte rilevato.",
  },

  pt: {
    server_error_summary: "Erro do servidor durante a análise.",
    server_error_reason: "Ocorreu um erro interno.",
    sig_caps: "Muitas letras maiúsculas podem soar sensacionalistas.",
    sig_exclam: "Muitos pontos de exclamação podem soar emocionais.",
    sig_allcaps: "PALAVRAS EM MAIÚSCULAS podem reduzir a credibilidade.",
    sig_many_links: "Muitos links sem contexto podem ser um sinal fraco.",
    sig_no_claims: "Nenhuma afirmação clara e verificável foi detectada.",
    sig_many_claims: "Muitas afirmações de uma vez dificultam a verificação.",
    sig_some_claims: "Algumas afirmações verificáveis foram detectadas.",
    sig_time_sensitive: "Afirmação sensível ao tempo: sem web, o modo padrão não pode confirmar com confiança.",
    sig_pro_no_web: "PRO solicitado, mas a verificação web não está disponível (provedor/chave ausente).",
    sig_web_support: "Várias fontes parecem apoiar a afirmação.",
    sig_web_contradict: "Várias fontes parecem contradizer a afirmação.",
    sig_web_uncertain: "Há fontes, mas a evidência não é suficiente para concluir.",
    sig_web_mixed: "Fontes mistas/ambíguas: resultado permanece conservador.",
    summary_standard: "Risco de credibilidade: {risk}. {top}",
    summary_pro_supported: "Risco de credibilidade: {risk}. Evidência web tende a apoiar. {top}",
    summary_pro_contradicted: "Risco de credibilidade: {risk}. Evidência web tende a contradizer. {top}",
    summary_pro_uncertain: "Risco de credibilidade: {risk}. Evidência web é mista ou insuficiente. {top}",
    no_reasons: "Nenhum sinal forte detectado.",
  },

  ja: {
    server_error_summary: "分析中にサーバーエラーが発生しました。",
    server_error_reason: "内部エラーが発生しました。",
    sig_caps: "大文字の多用は煽り表現の可能性があります。",
    sig_exclam: "感嘆符の多用は感情的な文体の可能性があります。",
    sig_allcaps: "全て大文字の語は信頼性を下げる可能性があります。",
    sig_many_links: "文脈なしのリンクが多いのは弱い警告サインです。",
    sig_no_claims: "明確で検証可能な主張が検出されませんでした。",
    sig_many_claims: "主張が多すぎると検証が難しくなります。",
    sig_some_claims: "いくつかの検証可能な主張が検出されました。",
    sig_time_sensitive: "時事性の高い主張：Web証拠なしでは標準モードで確証できません。",
    sig_pro_no_web: "PROが要求されましたが、Web検証が利用できません（設定/キー不足）。",
    sig_web_support: "複数ソースが主張を支持している可能性があります。",
    sig_web_contradict: "複数ソースが主張に反している可能性があります。",
    sig_web_uncertain: "ソースはありますが、結論づけるには証拠が不十分です。",
    sig_web_mixed: "ソースが混在/不明確：結果は保守的になります。",
    summary_standard: "信頼性リスク: {risk}. {top}",
    summary_pro_supported: "信頼性リスク: {risk}. Web証拠は支持傾向です。{top}",
    summary_pro_contradicted: "信頼性リスク: {risk}. Web証拠は反証傾向です。{top}",
    summary_pro_uncertain: "信頼性リスク: {risk}. Web証拠は混在/不足です。{top}",
    no_reasons: "強いシグナルは検出されませんでした。",
  },

  ru: {
    server_error_summary: "Ошибка сервера во время анализа.",
    server_error_reason: "Произошла внутренняя ошибка.",
    sig_caps: "Чрезмерные заглавные буквы могут указывать на сенсационную подачу.",
    sig_exclam: "Много восклицательных знаков может указывать на эмоциональную подачу.",
    sig_allcaps: "СЛОВА В ВЕРХНЕМ РЕГИСТРЕ могут снижать доверие.",
    sig_many_links: "Много ссылок без контекста может быть слабым предупреждающим сигналом.",
    sig_no_claims: "Не обнаружено ясного и проверяемого утверждения.",
    sig_many_claims: "Слишком много утверждений одновременно усложняет проверку.",
    sig_some_claims: "Обнаружены некоторые проверяемые утверждения.",
    sig_time_sensitive: "Заявление зависит от времени: без веб-доказательств стандартный режим не может уверенно подтвердить.",
    sig_pro_no_web: "Запрошен PRO, но веб-проверка недоступна (нет провайдера/ключа).",
    sig_web_support: "Несколько источников, похоже, поддерживают утверждение.",
    sig_web_contradict: "Несколько источников, похоже, противоречат утверждению.",
    sig_web_uncertain: "Источники найдены, но доказательств недостаточно для вывода.",
    sig_web_mixed: "Источники смешанные или неясные: результат остаётся консервативным.",
    summary_standard: "Риск достоверности: {risk}. {top}",
    summary_pro_supported: "Риск достоверности: {risk}. Веб-доказательства скорее подтверждают. {top}",
    summary_pro_contradicted: "Риск достоверности: {risk}. Веб-доказательства скорее опровергают. {top}",
    summary_pro_uncertain: "Риск достоверности: {risk}. Веб-доказательства смешанные или недостаточные. {top}",
    no_reasons: "Сильных сигналов не обнаружено.",
  },

  uk: {
    server_error_summary: "Помилка сервера під час аналізу.",
    server_error_reason: "Сталася внутрішня помилка.",
    sig_caps: "Надмірні великі літери можуть виглядати сенсаційно.",
    sig_exclam: "Багато знаків оклику може вказувати на емоційний тон.",
    sig_allcaps: "СЛОВА В ВЕРХНЬОМУ РЕГІСТРІ можуть знижувати довіру.",
    sig_many_links: "Забагато посилань без контексту може бути слабким попереджувальним сигналом.",
    sig_no_claims: "Не виявлено чіткої та перевірюваної заяви.",
    sig_many_claims: "Занадто багато заяв одночасно ускладнює перевірку.",
    sig_some_claims: "Виявлено деякі перевірювані твердження.",
    sig_time_sensitive: "Заява залежить від часу: без веб-доказів стандартний режим не може впевнено підтвердити.",
    sig_pro_no_web: "Запитано PRO, але веб-перевірка недоступна (немає провайдера/ключа).",
    sig_web_support: "Кілька джерел, схоже, підтверджують твердження.",
    sig_web_contradict: "Кілька джерел, схоже, суперечать твердженню.",
    sig_web_uncertain: "Джерела знайдено, але доказів недостатньо для висновку.",
    sig_web_mixed: "Джерела змішані або неясні: результат залишається консервативним.",
    summary_standard: "Ризик достовірності: {risk}. {top}",
    summary_pro_supported: "Ризик достовірності: {risk}. Веб-докази радше підтверджують. {top}",
    summary_pro_contradicted: "Ризик достовірності: {risk}. Веб-докази радше спростовують. {top}",
    summary_pro_uncertain: "Ризик достовірності: {risk}. Веб-докази змішані або недостатні. {top}",
    no_reasons: "Сильних сигналів не виявлено.",
  },
};

function t(lang, key) {
  const L = I18N[lang] || I18N.en;
  return L[key] || I18N.en[key] || key;
}

function formatTemplate(str, vars) {
  let out = String(str || "");
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

// --------------------------
// Keyword lexicons (claim hints)
// --------------------------

const KEYWORDS = {
  en: {
    negations: [" not ", " never", " no ", " false", " untrue", " incorrect"],
    time_words: [" today", " now", " current", " in 20", " this year"],
    topics_politics: [" president", " prime minister", " government", " election", " senate", " congress", " parliament"],
    factual_hints: [" is ", " are ", " was ", " were ", " elected", " according to", " confirmed"],
  },
  fr: {
    negations: [" ne ", " pas", " jamais", " faux", " erron"],
    time_words: [" aujourd", " maintenant", " actuel", " en 20", " cette année"],
    topics_politics: [" président", " premier ministre", " gouvernement", " élection", " sénat", " congrès", " parlement"],
    factual_hints: [" est ", " sont ", " était", " étaient", " élu", " selon ", " d'après "],
  },
  ru: {
    negations: [" не ", " нет", " никогда", " лож", " невер"],
    time_words: [" сегодня", " сейчас", " текущ", " в 20", " в этом году"],
    topics_politics: [" президент", " премьер-министр", " правитель", " выбор", " сенат", " конгресс", " парламент"],
    factual_hints: [" является", " это", " был", " была", " были", " избран", " согласно"],
  },
  uk: {
    negations: [" не ", " ні ", " ніколи", " хиб", " неправ"],
    time_words: [" сьогодні", " зараз", " поточ", " у 20", " цього року"],
    topics_politics: [" президент", " прем'єр", " уряд", " вибор", " парламент"],
    factual_hints: [" є", " був", " була", " були", " обран", " згідно"],
  },
  es: {
    negations: [" no ", " nunca", " falso", " incorrecto"],
    time_words: [" hoy", " ahora", " actual", " en 20", " este año"],
    topics_politics: [" presidente", " primer ministro", " gobierno", " elección", " senado", " congreso", " parlamento"],
    factual_hints: [" es ", " son ", " fue ", " eran ", " ganó", " elegido", " según "],
  },
  de: {
    negations: [" nicht", " kein", " nie", " falsch", " unwahr"],
    time_words: [" heute", " jetzt", " aktuell", " in 20", " dieses jahr"],
    topics_politics: [" präsident", " kanzler", " regierung", " wahl", " senat", " kongress", " parlament"],
    factual_hints: [" ist ", " sind ", " war ", " waren ", " gewann", " gewählt", " laut "],
  },
  it: {
    negations: [" non ", " mai", " falso", " errato"],
    time_words: [" oggi", " ora", " attuale", " nel 20", " quest'anno"],
    topics_politics: [" presidente", " primo ministro", " governo", " elezion", " senato", " congresso", " parlamento"],
    factual_hints: [" è ", " sono ", " era ", " erano ", " ha vinto", " eletto", " secondo "],
  },
  ja: {
    negations: ["ない", "ではない", "違う", "誤", "偽"],
    time_words: ["今日", "今", "現在", "20", "今年"],
    topics_politics: ["大統領", "首相", "政府", "選挙", "議会"],
    factual_hints: ["である", "です", "だった", "によると"],
  },
  pt: {
    negations: [" não ", " nunca", " falso", " incorreto"],
    time_words: [" hoje", " agora", " atual", " em 20", " este ano"],
    topics_politics: [" presidente", " primeiro-ministro", " governo", " eleiç", " senado", " congresso", " parlamento"],
    factual_hints: [" é ", " são ", " foi ", " eram ", " eleito", " segundo "],
  },
};

function langKeywords(lang, key) {
  return (KEYWORDS[lang] && KEYWORDS[lang][key]) || (KEYWORDS.en && KEYWORDS.en[key]) || [];
}

function containsNegation(lowerText, lang) {
  const negs = langKeywords(lang, "negations");
  return negs.some((n) => lowerText.includes(n));
}

function topicMatch(lowerText, lang, list) {
  return (list || []).some((w) => lowerText.includes(w));
}

function claimTokens(lowerClaim) {
  // naive tokenization
  return lowerClaim
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40);
}

// --------------------------
// Market mapping for Bing
// --------------------------

function bingMarket(lang) {
  // best-effort markets; keep it simple
  if (lang === "fr") return "fr-CA";
  if (lang === "ru") return "ru-RU";
  if (lang === "uk") return "uk-UA";
  if (lang === "es") return "es-ES";
  if (lang === "de") return "de-DE";
  if (lang === "it") return "it-IT";
  if (lang === "pt") return "pt-PT";
  if (lang === "ja") return "ja-JP";
  return "en-US";
}

// --------------------------
// Claim extraction (conservative)
// --------------------------

function extractClaims(text) {
  const s = normalizeSpaces(text);
  if (!s) return [];

  // Split into sentences (very simple)
  const parts = s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

  // Keep sentences that look factual
  const claims = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    const hasHint =
      langKeywords("en", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("fr", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("ru", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("uk", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("es", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("de", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("it", "factual_hints").some((h) => lower.includes(h)) ||
      langKeywords("pt", "factual_hints").some((h) => lower.includes(h)) ||
      /(\b(is|are|was|were|est|sont|été|era|es|son)\b)/i.test(p);

    // length gate
    if (p.length < 18) continue;
    if (hasHint) claims.push(p);
  }

  // Dedup and cap
  return uniqBy(claims, (x) => x.toLowerCase()).slice(0, 4);
}

// --------------------------
// Web verification
// --------------------------

async function verifyClaimsWithWeb(claims, lang) {
  const out = [];

  for (const claim of claims || []) {
    const query = buildSearchQuery(claim, lang);
    const results = await webSearch(query, lang);
    const judged = judgeSearchResultsAgainstClaim(claim, results, lang);

    out.push({
      claim,
      query,
      judged,
    });
  }

  return out;
}

function buildSearchQuery(claim, lang) {
  const clean = normalizeSpaces(claim);

  // For “living” political roles, force a current-year context to avoid stale snippets
  const lower = clean.toLowerCase();
  const isPolitics = topicMatch(lower, lang, langKeywords(lang, "topics_politics"));

  if (isPolitics) {
    return `${clean} ${NOW_YEAR} current official sources`;
  }

  return clean;
}

async function webSearch(query, lang) {
  try {
    if (WEB_PROVIDER === "bing") {
      if (!BING_API_KEY) return [];

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number(process.env.WEB_TIMEOUT_MS || 8000));

      const res = await fetch(
        `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&mkt=${bingMarket(lang)}&count=6&textDecorations=false&textFormat=Raw`,
        {
          headers: { "Ocp-Apim-Subscription-Key": BING_API_KEY },
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!res.ok) return [];

      const json = await res.json();
      const items = (json.webPages && json.webPages.value) || [];
      return items.map((x) => ({
        name: x.name,
        url: x.url,
        snippet: x.snippet,
      }));
    }
  } catch (_) {}

  return [];
}

function judgeSearchResultsAgainstClaim(claim, results, lang) {
  const lowerClaim = String(claim || "").toLowerCase();
  const tokens = claimTokens(lowerClaim);

  const roleShiftCues = [
    "former",
    "ex-",
    "ex ",
    "previous",
    "past",
    "ancien",
    "ancienne",
    "précédent",
    "précédente",
    "ex-président",
    "ancien président",
    "быв",
  ];

  const claimHasNegation = containsNegation(lowerClaim, lang);

  let support = 0;
  let contradict = 0;

  const scored = (results || []).map((r) => {
    const blob = `${r.name || ""} ${r.snippet || ""}`.toLowerCase();
    const tokenHits = tokens.filter((t) => t.length >= 4 && blob.includes(t)).length;

    const hasNeg = containsNegation(` ${blob} `, lang);
    const hasRoleShift = roleShiftCues.some((c) => blob.includes(c));

    // Heuristic:
    // - If claim contains negation, snippets with negation may support it (but stay conservative).
    // - Otherwise, snippets with negation may contradict (again conservative).
    if (!claimHasNegation && hasNeg) contradict += 1;
    if (claimHasNegation && hasNeg) support += 1;

    // Politics: "former" cues contradict "current" claims
    if (hasRoleShift) contradict += 1;

    // More token hits suggests relevance, used to weight
    if (tokenHits >= 3) support += 1;
    if (tokenHits === 0) {
      // irrelevant snippet should not influence too much
    }

    return {
      ...r,
      tokenHits,
      hasNeg,
      hasRoleShift,
    };
  });

  // Conservative judgement:
  // Need a clear margin to decide; otherwise uncertain/mixed
  const total = support + contradict;

  let label = "uncertain";
  if (total >= 3) {
    if (support >= contradict + 2) label = "support";
    else if (contradict >= support + 2) label = "contradict";
    else label = "mixed";
  } else {
    label = "uncertain";
  }

  return {
    label,
    support,
    contradict,
    results: cleanSources(scored),
  };
}

// --------------------------
// Scoring (multi-signal)
// --------------------------

function scoreTextSignals(text, lang) {
  const tlen = safeLen(text);
  const lower = safeLower(text);

  let score = 78;
  const reasons = [];
  const meta = { signals: [] };

  // Length signals
  if (tlen < 40) {
    score -= 18;
    reasons.push("sig_no_claims");
    meta.signals.push({ k: "length", v: "very_short" });
  } else if (tlen < 120) {
    score -= 6;
    meta.signals.push({ k: "length", v: "short" });
  } else {
    meta.signals.push({ k: "length", v: "ok" });
  }

  // Uppercase ratio (Latin only)
  const letters = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const uppers = (text.match(/[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ]/g) || []).length;
  const ratio = letters ? uppers / letters : 0;

  if (ratio > 0.22 && letters > 60) {
    score -= 6;
    reasons.push("sig_caps");
    meta.signals.push({ k: "caps_ratio", v: ratio.toFixed(2) });
  }

  // All-caps words
  const allCapsWords = (text.match(/\b[A-Z]{4,}\b/g) || []).length;
  if (allCapsWords >= 2) {
    score -= 7;
    reasons.push("sig_allcaps");
    meta.signals.push({ k: "allcaps_words", v: allCapsWords });
  }

  // Exclamation marks
  const ex = (text.match(/!/g) || []).length;
  if (ex >= 4) {
    score -= 5;
    reasons.push("sig_exclam");
    meta.signals.push({ k: "exclamations", v: ex });
  }

  // Links
  const links = (text.match(/https?:\/\/\S+/g) || []).length;
  if (links >= 3) {
    score -= 4;
    reasons.push("sig_many_links");
    meta.signals.push({ k: "links", v: links });
  }

  // Claims density
  const claims = extractClaims(text);
  if (claims.length === 0) {
    score -= 10;
    reasons.push("sig_no_claims");
    meta.signals.push({ k: "claims", v: 0 });
  } else if (claims.length >= 3) {
    score -= 5;
    reasons.push("sig_many_claims");
    meta.signals.push({ k: "claims", v: claims.length });
  } else {
    reasons.push("sig_some_claims");
    meta.signals.push({ k: "claims", v: claims.length });
  }

  // Time sensitive hints
  const timeSensitive = topicMatch(lower, lang, langKeywords(lang, "time_words"));
  if (timeSensitive) {
    score -= 4;
    reasons.push("sig_time_sensitive");
    meta.signals.push({ k: "time_sensitive", v: true });
  }

  score = clamp(score, 5, 98);

  return { score, reasons, meta, claims };
}

function riskFromScore(score) {
  if (score >= 80) return "low";
  if (score >= 55) return "medium";
  return "high";
}

// --------------------------
// Main analyze route
// --------------------------

app.get("/v1/analyze", (_, res) => {
  res.json({
    status: "ok",
    engine: ENGINE_NAME,
    mode: "info",
    result: { score: 0, riskLevel: "low", summary: "Use POST /v1/analyze", reasons: [], confidence: 1, sources: [] },
    meta: { tookMs: 0, version: ENGINE_VERSION },
  });
});

app.post("/v1/analyze", requireKey, rateLimit, async (req, res) => {
  const started = Date.now();

  const tier = (req.headers["x-tier"] || "standard").toString().toLowerCase();
  const uiLang = normalizeLang(req.headers["x-lang"]);
  const text = (req.body && req.body.text) || "";

  if (!text || !String(text).trim()) {
    return res.status(400).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 25,
        riskLevel: "high",
        summary: "Missing 'text'.",
        reasons: ["Provide text in JSON body: { text: '...' }"],
        confidence: 0.5,
        sources: [],
      },
      meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
    });
  }

  const detected = detectLanguage(text);
  const lang = uiLang || detected || "en";

  try {
    const signals = scoreTextSignals(text, lang);
    let score = signals.score;
    let reasons = signals.reasons.map((k) => t(lang, k));
    let sources = [];
    let confidence = tier === "pro" || tier === "premium" || tier === "premium_plus" ? 0.8 : 0.62;

    const isPro = tier === "pro" || tier === "premium" || tier === "premium_plus";

    let webLabel = "none";
    let webSummaryKey = null;

    if (isPro) {
      if (!BING_API_KEY || WEB_PROVIDER !== "bing") {
        // No provider configured
        reasons.unshift(t(lang, "sig_pro_no_web"));
        confidence = 0.66;
      } else {
        const verified = await verifyClaimsWithWeb(signals.claims, lang);

        // Aggregate judgement
        let supports = 0;
        let contradicts = 0;
        let mixed = 0;
        let uncertain = 0;

        const gathered = [];
        for (const v of verified) {
          const j = v.judged;
          if (j.label === "support") supports += 1;
          else if (j.label === "contradict") contradicts += 1;
          else if (j.label === "mixed") mixed += 1;
          else uncertain += 1;

          for (const r of j.results || []) gathered.push(r);
        }

        sources = cleanSources(gathered);

        // Conservative web label
        if (supports >= 2 && contradicts === 0) webLabel = "support";
        else if (contradicts >= 2 && supports === 0) webLabel = "contradict";
        else if (supports + contradicts + mixed >= 2) webLabel = "mixed";
        else webLabel = "uncertain";

        if (webLabel === "support") {
          score = clamp(score + 8, 5, 98);
          confidence = 0.86;
          reasons.unshift(t(lang, "sig_web_support"));
          webSummaryKey = "summary_pro_supported";
        } else if (webLabel === "contradict") {
          score = clamp(score - 14, 5, 98);
          confidence = 0.84;
          reasons.unshift(t(lang, "sig_web_contradict"));
          webSummaryKey = "summary_pro_contradicted";
        } else if (webLabel === "mixed") {
          score = clamp(score - 6, 5, 98);
          confidence = 0.78;
          reasons.unshift(t(lang, "sig_web_mixed"));
          webSummaryKey = "summary_pro_uncertain";
        } else {
          score = clamp(score - 4, 5, 98);
          confidence = 0.72;
          reasons.unshift(t(lang, "sig_web_uncertain"));
          webSummaryKey = "summary_pro_uncertain";
        }
      }
    }

    const risk = riskFromScore(score);
    const top = reasons[0] || t(lang, "no_reasons");

    const summaryTpl = isPro
      ? t(lang, webSummaryKey || "summary_pro_uncertain")
      : t(lang, "summary_standard");

    const summary = formatTemplate(summaryTpl, { risk, top });

    const response = {
      status: "ok",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: isPro ? "pro" : "standard",
      result: {
        score,
        riskLevel: risk,
        summary,
        reasons: uniqBy(reasons, (x) => x).slice(0, 8),
        confidence: clamp(confidence, 0.5, 0.95),
        sources: cleanSources(sources),
      },
      meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
    };

    return res.json(response);
  } catch (err) {
    return res.status(500).json({
      status: "error",
      requestId: requestId(),
      engine: ENGINE_NAME,
      mode: tier,
      result: {
        score: 25,
        riskLevel: "high",
        summary: t(lang, "server_error_summary"),
        reasons: [t(lang, "server_error_reason")],
        confidence: 0.55,
        sources: [],
      },
      meta: { tookMs: Date.now() - started, version: ENGINE_VERSION },
    });
  }
});

// --------------------------
// Start
// --------------------------

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[IA11] listening on :${PORT} — version ${ENGINE_VERSION}`);
});
