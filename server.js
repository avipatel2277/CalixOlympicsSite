/**
 * CalixOlympics API server – OpenRouter for food nutrition, suggestions, parse-speech, and photo analysis.
 * Optional MongoDB + anonymous cookie for persisting diet/activity/goals. Set OPENROUTER_API_KEY in .env.
 *
 * Run: node server.js  (or npm start)
 * Default port: 3000 (set PORT in .env to override)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const path = require("path");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL || "google/gemini-2.0-flash-001";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const MONGODB_URI = process.env.MONGODB_URI || "";
const USE_MONGODB = MONGODB_URI.length > 0;

let db = null;
if (USE_MONGODB) {
  const connectMongo = (options = {}) => {
    const opts = { serverSelectionTimeoutMS: 10000, ...options };
    return MongoClient.connect(MONGODB_URI, opts)
      .then((client) => {
        db = client.db();
        console.log("MongoDB connected.");
        return client;
      })
      .catch((err) => {
        console.error("MongoDB connection failed:", err.message);
        if (err.message && err.message.includes("SSL") && MONGODB_URI.startsWith("mongodb+srv://")) {
          console.error("Tip: SSL error 80 on Windows often fixes by using the STANDARD connection string in .env (see .env.example).");
        }
        db = null;
        return null;
      });
  };
  if (MONGODB_URI.startsWith("mongodb+srv://")) {
    try {
      require("dns").setServers(["8.8.8.8", "1.1.1.1"]);
    } catch (_) {}
    connectMongo({ autoSelectFamily: false }).then((client) => {
      if (!client) connectMongo({});
    });
  } else {
    connectMongo();
  }
}

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, ".")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

if (!OPENROUTER_API_KEY) {
  console.warn("OPENROUTER_API_KEY not set – food lookup, suggestions, parse-speech, and photo analysis will fail.");
}
if (!ELEVENLABS_API_KEY) {
  console.warn("ELEVENLABS_API_KEY not set – read-aloud voice will be unavailable.");
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, openrouter: !!OPENROUTER_API_KEY, elevenlabs: !!ELEVENLABS_API_KEY, mongodb: USE_MONGODB && !!db });
});

/* Anonymous cookie: ensure every request has an anon_id for MongoDB identity */
function getOrCreateAnonId(req, res, next) {
  let id = req.cookies?.anon_id;
  if (!id) {
    id = crypto.randomUUID();
    res.cookie("anon_id", id, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: "lax"
    });
  }
  req.anonId = id;
  next();
}

/* GET /api/data – load diet, activity, goals for this anonymous user (MongoDB) */
app.get("/api/data", getOrCreateAnonId, async (req, res) => {
  if (!db) return res.status(503).json({ error: "MongoDB not configured. Set MONGODB_URI in .env to enable sync." });
  try {
    const col = db.collection("appdata");
    const doc = await col.findOne({ _id: req.anonId });
    res.json({
      diet: doc?.diet || {},
      activity: doc?.activity || {},
      goals: doc?.goals ?? null,
      goalStory: doc?.goalStory || ""
    });
  } catch (err) {
    console.error("GET /api/data error:", err);
    res.status(500).json({ error: err.message || "Failed to load data." });
  }
});

/* PUT /api/data – save diet, activity, goals for this anonymous user (MongoDB) */
app.put("/api/data", getOrCreateAnonId, async (req, res) => {
  if (!db) return res.status(503).json({ error: "MongoDB not configured. Set MONGODB_URI in .env to enable sync." });
  const { diet = {}, activity = {}, goals = null, goalStory = "" } = req.body || {};
  try {
    const col = db.collection("appdata");
    await col.updateOne(
      { _id: req.anonId },
      { $set: { diet, activity, goals, goalStory, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/data error:", err);
    res.status(500).json({ error: err.message || "Failed to save data." });
  }
});

app.post("/api/text-to-speech", async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: "ElevenLabs API key not configured. Set ELEVENLABS_API_KEY in .env" });
  }
  const { text } = req.body;
  const toSpeak = (text || "").trim().slice(0, 2500);
  if (!toSpeak) return res.status(400).json({ error: "Missing or empty 'text'." });

  const voiceId = ELEVENLABS_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: toSpeak,
        model_id: "eleven_multilingual_v2"
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMsg = "ElevenLabs TTS failed.";
      try {
        const errJson = JSON.parse(errBody);
        errMsg = errJson.detail?.message || errJson.message || errBody || errMsg;
      } catch (_) {
        if (errBody) errMsg = errBody.slice(0, 200);
      }
      return res.status(response.status === 422 ? 422 : 502).json({ error: errMsg });
    }

    const buffer = await response.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("ElevenLabs TTS error:", err);
    res.status(500).json({ error: err.message || "Text-to-speech failed." });
  }
});

/* ElevenLabs Speech-to-Text: transcribe audio → use with Gemini for voice log */
app.post("/api/speech-to-text", upload.single("audio"), async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: "ElevenLabs API key not configured. Set ELEVENLABS_API_KEY in .env" });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "No audio file uploaded. Use field name 'audio'." });
  }

  const buffer = req.file.buffer;
  const mime = req.file.mimetype || "audio/webm";
  const ext = mime.includes("webm") ? "webm" : mime.includes("mp4") ? "mp4" : "webm";

  try {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
    form.append("model_id", "scribe_v2");

    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: form
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMsg = "ElevenLabs speech-to-text failed.";
      try {
        const errJson = JSON.parse(errBody);
        errMsg = errJson.detail?.message || errJson.message || errBody || errMsg;
      } catch (_) {
        if (errBody) errMsg = errBody.slice(0, 200);
      }
      return res.status(response.status === 422 ? 422 : 502).json({ error: errMsg });
    }

    const data = await response.json();
    const text = (data.text || "").trim();
    res.json({ text });
  } catch (err) {
    console.error("ElevenLabs STT error:", err);
    res.status(500).json({ error: err.message || "Speech-to-text failed." });
  }
});

function parseNutritionFromText(text) {
  const lower = (text || "").toLowerCase();
  const num = (s) => Math.round(parseFloat(s) || 0);
  let calories = 0, protein = 0, carbs = 0, fat = 0;
  const calMatch = lower.match(/calories?[:\s]*(\d+(?:\.\d+)?)/);
  if (calMatch) calories = num(calMatch[1]);
  const proMatch = lower.match(/protein[:\s]*(\d+(?:\.\d+)?)/);
  if (proMatch) protein = num(proMatch[1]);
  const carbMatch = lower.match(/carbs?[:\s]*(\d+(?:\.\d+)?)/);
  if (carbMatch) carbs = num(carbMatch[1]);
  const fatMatch = lower.match(/fat[:\s]*(\d+(?:\.\d+)?)/);
  if (fatMatch) fat = num(fatMatch[1]);
  return { calories, protein, carbs, fat };
}

app.post("/api/food-nutrition", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable nutrition lookup." });
  }
  const { foodName, grams, quantity } = req.body;
  const name = (foodName || "").trim();
  const gramsNum = grams != null ? Number(grams) : NaN;
  const quantityStr = typeof quantity === "string" ? quantity.trim() : "";

  if (!name) return res.status(400).json({ error: "Missing 'foodName'." });
  const useGrams = Number.isFinite(gramsNum) && gramsNum > 0;
  const useQuantity = quantityStr.length > 0;
  if (!useGrams && !useQuantity) {
    return res.status(400).json({ error: "Provide either 'grams' (positive number) or 'quantity' (e.g. 1 cup, 2 eggs)." });
  }

  const prompt = useGrams
    ? `You are a nutrition expert. For exactly ${gramsNum} grams of "${name}", provide the estimated nutrition.
Reply with ONLY this line (numbers only, no extra text):
calories: X, protein: X, carbs: X, fat: X
Replace each X with the number. Use typical values for that food and portion.`
    : `You are a nutrition expert. For "${quantityStr}" of "${name}" (e.g. 1 cup rice, 2 medium apples), provide the estimated nutrition for that portion.
Reply with ONLY this line (numbers only, no extra text):
calories: X, protein: X, carbs: X, fat: X
Replace each X with the number. Use typical values for that food and portion size.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000"
      },
      body: JSON.stringify({
        model: OPENROUTER_CHAT_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150
      })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errData.error?.message || errData.error?.code || (await response.text()) || "OpenRouter request failed."
      });
    }
    const data = await response.json();
    const content = (data.choices?.[0]?.message?.content || "").trim();
    const { calories, protein, carbs, fat } = parseNutritionFromText(content);
    const label = useGrams ? `${name} (${gramsNum}g)` : `${name} (${quantityStr})`;
    res.json({
      name: label,
      calories,
      protein,
      carbs,
      fat
    });
  } catch (err) {
    console.error("food-nutrition error:", err);
    res.status(500).json({ error: err.message || "Nutrition lookup failed." });
  }
});

function callOpenRouter(messages, maxTokens = 500) {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000"
    },
    body: JSON.stringify({
      model: OPENROUTER_CHAT_MODEL,
      messages,
      max_tokens: maxTokens
    })
  });
}

const CALIXO_SYSTEM = `You are Calixo, a friendly and knowledgeable fitness and nutrition coach in the CalixOlympics app. You use the user's current data (today's food, activity, and goals) to give smart, personalized responses.

PERSONALITY:
- Warm and concise. Reply in 2–5 sentences unless they ask for more.
- Always reference their actual numbers: e.g. "You're at 1200 of 2000 calories—you've got room for a solid dinner" or "You've hit your protein goal already today."
- When they mention food or activity, acknowledge it and give one relevant tip (e.g. "Chicken and rice is a great combo for protein and carbs" or "20 min run is a solid session—that'll help your cardio").
- If they're under on calories, protein, or activity, suggest one concrete next step. If they're over, be supportive and suggest balance (e.g. a lighter option or a short walk).
- Ask at most 1–2 short questions when you need more info to set or refine goals.

GOALS:
- When they share what they want to achieve (lose weight, build muscle, eat better, etc.), personalize your advice. When you have enough info, add exactly one line at the end of your message (no other text on that line):
SUGGESTED_GOALS: {"calorieGoal": 2000, "proteinGoal": 50, "activityGoal": 30, "goalStory": "One sentence summary of their goals"}
- Only include SUGGESTED_GOALS when they've given clear goal-related info. Use sensible defaults (2000 cal, 50g protein, 30 min activity) and goalStory as a one-sentence summary.
- Use the CONTEXT block below for every reply: cite their current totals vs goals so your advice is specific, not generic.`;

function extractSuggestedGoals(content) {
  const match = (content || "").match(/SUGGESTED_GOALS:\s*(\{[\s\S]*?\})\s*$/m);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1].trim());
    return {
      calorieGoal: Number(obj.calorieGoal) || 2000,
      proteinGoal: Number(obj.proteinGoal) || 50,
      activityGoal: Number(obj.activityGoal) || 30,
      goalStory: typeof obj.goalStory === "string" ? obj.goalStory.trim() : ""
    };
  } catch (_) {
    return null;
  }
}

function stripSuggestedGoalsLine(content) {
  return (content || "").replace(/\n?SUGGESTED_GOALS:\s*\{[\s\S]*?\}\s*$/m, "").trim();
}

/* Chat with Calixo – conversational goal discovery and suggestions */
app.post("/api/chat", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable Calixo." });
  }
  const { messages = [], context = {} } = req.body;
  const { dietEntries = [], activityEntries = [], goals = {}, goalStory = "" } = context;
  const calorieGoal = goals.calorieGoal ?? 2000;
  const proteinGoal = goals.proteinGoal ?? 50;
  const activityGoal = goals.activityGoal ?? 30;

  const todayCalories = dietEntries.reduce((s, e) => s + (Number(e.calories) || 0), 0);
  const todayProtein = dietEntries.reduce((s, e) => s + (Number(e.protein) || 0), 0);
  const todayActivityMins = activityEntries.reduce((s, e) => s + (Number(e.duration) || 0), 0);

  const dietSummary = dietEntries.length
    ? dietEntries.map((e) => `${e.name}: ${e.calories} cal`).join(", ")
    : "None logged today.";
  const activitySummary = activityEntries.length
    ? activityEntries.map((e) => `${e.type} ${e.duration} min`).join(", ")
    : "None logged today.";

  const contextBlock = `CONTEXT (use for every reply—reference these numbers so your advice is specific):
- Goals: ${calorieGoal} cal/day, ${proteinGoal}g protein, ${activityGoal} min activity. Goal story: "${goalStory || "Not set yet."}"
- Today so far: ${todayCalories} / ${calorieGoal} calories, ${todayProtein} / ${proteinGoal}g protein, ${todayActivityMins} / ${activityGoal} min activity.
- Today's food: ${dietSummary}
- Today's activity: ${activitySummary}`;

  const systemContent = CALIXO_SYSTEM + "\n\n" + contextBlock;
  const chatMessages = [
    { role: "system", content: systemContent },
    ...messages.slice(-20)
  ];

  try {
    const response = await callOpenRouter(chatMessages, 550);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error?.message || "OpenRouter request failed." });
    }
    const data = await response.json();
    const rawContent = (data.choices?.[0]?.message?.content || "").trim();
    const suggestedGoals = extractSuggestedGoals(rawContent);
    const reply = stripSuggestedGoalsLine(rawContent);
    res.json({ reply, suggestedGoals });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: err.message || "Chat failed." });
  }
});

/* Check if a food fits the user's goals – text or parsed from speech */
app.post("/api/check-food", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable food check." });
  }
  const { foodDescription = "", context = {} } = req.body;
  const desc = (foodDescription || "").trim();
  if (!desc) return res.status(400).json({ error: "Missing 'foodDescription'. Describe the food (e.g. chicken breast 200g, a slice of pizza)." });

  const { goals = {}, goalStory = "", todayCalories = 0, todayProtein = 0 } = context;
  const calorieGoal = goals.calorieGoal ?? 2000;
  const proteinGoal = goals.proteinGoal ?? 50;

  const prompt = `You are a nutrition coach. The user is considering eating: "${desc}"

Their daily goals: ${calorieGoal} calories, ${proteinGoal}g protein. Goal context: "${goalStory || "General health."}"
They have already had today: ${todayCalories} cal, ${todayProtein}g protein.

Estimate the rough nutrition for the food they described (calories and protein). Then say whether it FITS their goals, is a CAUTION (ok in moderation or with a tweak), or they should AVOID/skip for their goals. Be brief (2–4 sentences). Mention portion if relevant.

Reply with ONLY two lines:
1. One line: VERDICT: fits  OR  VERDICT: caution  OR  VERDICT: avoid
2. The rest: your short assessment (why it fits, or what to watch, or a better alternative).`;

  try {
    const response = await callOpenRouter([{ role: "user", content: prompt }], 300);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error?.message || "Request failed." });
    }
    const data = await response.json();
    const content = (data.choices?.[0]?.message?.content || "").trim();
    const verdictMatch = content.match(/VERDICT:\s*(fits|caution|avoid)/i);
    const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : "caution";
    const assessment = content.replace(/VERDICT:\s*(fits|caution|avoid)\s*/i, "").trim();
    res.json({ assessment: assessment || content, verdict });
  } catch (err) {
    console.error("check-food error:", err);
    res.status(500).json({ error: err.message || "Check failed." });
  }
});

/* Check if an activity fits the user's goals – text or parsed from speech */
app.post("/api/check-activity", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable activity check." });
  }
  const { activityDescription = "", context = {} } = req.body;
  const desc = (activityDescription || "").trim();
  if (!desc) return res.status(400).json({ error: "Missing 'activityDescription'. Describe the activity (e.g. 30 min walk, 1 hour gym)." });

  const { goals = {}, goalStory = "", todayActivityMinutes = 0 } = context;
  const activityGoal = goals.activityGoal ?? 30;

  const prompt = `You are a fitness coach. The user is considering doing: "${desc}"

Their daily activity goal: ${activityGoal} minutes. Goal context: "${goalStory || "General fitness."}"
They have already done today: ${todayActivityMinutes} minutes of activity.

Interpret the activity (type, rough duration, intensity). Say whether it FITS their goals (great choice, moves them toward target), is a CAUTION (ok but could do more/different), or they should AVOID (e.g. risk of injury, doesn't match goals, or too much). Be brief (2–4 sentences). Mention how it contributes to their goal if relevant.

Reply with ONLY two lines:
1. One line: VERDICT: fits  OR  VERDICT: caution  OR  VERDICT: avoid
2. The rest: your short assessment (why it fits, or what to consider, or a better alternative).`;

  try {
    const response = await callOpenRouter([{ role: "user", content: prompt }], 300);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error?.message || "Request failed." });
    }
    const data = await response.json();
    const content = (data.choices?.[0]?.message?.content || "").trim();
    const verdictMatch = content.match(/VERDICT:\s*(fits|caution|avoid)/i);
    const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : "caution";
    const assessment = content.replace(/VERDICT:\s*(fits|caution|avoid)\s*/i, "").trim();
    res.json({ assessment: assessment || content, verdict });
  } catch (err) {
    console.error("check-activity error:", err);
    res.status(500).json({ error: err.message || "Check failed." });
  }
});

/* Smart suggestions from today's diet, activity, and goals (OpenRouter) */
app.post("/api/suggestions", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable suggestions." });
  }
  const { dietEntries = [], activityEntries = [], goals = {}, goalStory = "" } = req.body;
  const calorieGoal = goals.calorieGoal ?? 2000;
  const proteinGoal = goals.proteinGoal ?? 50;
  const activityGoal = goals.activityGoal ?? 30;

  const dietSummary = dietEntries.length
    ? dietEntries.map((e) => `${e.name}: ${e.calories} cal, ${e.protein}g protein`).join("; ")
    : "No food logged today.";
  const activitySummary = activityEntries.length
    ? activityEntries.map((e) => `${e.type} ${e.duration} min (${e.intensity || "moderate"})`).join("; ")
    : "No activity logged today.";
  const totalCal = dietEntries.reduce((s, e) => s + (Number(e.calories) || 0), 0);
  const totalProtein = dietEntries.reduce((s, e) => s + (Number(e.protein) || 0), 0);
  const totalActiveMin = activityEntries.reduce((s, e) => s + (Number(e.duration) || 0), 0);

  const prompt = `You are a friendly fitness and nutrition coach. Based on the user's fitness story and TODAY's data below, give 3 to 6 short, personalized suggestions.

USER'S FITNESS STORY: "${goalStory}"

TODAY'S DATA:
- Food: ${dietSummary}
- Activity: ${activitySummary}
- Totals: ${totalCal} cal, ${totalProtein}g protein, ${totalActiveMin} active minutes.
- Targets: ${calorieGoal} cal, ${proteinGoal}g protein, ${activityGoal} min activity.

INSTRUCTIONS:
1. Be ultra-specific. Name specific foods, nutrients, and exercises.
2. Align suggestions with the user's fitness story. If they want to lose weight, suggest calorie-efficient, high-satiety foods. If they want to build muscle, focus on protein and resistance training.
3. Use "success" for positive feedback, "warning" for improvements, "info" for neutral tips.

Reply with ONLY a JSON array of objects: [{ "text": "...", "type": "success|warning|info" }].`;

  try {
    const response = await callOpenRouter([{ role: "user", content: prompt }], 600);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errData.error?.message || errData.error?.code || (await response.text()) || "OpenRouter request failed."
      });
    }
    const data = await response.json();
    const content = (data.choices?.[0]?.message?.content || "").trim();
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : content;
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_) {
      return res.status(422).json({ error: "Could not parse suggestions. Try again." });
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const suggestions = list
      .filter((s) => s && typeof s.text === "string")
      .map((s) => ({ text: s.text.trim(), type: ["success", "warning", "info"].includes(s.type) ? s.type : "info" }));
    res.json({ suggestions });
  } catch (err) {
    console.error("suggestions error:", err);
    res.status(500).json({ error: err.message || "Suggestions failed." });
  }
});

app.post("/api/parse-speech", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable voice logging." });
  }
  const { type, transcript } = req.body;
  const t = (transcript || "").trim();
  if (!t) return res.status(400).json({ error: "Missing 'transcript'." });
  if (type !== "food" && type !== "activity") {
    return res.status(400).json({ error: "Invalid 'type'. Use 'food' or 'activity'." });
  }

  const foodPrompt = `The user said the following to log food (they may have listed multiple items). Extract every food/drink item and its amount.
User said: "${t}"

Reply with ONLY a JSON array, no other text. Each item: { "name": "food name", "quantity": "amount" }.
For amount use either grams like "150g" or a portion like "1 cup", "2 medium apples", "1 slice", "half cup". If no amount was said, use a reasonable default like "1 serving".
Example output: [{"name":"rice","quantity":"1 cup"},{"name":"chicken breast","quantity":"150g"}]`;

  const activityPrompt = `The user said the following to log physical activity. Extract activity type, duration in minutes, and intensity.
User said: "${t}"

Reply with ONLY a JSON array of activities, no other text. Each item: { "type": "walk|run|cycle|gym|sports|other", "duration": number, "intensity": "light|moderate|vigorous" }.
Infer duration in minutes (e.g. "half an hour" = 30, "15 min" = 15). If multiple activities are mentioned, include each. If intensity is unclear, use "moderate".
Example output: [{"type":"walk","duration":30,"intensity":"moderate"}]`;

  const prompt = type === "food" ? foodPrompt : activityPrompt;

  try {
    const response = await callOpenRouter([{ role: "user", content: prompt }], 600);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errData.error?.message || errData.error?.code || (await response.text()) || "OpenRouter request failed."
      });
    }
    const data = await response.json();
    const content = (data.choices?.[0]?.message?.content || "").trim();
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : content;
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_) {
      return res.status(422).json({ error: "Could not parse AI response as JSON. Try rephrasing." });
    }
    if (type === "food") {
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const valid = items.filter((i) => i && typeof i.name === "string");
      return res.json({ items: valid });
    }
    const activities = Array.isArray(parsed) ? parsed : [parsed];
    const valid = activities.filter(
      (a) => a && ["walk", "run", "cycle", "gym", "sports", "other"].includes(a.type) && typeof a.duration === "number"
    );
    valid.forEach((a) => {
      if (!a.intensity || !["light", "moderate", "vigorous"].includes(a.intensity)) a.intensity = "moderate";
    });
    return res.json({ activities: valid });
  } catch (err) {
    console.error("parse-speech error:", err);
    res.status(500).json({ error: err.message || "Speech parse failed." });
  }
});

app.post("/api/coach-briefing", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable coach briefing." });
  }
  const { dietEntries = [], activityEntries = [], goals = {}, goalStory = "" } = req.body;
  const calorieGoal = goals.calorieGoal ?? 2000;
  const activityGoal = goals.activityGoal ?? 30;

  const dietSummary = dietEntries.length ? dietEntries.map(e => `${e.name} (${e.calories} cal)`).join(", ") : "Nothing logged yet";
  const activitySummary = activityEntries.length ? activityEntries.map(e => `${e.type} for ${e.duration} min`).join(", ") : "No activity yet";
  const totalCal = dietEntries.reduce((s, e) => s + (Number(e.calories) || 0), 0);
  const totalActiveMin = activityEntries.reduce((s, e) => s + (Number(e.duration) || 0), 0);

  const prompt = `You are a motivational fitness coach. Write a short, high-energy briefing (max 100 words) for the user based on their progress today.

USER'S STORY: "${goalStory}"
TODAY'S PROGRESS:
- Food: ${dietSummary}
- Activity: ${activitySummary}
- Totals: ${totalCal}/${calorieGoal} cal, ${totalActiveMin}/${activityGoal} min active.

Provide a personalized, encouraging message that references their specific goals from their story. Keep it concise and ready to be read aloud.`;

  try {
    const response = await callOpenRouter([{ role: "user", content: prompt }], 250);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error?.message || "OpenRouter request failed." });
    }
    const data = await response.json();
    const script = (data.choices?.[0]?.message?.content || "").trim();
    res.json({ script });
  } catch (err) {
    console.error("coach-briefing error:", err);
    res.status(500).json({ error: err.message || "Failed to generate briefing." });
  }
});

app.post("/api/analyze-food-image", upload.single("image"), async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env" });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "No image file uploaded. Use field name 'image'." });
  }
  const base64 = req.file.buffer.toString("base64");
  const mime = req.file.mimetype || "image/jpeg";
  const prompt = `Look at this photo of food or a meal. List every food and drink you can identify. For each item give:
- name (short)
- estimated portion (e.g. 1 cup, 1 medium apple, 2 slices)
- calories (number)
- protein in grams
- carbs in grams
- fat in grams

Reply in a clear, short paragraph suitable for reading aloud. Include a one-line total at the end (e.g. "Total: about X calories, Y grams protein."). If there is no food visible, say so briefly.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000"
      },
      body: JSON.stringify({
        model: OPENROUTER_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${base64}` }
              }
            ]
          }
        ],
        max_tokens: 500
      })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errData.error?.message || errData.error?.code || (await response.text()) || "OpenRouter request failed."
      });
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || "I couldn't analyze this image.";
    res.json({ text: content, summary: content });
  } catch (err) {
    console.error("OpenRouter Vision error:", err);
    res.status(500).json({ error: err.message || "Image analysis failed." });
  }
});

app.post("/api/analyze-goals", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "AI is not configured. Add OPENROUTER_API_KEY to .env to enable goal analysis." });
  }
  const { story } = req.body;
  if (!story) return res.status(400).json({ error: "Missing 'story'." });

  const prompt = `You are a fitness and nutrition expert. Analyze the following user's fitness story and goals:
"${story}"

Based on this, extract or estimate the following daily targets:
- calorieGoal (number)
- proteinGoal (grams, number)
- activityGoal (minutes, number)

Reply with ONLY a JSON object: { "calorieGoal": X, "proteinGoal": X, "activityGoal": X }. No other text.`;

  try {
    const response = await callOpenRouter([{ role: "user", content: prompt }], 150);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error?.message || "OpenRouter request failed." });
    }
    const data = await response.json();
    const content = (data.choices?.[0]?.message?.content || "").trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (parseErr) {
      console.error("analyze-goals parse error:", parseErr);
      return res.status(422).json({ error: "Could not parse AI response. Try rephrasing your goals." });
    }
    res.json({
      calorieGoal: Number(parsed.calorieGoal) || 2000,
      proteinGoal: Number(parsed.proteinGoal) || 50,
      activityGoal: Number(parsed.activityGoal) || 30
    });
  } catch (err) {
    console.error("analyze-goals error:", err);
    res.status(500).json({ error: err.message || "Failed to analyze goals." });
  }
});

// Start the server when run directly (e.g. node server.js).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`CalixOlympics API running at http://localhost:${PORT}`);
  });
}

module.exports = app;
