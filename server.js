/**
 * CalixOlympics API server – OpenRouter (Gemini) for food nutrition (name + grams) and photo analysis.
 * Set OPENROUTER_API_KEY in .env.
 *
 * Run: node server.js  (or npm start)
 * Default port: 3000 (set PORT in .env to override)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL || "google/gemini-2.0-flash-001";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, ".")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

if (!OPENROUTER_API_KEY) {
  console.warn("OPENROUTER_API_KEY not set – food lookup and photo analysis will fail.");
}
if (!ELEVENLABS_API_KEY) {
  console.warn("ELEVENLABS_API_KEY not set – read-aloud voice will be unavailable.");
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, openrouter: !!OPENROUTER_API_KEY, elevenlabs: !!ELEVENLABS_API_KEY });
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
    return res.status(503).json({ error: "OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env" });
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

  const portionDesc = useGrams ? `exactly ${gramsNum} grams` : `portion: ${quantityStr}`;
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
    console.error("OpenRouter food-nutrition error:", err);
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

/* Gemini-powered smart suggestions from today's diet, activity, and goals */
app.post("/api/suggestions", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: "OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env" });
  }
  const { dietEntries = [], activityEntries = [], goals = {} } = req.body;
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

  const prompt = `You are a friendly fitness and nutrition coach. Based on TODAY's data below, give 3 to 6 short, personalized suggestions. Be very specific:

FOR FOOD: Name specific foods and mention specific nutrients (not just "protein" or "calories"). Examples: "Have a handful of almonds for vitamin E and magnesium", "Add a cup of spinach for iron and folate", "Try Greek yogurt for calcium and probiotics", "Eat salmon for omega-3s and vitamin D", "A banana gives potassium and quick energy".
FOR EXERCISE: Name specific exercises with reps, duration, or sets when relevant. Examples: "Do 20 minutes of brisk walking", "Try 3 sets of 10 bodyweight squats", "15 min jog at moderate pace", "10 min of stretching or yoga", "A 30 min bike ride".

Consider calories, protein, and activity goals. Use "success" for positive feedback, "warning" for something to improve, "info" for neutral tips.

Today's food: ${dietSummary}
Today's activity: ${activitySummary}
Totals: ${totalCal} cal, ${totalProtein}g protein, ${totalActiveMin} active minutes.
Goals: ${calorieGoal} cal, ${proteinGoal}g protein, ${activityGoal} min activity.

Reply with ONLY a JSON array of objects. Each object: { "text": "one short, specific suggestion", "type": "success" or "warning" or "info" }. No other text.`;

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
    return res.status(503).json({ error: "OpenRouter API key not configured. Set OPENROUTER_API_KEY in .env" });
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

// Start the server when run directly (e.g. node server.js).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`CalixOlympics API running at http://localhost:${PORT}`);
  });
}

module.exports = app;
