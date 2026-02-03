# CalixOlympics

Fitness app that tracks diet and activity, daily goals, and uses **OpenRouter** for food nutrition (name + grams), suggestions, voice-log parsing, and photo-based nutrition. Use any OpenRouter model (e.g. Gemini, or Snowflake Arctic when available). **ElevenLabs** powers read-aloud voice. Optional **MongoDB** + anonymous cookie syncs diet/activity/goals to the server (same browser = same data).

*** Made in collaboration with Azam Khan, Aayan Chaudhry, Shyamal Rajkotia, Saboor Faisal and Joy Liu.

## Features

- **Daily goals** – Set calorie, protein, and activity (minutes) goals. Track progress on the dashboard.
- **Diet logging** – Enter **food name** and **amount in grams**; macros (calories, protein, carbs, fat) are looked up automatically via OpenRouter. No manual macro entry.
- **Activity logging** – Log exercise type, duration, and intensity. Each entry shows **estimated calories burned** (MET-based) and **benefits** (e.g. heart health, strength, cardio).
- **Photo food** – Upload a photo of a meal; OpenRouter (vision) detects food and estimates nutrition. You can add the result to today’s log.
- **Voice (ElevenLabs)** – “Read summary” on the dashboard and “Read suggestions aloud” on the Suggestions tab use text-to-speech so you can hear your daily overview and tips.

## How to run

1. **Open a terminal** in the `fitness-app` folder:
   ```bash
   cd fitness-app
   ```
   (Or: `cd "c:\Users\azamk\OneDrive\Documents\Cursor\fitness-app"` on Windows.)

2. **Install dependencies** (once):
   ```bash
   npm install
   ```
   You need [Node.js](https://nodejs.org/) installed.

3. **Start the server**:
   ```bash
   npm start
   ```

4. **Open the app** in your browser: **http://localhost:3000**

## API keys (.env)

- **OPENROUTER_API_KEY** – Used for food nutrition, suggestions, parse-speech, and **photo food** (vision). Required for AI features.
- **ELEVENLABS_API_KEY** – Used for read-aloud voice (dashboard summary and suggestions). Optional: `ELEVENLABS_VOICE_ID` to change the voice.
- **MONGODB_URI** (optional) – If set, diet/activity/goals are synced to MongoDB per anonymous cookie (one document per browser). If omitted, data stays in localStorage only.
- Optional: `OPENROUTER_VISION_MODEL`, `OPENROUTER_CHAT_MODEL` (default: `google/gemini-2.0-flash-001` for both), `PORT`.

## APIs used

- **OpenRouter** – One API for nutrition lookup, suggestions, parse-speech, and vision (photo food). Use any model via `OPENROUTER_CHAT_MODEL` / `OPENROUTER_VISION_MODEL` (e.g. Gemini, or Snowflake Arctic when available on OpenRouter).
- **ElevenLabs** – Text-to-speech for “Read summary” and “Read suggestions aloud.”
