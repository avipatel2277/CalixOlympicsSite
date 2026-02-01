const STORAGE_KEY = "calixolympics_data";
const DEFAULT_CALORIE_GOAL = 2000;
const DEFAULT_PROTEIN_GOAL = 50;
const DEFAULT_ACTIVITY_GOAL = 30;

const API_BASE = "";

let mongodbAvailable = null;

function setMongodbAvailable(available) {
  mongodbAvailable = !!available;
}

function fetchHealth() {
  fetch(`${API_BASE}/api/health`, { credentials: "include" })
    .then((res) => (res.ok ? res.json() : null))
    .then((h) => {
      if (h && typeof h.mongodb === "boolean") setMongodbAvailable(h.mongodb);
    })
    .catch(() => setMongodbAvailable(false));
}

function getToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { diet: {}, activity: {}, goals: null, goalStory: "" };
    const data = JSON.parse(raw);
    return {
      diet: data.diet || {},
      activity: data.activity || {},
      goals: data.goals || null,
      goalStory: data.goalStory || ""
    };
  } catch {
    return { diet: {}, activity: {}, goals: null, goalStory: "" };
  }
}

function getGoals(data) {
  const g = data.goals;
  return {
    calorieGoal: g?.calorieGoal ?? DEFAULT_CALORIE_GOAL,
    proteinGoal: g?.proteinGoal ?? DEFAULT_PROTEIN_GOAL,
    activityGoal: g?.activityGoal ?? DEFAULT_ACTIVITY_GOAL,
    goalStory: data.goalStory || ""
  };
}

function saveGoals(data, goals, story = "") {
  data.goals = goals;
  data.goalStory = story;
  saveData(data);
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  if (mongodbAvailable === false) return;
  fetch(`${API_BASE}/api/data`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      diet: data.diet || {},
      activity: data.activity || {},
      goals: data.goals ?? null,
      goalStory: data.goalStory || ""
    })
  })
    .then((res) => {
      if (res.ok) setMongodbAvailable(true);
      else if (res.status === 503) setMongodbAvailable(false);
    })
    .catch(() => setMongodbAvailable(false));
}

function getDietToday(data) {
  const today = getToday();
  return (data.diet[today] || []).slice();
}

function getActivityToday(data) {
  const today = getToday();
  return (data.activity[today] || []).slice();
}

function addDietEntry(data, entry) {
  const today = getToday();
  if (!data.diet[today]) data.diet[today] = [];
  data.diet[today].push({
    id: Date.now().toString(),
    name: entry.name,
    calories: Number(entry.calories) || 0,
    protein: Number(entry.protein) || 0,
    carbs: Number(entry.carbs) || 0,
    fat: Number(entry.fat) || 0
  });
  saveData(data);
}

function addActivityEntry(data, entry) {
  const today = getToday();
  if (!data.activity[today]) data.activity[today] = [];
  const duration = Number(entry.duration) || 0;
  const type = entry.type || "other";
  const intensity = entry.intensity || "moderate";
  const caloriesBurned = computeCaloriesBurned(type, intensity, duration);
  const benefits = getBenefitsForActivity(type);
  data.activity[today].push({
    id: Date.now().toString(),
    type,
    duration,
    intensity,
    caloriesBurned,
    benefits
  });
  saveData(data);
}

function deleteDietEntry(data, date, id) {
  if (!data.diet[date]) return;
  data.diet[date] = data.diet[date].filter((e) => e.id !== id);
  if (data.diet[date].length === 0) delete data.diet[date];
  saveData(data);
}

function deleteActivityEntry(data, date, id) {
  if (!data.activity[date]) return;
  data.activity[date] = data.activity[date].filter((e) => e.id !== id);
  if (data.activity[date].length === 0) delete data.activity[date];
  saveData(data);
}

function sumDiet(entries) {
  return entries.reduce(
    (acc, e) => ({
      calories: acc.calories + e.calories,
      protein: acc.protein + e.protein,
      carbs: acc.carbs + e.carbs,
      fat: acc.fat + e.fat
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

function sumActivityMinutes(entries) {
  return entries.reduce((acc, e) => acc + (e.duration || 0), 0);
}

function sumActivityCaloriesBurned(entries) {
  return entries.reduce((acc, e) => {
    if (e.caloriesBurned != null) return acc + e.caloriesBurned;
    return acc + computeCaloriesBurned(e.type, e.intensity, e.duration || 0);
  }, 0);
}

function formatDate(dateStr) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  const today = getToday();
  const isToday = dateStr === today;
  const formatted = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
  return isToday ? "Today, " + formatted : formatted;
}

const activityTypeLabels = {
  walk: "Walking",
  run: "Running",
  cycle: "Cycling",
  gym: "Gym / weights",
  sports: "Sports",
  other: "Other"
};

const intensityLabels = {
  light: "Light",
  moderate: "Moderate",
  vigorous: "Vigorous"
};

/* MET (Metabolic Equivalent) values by activity type and intensity – used for calorie burn estimate.
   Formula: calories ≈ MET × weight_kg × (duration_min / 60). Default weight 70 kg. */
const MET_BY_ACTIVITY = {
  walk:  { light: 2.5,  moderate: 3.5,  vigorous: 5.0 },
  run:   { light: 6.0,  moderate: 9.0,  vigorous: 12.0 },
  cycle: { light: 4.0,  moderate: 8.0,  vigorous: 12.0 },
  gym:   { light: 3.0,  moderate: 5.0,  vigorous: 6.0 },
  sports:{ light: 5.0,  moderate: 7.0,  vigorous: 10.0 },
  other: { light: 3.0,  moderate: 5.0,  vigorous: 7.0 }
};

const DEFAULT_WEIGHT_KG = 70;

const ACTIVITY_BENEFITS = {
  walk:   ["Heart health", "Mood", "Steps"],
  run:    ["Cardio", "Endurance", "Calorie burn"],
  cycle:  ["Leg strength", "Cardio", "Low impact"],
  gym:    ["Strength", "Bone density", "Muscle"],
  sports: ["Full body", "Coordination", "Fun"],
  other:  ["General fitness", "Movement"]
};

function getMET(type, intensity) {
  const byType = MET_BY_ACTIVITY[type] || MET_BY_ACTIVITY.other;
  return byType[intensity] ?? byType.moderate;
}

function computeCaloriesBurned(type, intensity, durationMinutes, weightKg = DEFAULT_WEIGHT_KG) {
  const met = getMET(type, intensity);
  const hours = durationMinutes / 60;
  return Math.round(met * weightKg * hours);
}

function getBenefitsForActivity(type) {
  return ACTIVITY_BENEFITS[type] || ACTIVITY_BENEFITS.other;
}

function getSuggestions(data) {
  const today = getToday();
  const dietEntries = getDietToday(data);
  const activityEntries = getActivityToday(data);
  const totals = sumDiet(dietEntries);
  const activeMinutes = sumActivityMinutes(activityEntries);
  const goals = getGoals(data);
  const suggestions = [];

  if (dietEntries.length === 0 && activityEntries.length === 0) {
    suggestions.push({
      text: "Log some food and activity today so we can give you personalized suggestions.",
      type: "info"
    });
    return suggestions;
  }

  if (dietEntries.length > 0) {
    if (totals.calories < goals.calorieGoal * 0.7) {
      suggestions.push({
        text: `You're under your calorie goal (${totals.calories} / ${goals.calorieGoal}). Consider adding a balanced meal or snack if you're trying to maintain or gain.`,
        type: "warning"
      });
    } else if (totals.calories > goals.calorieGoal * 1.2) {
      suggestions.push({
        text: `Calories are above your goal today. Try lighter options at your next meal or add a bit more activity to balance.`,
        type: "warning"
      });
    } else {
      suggestions.push({
        text: "Your calorie intake today looks on track. Keep it up.",
        type: "success"
      });
    }

    if (totals.protein < goals.proteinGoal * 0.6) {
      suggestions.push({
        text: `Protein is low (${totals.protein}g). Aim for lean meat, eggs, legumes, or Greek yogurt to hit your ${goals.proteinGoal}g goal.`,
        type: "warning"
      });
    } else if (totals.protein >= goals.proteinGoal) {
      suggestions.push({
        text: "You've hit your protein goal today. Great for recovery and satiety.",
        type: "success"
      });
    }
  }

  if (activityEntries.length > 0) {
    if (activeMinutes < goals.activityGoal) {
      suggestions.push({
        text: `You have ${activeMinutes} active minutes. Try to reach at least ${goals.activityGoal} minutes (e.g. a brisk walk) for general health.`,
        type: "warning"
      });
    } else {
      suggestions.push({
        text: `You've hit ${activeMinutes} active minutes today. Meeting your ${goals.activityGoal}-minute goal supports heart health and energy.`,
        type: "success"
      });
    }
  } else {
    suggestions.push({
      text: "No activity logged yet. Even 10–15 minutes of walking can help. Log when you're done.",
      type: "warning"
    });
  }

  if (dietEntries.length === 0) {
    suggestions.push({
      text: "Log your meals and snacks so we can help you stay on track with nutrition.",
      type: "info"
    });
  }

  return suggestions;
}

function renderDashboard(data) {
  const today = getToday();
  const goals = getGoals(data);
  document.getElementById("dashboard-date").textContent = formatDate(today);

  const dietEntries = getDietToday(data);
  const activityEntries = getActivityToday(data);
  const totals = sumDiet(dietEntries);
  const activeMinutes = sumActivityMinutes(activityEntries);

  document.getElementById("dash-calories").textContent = totals.calories;
  document.getElementById("dash-calories-target").textContent = `/ ${goals.calorieGoal}`;
  document.getElementById("dash-protein").textContent = totals.protein;
  document.getElementById("dash-protein-target").textContent = `/ ${goals.proteinGoal}`;
  const totalCaloriesBurned = sumActivityCaloriesBurned(activityEntries);
  document.getElementById("dash-activity").textContent = activeMinutes;
  document.getElementById("dash-activity-target").textContent = `/ ${goals.activityGoal}`;
  document.getElementById("dash-sessions").textContent = activityEntries.length;
  const dashCaloriesBurnedEl = document.getElementById("dash-calories-burned");
  if (dashCaloriesBurnedEl) dashCaloriesBurnedEl.textContent = totalCaloriesBurned;

  document.getElementById("daily-goal-text").textContent =
    `Calories: ${totals.calories} / ${goals.calorieGoal} · Protein: ${totals.protein} / ${goals.proteinGoal} g · Activity: ${activeMinutes} / ${goals.activityGoal} min`;

  const calPct = Math.min(100, goals.calorieGoal ? (totals.calories / goals.calorieGoal) * 100 : 0);
  const proteinPct = Math.min(100, goals.proteinGoal ? (totals.protein / goals.proteinGoal) * 100 : 0);
  const activityPct = Math.min(100, goals.activityGoal ? (activeMinutes / goals.activityGoal) * 100 : 0);
  document.getElementById("calories-bar").style.width = calPct + "%";
  document.getElementById("protein-bar").style.width = proteinPct + "%";
  document.getElementById("activity-bar").style.width = activityPct + "%";

  const recent = [
    ...dietEntries.map((e) => ({
      id: e.id,
      text: `${e.name} — ${e.calories} cal`
    })),
    ...activityEntries.map((e) => {
      const burned = e.caloriesBurned != null ? e.caloriesBurned : computeCaloriesBurned(e.type, e.intensity, e.duration || 0);
      return {
        id: e.id,
        text: `${activityTypeLabels[e.type] || e.type} — ${e.duration} min · ${burned} cal burned`
      };
    })
  ]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 5);

  const recentEl = document.getElementById("recent-list");
  if (recent.length === 0) {
    recentEl.innerHTML = '<li class="empty-state">No entries today yet. Log food or activity to see them here.</li>';
  } else {
    recentEl.innerHTML = recent
      .map((r) => `<li>${r.text}</li>`)
      .join("");
  }
}

function renderDietEntries(data) {
  const entries = getDietToday(data);
  const el = document.getElementById("diet-entries");
  const today = getToday();

  if (entries.length === 0) {
    el.innerHTML = '<li class="empty-state">No food logged today.</li>';
    return;
  }

  el.innerHTML = entries
    .map(
      (e) =>
        `<li>
          <div>
            <strong>${e.name}</strong>
            <span class="entry-meta">${e.calories} cal · P ${e.protein}g C ${e.carbs}g F ${e.fat}g</span>
          </div>
          <button type="button" class="entry-delete" data-date="${today}" data-id="${e.id}" aria-label="Delete">×</button>
        </li>`
    )
    .join("");

  el.querySelectorAll(".entry-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = loadData();
      deleteDietEntry(d, btn.dataset.date, btn.dataset.id);
      renderDietEntries(loadData());
      renderDashboard(loadData());
    });
  });
}

function renderActivityEntries(data) {
  const entries = getActivityToday(data);
  const el = document.getElementById("activity-entries");
  const today = getToday();

  if (entries.length === 0) {
    el.innerHTML = '<li class="empty-state">No activity logged today.</li>';
    return;
  }

  el.innerHTML = entries
    .map((e) => {
      const burned = e.caloriesBurned != null ? e.caloriesBurned : computeCaloriesBurned(e.type, e.intensity, e.duration || 0);
      const benefits = e.benefits && e.benefits.length ? e.benefits : getBenefitsForActivity(e.type);
      const chips = benefits.map((b) => `<span class="benefit-chip">${b}</span>`).join("");
      return `<li>
          <div>
            <strong>${activityTypeLabels[e.type] || e.type}</strong>
            <span class="entry-meta">${e.duration} min · ${intensityLabels[e.intensity] || e.intensity}</span>
            <span class="calories-burned">~${burned} cal burned</span>
            <div class="benefit-chips">${chips}</div>
          </div>
          <button type="button" class="entry-delete" data-date="${today}" data-id="${e.id}" aria-label="Delete">×</button>
        </li>`;
    })
    .join("");

  el.querySelectorAll(".entry-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = loadData();
      deleteActivityEntry(d, btn.dataset.date, btn.dataset.id);
      renderActivityEntries(loadData());
      renderDashboard(loadData());
    });
  });
}

function renderSuggestionsInto(listEl, suggestions) {
  if (!listEl) return;
  if (!suggestions || suggestions.length === 0) {
    listEl.innerHTML = '<li class="empty-state">Log some food and activity to get suggestions.</li>';
    return;
  }
  listEl.innerHTML = suggestions
    .map((s) => `<li class="${s.type}">${s.text}</li>`)
    .join("");
}

function fetchSuggestions(data) {
  const dietEntries = getDietToday(data);
  const activityEntries = getActivityToday(data);
  const goals = getGoals(data);
  const payload = {
    dietEntries: dietEntries.map((e) => ({ name: e.name, calories: e.calories, protein: e.protein })),
    activityEntries: activityEntries.map((e) => ({ type: e.type, duration: e.duration, intensity: e.intensity })),
    goals: { calorieGoal: goals.calorieGoal, proteinGoal: goals.proteinGoal, activityGoal: goals.activityGoal },
    goalStory: goals.goalStory || ""
  };
  return fetch(`${API_BASE}/api/suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then((res) => res.json())
    .then((api) => (api.suggestions && api.suggestions.length ? api.suggestions : getSuggestions(data)))
    .catch(() => getSuggestions(data));
}

let lastRenderedSuggestions = [];

function renderSuggestions(data) {
  const el = document.getElementById("suggestions-list");
  const dashEl = document.getElementById("dashboard-suggestions-list");
  if (el) el.innerHTML = '<li class="empty-state">Loading suggestions…</li>';
  if (dashEl) dashEl.innerHTML = '<li class="empty-state">Loading suggestions…</li>';

  fetchSuggestions(data).then((suggestions) => {
    lastRenderedSuggestions = suggestions || [];
    renderSuggestionsInto(el, lastRenderedSuggestions);
    renderSuggestionsInto(dashEl, lastRenderedSuggestions);
  });
}

function ensureGoalsChatSeeded() {
  const messages = getGoalsChatMessages();
  if (messages.length === 0) {
    const welcome = [{ role: "assistant", content: CALIXO_WELCOME }];
    saveGoalsChatMessages(welcome);
    renderGoalsChatMessages(welcome);
  } else {
    renderGoalsChatMessages(messages);
  }
}

function ensureTalkCalixoSeeded() {
  let messages = getTalkChatMessages();
  if (messages.length === 0) {
    const welcome = [{ role: "assistant", content: CALIXO_WELCOME }];
    saveTalkChatMessages(welcome);
    messages = welcome;
  }
  if (messages.length === 1 && messages[0].role === "assistant" && !sessionStorage.getItem("talkCalixoWelcomePlayed")) {
    sessionStorage.setItem("talkCalixoWelcomePlayed", "1");
    setTimeout(() => speakText(messages[0].content, null, () => {}), 400);
  }
}

function initTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      document.querySelectorAll(".nav-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", b.dataset.tab === tabId ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.remove("active");
        p.setAttribute("aria-hidden", p.id === tabId ? "false" : "true");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      const panel = document.getElementById(tabId);
      if (panel) {
        panel.classList.add("active");
        panel.setAttribute("aria-hidden", "false");
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      if (tabId === "goals") ensureGoalsChatSeeded();
      if (tabId === "talk-calixo") ensureTalkCalixoSeeded();
      refreshAll();
    });
  });
  // Set initial aria state for panels and tabs
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.setAttribute("aria-selected", b.classList.contains("active") ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.setAttribute("aria-hidden", p.classList.contains("active") ? "false" : "true");
  });
}

const foodAmountType = document.getElementById("food-amount-type");
const labelFoodGrams = document.getElementById("label-food-grams");
const labelFoodQuantity = document.getElementById("label-food-quantity");
const foodQuantityInput = document.getElementById("food-quantity");

function updateFoodAmountLabels() {
  if (!foodAmountType) return;
  const isGrams = foodAmountType.value === "grams";
  if (labelFoodGrams) labelFoodGrams.classList.toggle("hidden", !isGrams);
  if (labelFoodQuantity) labelFoodQuantity.classList.toggle("hidden", isGrams);
  const gramsInput = document.getElementById("food-grams");
  if (gramsInput) gramsInput.required = isGrams;
  if (foodQuantityInput) foodQuantityInput.required = !isGrams;
}
if (foodAmountType) {
  foodAmountType.addEventListener("change", updateFoodAmountLabels);
  updateFoodAmountLabels();
}

document.getElementById("diet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("food-name");
  const gramsInput = document.getElementById("food-grams");
  const statusEl = document.getElementById("diet-status");
  const submitBtn = document.getElementById("diet-submit-btn");
  const name = nameInput.value.trim();
  const useGrams = foodAmountType.value === "grams";
  const grams = useGrams ? Number(gramsInput.value) : NaN;
  const quantity = useGrams ? "" : (foodQuantityInput.value || "").trim();

  if (!name) {
    statusEl.textContent = "Enter a food name.";
    return;
  }
  if (useGrams && (!Number.isFinite(grams) || grams < 1)) {
    statusEl.textContent = "Enter a valid amount in grams.";
    return;
  }
  if (!useGrams && !quantity) {
    statusEl.textContent = "Enter a quantity (e.g. 1 cup, 2 eggs).";
    return;
  }

  statusEl.textContent = "Looking up nutrition…";
  submitBtn.disabled = true;
  try {
    const body = { foodName: name };
    if (useGrams) body.grams = grams;
    else body.quantity = quantity;

    const res = await fetch(`${API_BASE}/api/food-nutrition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Lookup failed.");
    const entry = {
      name: data.name || name,
      calories: String(data.calories ?? 0),
      protein: String(data.protein ?? 0),
      carbs: String(data.carbs ?? 0),
      fat: String(data.fat ?? 0)
    };
    const appData = loadData();
    addDietEntry(appData, entry);
    nameInput.value = "";
    gramsInput.value = "";
    foodQuantityInput.value = "";
    statusEl.textContent = `Added: ${entry.name} — ${data.calories} cal, ${data.protein}g protein.`;
    refreshAll();
  } catch (err) {
    statusEl.textContent = "Error: " + (err.message || "Could not look up nutrition. Is the server running?");
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("activity-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const data = loadData();
  addActivityEntry(data, {
    type: document.getElementById("activity-type").value,
    duration: document.getElementById("activity-duration").value,
    intensity: document.getElementById("activity-intensity").value
  });
  document.getElementById("activity-duration").value = "";
  document.getElementById("activity-duration").focus();
  refreshAll();
});

/* Check if a food fits user's goals */
function getCheckFoodContext() {
  const data = loadData();
  const goals = getGoals(data);
  const dietEntries = getDietToday(data);
  const totals = sumDiet(dietEntries);
  return {
    goals: { calorieGoal: goals.calorieGoal, proteinGoal: goals.proteinGoal, activityGoal: goals.activityGoal },
    goalStory: goals.goalStory || "",
    todayCalories: totals.calories,
    todayProtein: totals.protein
  };
}

async function runCheckFood(description) {
  const desc = (description || "").trim();
  const statusEl = document.getElementById("check-food-status");
  const resultEl = document.getElementById("check-food-result");
  const verdictEl = document.getElementById("check-food-verdict");
  const assessmentEl = document.getElementById("check-food-assessment");
  const checkBtn = document.getElementById("check-food-btn");
  const micBtn = document.getElementById("check-food-mic");

  if (!desc) {
    if (statusEl) statusEl.textContent = "Describe the food (e.g. chicken breast 200g, a slice of pizza).";
    return;
  }

  if (statusEl) statusEl.textContent = "Checking against your goals…";
  if (resultEl) resultEl.classList.add("hidden");
  if (checkBtn) checkBtn.disabled = true;
  if (micBtn) micBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/check-food`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foodDescription: desc, context: getCheckFoodContext() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Check failed.");

    if (statusEl) statusEl.textContent = "";
    if (verdictEl) {
      verdictEl.textContent = data.verdict === "fits" ? "Fits your goals" : data.verdict === "avoid" ? "Doesn't fit your goals" : "Use with caution";
      verdictEl.className = "check-food-verdict verdict-" + (data.verdict || "caution");
    }
    if (assessmentEl) assessmentEl.textContent = data.assessment || "";
    if (resultEl) resultEl.classList.remove("hidden");
  } catch (err) {
    if (statusEl) statusEl.textContent = "Error: " + (err.message || "Could not check.");
    if (resultEl) resultEl.classList.add("hidden");
  } finally {
    if (checkBtn) checkBtn.disabled = false;
    if (micBtn) micBtn.disabled = false;
  }
}

document.getElementById("check-food-btn").addEventListener("click", () => {
  const input = document.getElementById("check-food-input");
  runCheckFood(input?.value);
});

document.getElementById("check-food-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const input = document.getElementById("check-food-input");
    runCheckFood(input?.value);
  }
});

document.getElementById("check-food-mic").addEventListener("click", async function checkFoodMicClick() {
  const micBtn = this;
  const labelEl = document.getElementById("check-food-mic-label");
  const statusEl = document.getElementById("check-food-status");
  const inputEl = document.getElementById("check-food-input");

  if (voiceRecording.active && voiceRecording.mode === "check-food") {
    labelEl.textContent = "Processing…";
    statusEl.textContent = "Transcribing…";
    let blob;
    try {
      blob = await stopVoiceRecording();
    } catch (_) {
      labelEl.textContent = "Speak";
      voiceRecording.mode = null;
      statusEl.textContent = "";
      return;
    }
    if (!blob || blob.size < 500) {
      labelEl.textContent = "Speak";
      statusEl.textContent = "No audio captured. Try again.";
      return;
    }
    try {
      const transcript = await transcribeAudio(blob);
      if (transcript) {
        if (inputEl) inputEl.value = transcript;
        await runCheckFood(transcript);
      } else {
        statusEl.textContent = "No speech detected. Try again.";
      }
    } catch (err) {
      statusEl.textContent = "Error: " + (err.message || "Transcription failed.");
    }
    labelEl.textContent = "Speak";
    statusEl.textContent = "";
    voiceRecording.mode = null;
    return;
  }

  voiceRecording.mode = "check-food";
  labelEl.textContent = "Stop";
  statusEl.textContent = "Listening… Say the food (e.g. chicken breast 200 grams). Click again when done.";
  micBtn.disabled = true;
  startVoiceRecording()
    .then((blobOrNull) => {
      if (blobOrNull) return;
      micBtn.disabled = false;
    })
    .catch((err) => {
      statusEl.textContent = "Error: " + (err.message || "Microphone access denied.");
      labelEl.textContent = "Speak";
      voiceRecording.active = false;
      voiceRecording.mode = null;
      micBtn.disabled = false;
    });
});

/* Check if an activity fits user's goals */
function getCheckActivityContext() {
  const data = loadData();
  const goals = getGoals(data);
  const activityEntries = getActivityToday(data);
  const todayActivityMinutes = sumActivityMinutes(activityEntries);
  return {
    goals: { calorieGoal: goals.calorieGoal, proteinGoal: goals.proteinGoal, activityGoal: goals.activityGoal },
    goalStory: goals.goalStory || "",
    todayActivityMinutes
  };
}

async function runCheckActivity(description) {
  const desc = (description || "").trim();
  const statusEl = document.getElementById("check-activity-status");
  const resultEl = document.getElementById("check-activity-result");
  const verdictEl = document.getElementById("check-activity-verdict");
  const assessmentEl = document.getElementById("check-activity-assessment");
  const checkBtn = document.getElementById("check-activity-btn");
  const micBtn = document.getElementById("check-activity-mic");

  if (!desc) {
    if (statusEl) statusEl.textContent = "Describe the activity (e.g. 30 min walk, 1 hour gym).";
    return;
  }

  if (statusEl) statusEl.textContent = "Checking against your goals…";
  if (resultEl) resultEl.classList.add("hidden");
  if (checkBtn) checkBtn.disabled = true;
  if (micBtn) micBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/check-activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activityDescription: desc, context: getCheckActivityContext() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Check failed.");

    if (statusEl) statusEl.textContent = "";
    if (verdictEl) {
      verdictEl.textContent = data.verdict === "fits" ? "Fits your goals" : data.verdict === "avoid" ? "Doesn't fit your goals" : "Use with caution";
      verdictEl.className = "check-activity-verdict verdict-" + (data.verdict || "caution");
    }
    if (assessmentEl) assessmentEl.textContent = data.assessment || "";
    if (resultEl) resultEl.classList.remove("hidden");
  } catch (err) {
    if (statusEl) statusEl.textContent = "Error: " + (err.message || "Could not check.");
    if (resultEl) resultEl.classList.add("hidden");
  } finally {
    if (checkBtn) checkBtn.disabled = false;
    if (micBtn) micBtn.disabled = false;
  }
}

document.getElementById("check-activity-btn").addEventListener("click", () => {
  const input = document.getElementById("check-activity-input");
  runCheckActivity(input?.value);
});

document.getElementById("check-activity-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const input = document.getElementById("check-activity-input");
    runCheckActivity(input?.value);
  }
});

document.getElementById("check-activity-mic").addEventListener("click", async function checkActivityMicClick() {
  const micBtn = this;
  const labelEl = document.getElementById("check-activity-mic-label");
  const statusEl = document.getElementById("check-activity-status");
  const inputEl = document.getElementById("check-activity-input");

  if (voiceRecording.active && voiceRecording.mode === "check-activity") {
    labelEl.textContent = "Processing…";
    statusEl.textContent = "Transcribing…";
    let blob;
    try {
      blob = await stopVoiceRecording();
    } catch (_) {
      labelEl.textContent = "Speak";
      voiceRecording.mode = null;
      statusEl.textContent = "";
      return;
    }
    if (!blob || blob.size < 500) {
      labelEl.textContent = "Speak";
      statusEl.textContent = "No audio captured. Try again.";
      return;
    }
    try {
      const transcript = await transcribeAudio(blob);
      if (transcript) {
        if (inputEl) inputEl.value = transcript;
        await runCheckActivity(transcript);
      } else {
        statusEl.textContent = "No speech detected. Try again.";
      }
    } catch (err) {
      statusEl.textContent = "Error: " + (err.message || "Transcription failed.");
    }
    labelEl.textContent = "Speak";
    statusEl.textContent = "";
    voiceRecording.mode = null;
    return;
  }

  voiceRecording.mode = "check-activity";
  labelEl.textContent = "Stop";
  statusEl.textContent = "Listening… Say the activity (e.g. 30 min walk). Click again when done.";
  micBtn.disabled = true;
  startVoiceRecording()
    .then((blobOrNull) => {
      if (blobOrNull) return;
      micBtn.disabled = false;
    })
    .catch((err) => {
      statusEl.textContent = "Error: " + (err.message || "Microphone access denied.");
      labelEl.textContent = "Speak";
      voiceRecording.active = false;
      voiceRecording.mode = null;
      micBtn.disabled = false;
    });
});

document.getElementById("refresh-suggestions").addEventListener("click", () => {
  refreshAll();
});

function renderGoalsForm(data) {
  const goals = getGoals(data);
  const storyEl = document.getElementById("goal-story");
  if (storyEl) storyEl.value = goals.goalStory || "";

  const preview = document.getElementById("analyzed-goals-preview");
  if (preview) {
    if (data.goals != null) {
      preview.classList.remove("hidden");
      const pc = document.getElementById("preview-calories");
      const pp = document.getElementById("preview-protein");
      const pa = document.getElementById("preview-activity");
      if (pc) pc.textContent = goals.calorieGoal;
      if (pp) pp.textContent = goals.proteinGoal;
      if (pa) pa.textContent = goals.activityGoal;
    } else {
      preview.classList.add("hidden");
    }
  }
}

document.getElementById("goals-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const storyEl = document.getElementById("goal-story");
  const statusEl = document.getElementById("goals-status");
  const submitBtn = document.getElementById("goals-submit-btn");
  if (!storyEl || !statusEl || !submitBtn) return;
  const story = storyEl.value.trim();

  if (!story) {
    statusEl.textContent = "Please tell us your fitness story.";
    return;
  }

  statusEl.textContent = "AI is analyzing your story…";
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/analyze-goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ story })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Analysis failed.");

    const appData = loadData();
    saveGoals(appData, {
      calorieGoal: data.calorieGoal,
      proteinGoal: data.proteinGoal,
      activityGoal: data.activityGoal
    }, story);

    statusEl.textContent = "Goals updated successfully!";
    refreshAll();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

const photoInput = document.getElementById("photo-input");
const photoZone = document.getElementById("photo-upload-zone");
const photoResult = document.getElementById("photo-result");
const photoResultText = document.getElementById("photo-result-text");
let lastPhotoAnalysis = null;

photoZone.addEventListener("click", () => photoInput.click());
photoZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  photoZone.classList.add("dragover");
});
photoZone.addEventListener("dragleave", () => photoZone.classList.remove("dragover"));
photoZone.addEventListener("drop", (e) => {
  e.preventDefault();
  photoZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) handlePhotoFile(file);
});

photoInput.addEventListener("change", () => {
  const file = photoInput.files?.[0];
  if (file) handlePhotoFile(file);
  photoInput.value = "";
});

async function handlePhotoFile(file) {
  const statusEl = document.getElementById("photo-status");
  if (statusEl) statusEl.textContent = "Analyzing image…";
  photoResult.classList.add("hidden");
  const form = new FormData();
  form.append("image", file);
  try {
    const res = await fetch(`${API_BASE}/api/analyze-food-image`, {
      method: "POST",
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Analysis failed.");
    lastPhotoAnalysis = data.text || data.summary || "";
    photoResultText.textContent = lastPhotoAnalysis;
    photoResult.classList.remove("hidden");
    if (statusEl) statusEl.textContent = "";
  } catch (err) {
    if (statusEl) statusEl.textContent = "Error: " + (err.message || "Could not analyze image.");
    photoResultText.textContent = "Could not analyze this image. Make sure the server is running and OPENROUTER_API_KEY is set.";
    photoResult.classList.remove("hidden");
  }
}

document.getElementById("photo-add-log").addEventListener("click", () => {
  if (!lastPhotoAnalysis) return;
  const match = lastPhotoAnalysis.match(/[Tt]otal[:\s]*[Aa]bout\s*(\d+)\s*calories?/);
  const calories = match ? Number(match[1]) : 0;
  const data = loadData();
  addDietEntry(data, {
    name: "Meal from photo",
    calories: String(calories),
    protein: "0",
    carbs: "0",
    fat: "0"
  });
  refreshAll();
  document.getElementById("photo-result-text").textContent = "Added to today's log. " + (lastPhotoAnalysis || "");
});

function refreshAll() {
  const data = loadData();
  renderDashboard(data);
  renderDietEntries(data);
  renderActivityEntries(data);
  renderSuggestions(data);
  renderGoalsForm(data);
}

function syncFromServer() {
  if (mongodbAvailable === false) return;
  fetch(`${API_BASE}/api/data`, { method: "GET", credentials: "include" })
    .then((res) => {
      if (!res.ok && res.status === 503) setMongodbAvailable(false);
      return res.ok ? res.json() : null;
    })
    .then((payload) => {
      if (payload) setMongodbAvailable(true);
      const hasData =
        payload &&
        (Object.keys(payload.diet || {}).length > 0 ||
          Object.keys(payload.activity || {}).length > 0 ||
          payload.goals != null ||
          (payload.goalStory && String(payload.goalStory).trim().length > 0));
      if (hasData) {
        const data = {
          diet: payload.diet || {},
          activity: payload.activity || {},
          goals: payload.goals ?? null,
          goalStory: payload.goalStory || ""
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        refreshAll();
      }
    })
    .catch(() => setMongodbAvailable(false));
}

/* ElevenLabs voice: read text aloud, with stop control */
let currentPlayingAudio = null;
let currentVoiceButton = null;

function stopCurrentAudio() {
  if (currentPlayingAudio) {
    try {
      currentPlayingAudio.pause();
      currentPlayingAudio.currentTime = 0;
    } catch (_) {}
    currentPlayingAudio = null;
  }
  if (currentVoiceButton) {
    const labelEl = currentVoiceButton.querySelector(".btn-voice-label");
    const orig = currentVoiceButton.dataset.originalText;
    if (labelEl) labelEl.textContent = orig || "Read aloud";
    else currentVoiceButton.textContent = orig || "Read aloud";
    currentVoiceButton.disabled = false;
    currentVoiceButton = null;
  }
  const stopBtn = document.getElementById("stop-audio-btn");
  if (stopBtn) stopBtn.classList.add("hidden");
}

async function speakText(text, buttonEl, onPlaybackEnd) {
  if (!text || !text.trim()) return;
  stopCurrentAudio();
  const btn = buttonEl;
  const labelEl = btn?.querySelector(".btn-voice-label") || btn?.querySelector(".talk-calixo-mic-label");
  if (btn) {
    btn.disabled = true;
    if (labelEl) {
      if (btn.dataset.originalText === undefined) btn.dataset.originalText = labelEl.textContent;
      labelEl.textContent = "Generating…";
    } else {
      if (btn.dataset.originalText === undefined) btn.dataset.originalText = btn.textContent;
      btn.textContent = "Generating…";
    }
  }
  try {
    const res = await fetch(`${API_BASE}/api/text-to-speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim().slice(0, 2500) })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Voice failed.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentPlayingAudio = audio;
    currentVoiceButton = btn;

    const stopBtn = document.getElementById("stop-audio-btn");
    if (stopBtn) stopBtn.classList.remove("hidden");

    audio.onended = () => {
      URL.revokeObjectURL(url);
      stopCurrentAudio();
      if (typeof onPlaybackEnd === "function") onPlaybackEnd();
    };
    audio.onerror = () => {
      stopCurrentAudio();
      if (typeof onPlaybackEnd === "function") onPlaybackEnd();
    };
    await audio.play();
  } catch (err) {
    if (typeof console !== "undefined" && console.error) console.error(err);
    if (labelEl) labelEl.textContent = "Read aloud failed";
    else if (btn) btn.textContent = "Read aloud failed";
    setTimeout(() => {
      if (btn && btn.dataset.originalText) {
        if (labelEl) labelEl.textContent = btn.dataset.originalText;
        else btn.textContent = btn.dataset.originalText;
      }
      if (btn) btn.disabled = false;
      if (typeof onPlaybackEnd === "function") onPlaybackEnd();
    }, 2000);
  }
}

document.getElementById("stop-audio-btn").addEventListener("click", stopCurrentAudio);

document.getElementById("voice-dashboard-btn").addEventListener("click", () => {
  const data = loadData();
  const today = getToday();
  const goals = getGoals(data);
  const dietEntries = getDietToday(data);
  const activityEntries = getActivityToday(data);
  const totals = sumDiet(dietEntries);
  const activeMinutes = sumActivityMinutes(activityEntries);
  const totalBurned = sumActivityCaloriesBurned(activityEntries);
  const summary = [
    `Today is ${formatDate(today)}.`,
    `Calories: ${totals.calories} of ${goals.calorieGoal}. Protein: ${totals.protein} of ${goals.proteinGoal} grams.`,
    `Activity: ${activeMinutes} of ${goals.activityGoal} minutes. Calories burned from activity: about ${totalBurned}.`,
    dietEntries.length === 0 && activityEntries.length === 0
      ? "No entries yet today. Log food or activity to track."
      : `You have ${dietEntries.length} food entries and ${activityEntries.length} activity sessions.`
  ].join(" ");
  speakText(summary, document.getElementById("voice-dashboard-btn"));
});

document.getElementById("voice-briefing-btn").addEventListener("click", async () => {
  const data = loadData();
  const goals = getGoals(data);
  const dietEntries = getDietToday(data);
  const activityEntries = getActivityToday(data);
  const btn = document.getElementById("voice-briefing-btn");
  const labelEl = btn.querySelector(".btn-voice-label");

  const origText = labelEl.textContent;
  labelEl.textContent = "Analyzing…";
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/coach-briefing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dietEntries,
        activityEntries,
        goals,
        goalStory: goals.goalStory
      })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || "Briefing failed.");

    const script = (result.script || "").trim();
    if (!script) {
      labelEl.textContent = origText;
      btn.disabled = false;
      return;
    }
    btn.dataset.originalText = origText;
    labelEl.textContent = "Generating…";
    await speakText(script, btn);
  } catch (err) {
    labelEl.textContent = "Error";
    setTimeout(() => {
      labelEl.textContent = origText;
      btn.disabled = false;
    }, 2000);
  }
});

document.getElementById("voice-suggestions-btn").addEventListener("click", () => {
  const suggestions = lastRenderedSuggestions.length ? lastRenderedSuggestions : getSuggestions(loadData());
  const text =
    suggestions.length === 0
      ? "Log some food and activity to get suggestions."
      : suggestions.map((s) => s.text).join(". ");
  speakText(text, document.getElementById("voice-suggestions-btn"));
});

/* Voice log: ElevenLabs STT (transcribe) + Gemini (parse) → log multiple foods/activities */
let voiceRecording = { active: false, stream: null, recorder: null, chunks: [], mode: null };

function getBodyForFoodItem(item) {
  const q = (item.quantity || "").trim();
  const gramsMatch = q.match(/^(\d+(?:\.\d+)?)\s*g$/i) || q.match(/^(\d+)\s*grams?$/i);
  if (gramsMatch) {
    return { foodName: item.name.trim(), grams: Number(gramsMatch[1]) };
  }
  return { foodName: item.name.trim(), quantity: q || "1 serving" };
}

function startVoiceRecording() {
  return new Promise((resolve, reject) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      reject(new Error("Microphone not supported."));
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        };
        recorder.onerror = () => {
          stream.getTracks().forEach((t) => t.stop());
          reject(new Error("Recording failed."));
        };
        voiceRecording.stream = stream;
        voiceRecording.recorder = recorder;
        voiceRecording.chunks = chunks;
        voiceRecording.active = true;
        recorder.start(200);
        resolve(null);
      })
      .catch((err) => reject(err));
  });
}

function stopVoiceRecording() {
  if (!voiceRecording.active || !voiceRecording.recorder) return Promise.resolve(null);
  const rec = voiceRecording.recorder;
  const str = voiceRecording.stream;
  const ch = voiceRecording.chunks.slice();
  return new Promise((resolve) => {
    rec.onstop = () => {
      const blob = new Blob(ch, { type: rec.mimeType || "audio/webm" });
      if (str) str.getTracks().forEach((t) => t.stop());
      voiceRecording.active = false;
      voiceRecording.stream = null;
      voiceRecording.recorder = null;
      voiceRecording.chunks = [];
      voiceRecording.mode = null;
      resolve(blob);
    };
    rec.stop();
  });
}

async function transcribeAudio(blob) {
  const form = new FormData();
  form.append("audio", blob, "voice.webm");
  const res = await fetch(`${API_BASE}/api/speech-to-text`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Transcription failed.");
  return (data.text || "").trim();
}

async function handleSpeechFood() {
  const btn = document.getElementById("speech-food-btn");
  const statusEl = document.getElementById("speech-food-status");
  const labelEl = btn?.querySelector(".btn-voice-label");

  const setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
  };

  if (voiceRecording.active && voiceRecording.mode === "food") {
    setLabel("Processing…");
    statusEl.textContent = "Transcribing and parsing…";
    let blob;
    try {
      blob = await stopVoiceRecording();
    } catch (_) {
      setLabel("Speak to log food");
      statusEl.textContent = "Recording stopped.";
      return;
    }
    if (!blob || blob.size < 500) {
      setLabel("Speak to log food");
      statusEl.textContent = "No audio captured. Try again and speak clearly.";
      return;
    }
    btn.disabled = true;
    try {
      const transcript = await transcribeAudio(blob);
      if (!transcript) {
        statusEl.textContent = "No speech detected. Try e.g. \"rice one cup, chicken 200 grams\".";
        setLabel("Speak to log food");
        btn.disabled = false;
        return;
      }
      setLabel("Parsing…");
      statusEl.textContent = "Parsing your food…";
      const res = await fetch(`${API_BASE}/api/parse-speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "food", transcript })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Parse failed.");
      const items = data.items || [];
      if (items.length === 0) {
        statusEl.textContent = "No food items understood. Try e.g. \"rice one cup, chicken 200 grams\".";
        setLabel("Speak to log food");
        btn.disabled = false;
        return;
      }
      const appData = loadData();
      let added = 0;
      for (const item of items) {
        const body = getBodyForFoodItem(item);
        const nutRes = await fetch(`${API_BASE}/api/food-nutrition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const nut = await nutRes.json().catch(() => ({}));
        if (!nutRes.ok) continue;
        addDietEntry(appData, {
          name: nut.name || item.name,
          calories: String(nut.calories ?? 0),
          protein: String(nut.protein ?? 0),
          carbs: String(nut.carbs ?? 0),
          fat: String(nut.fat ?? 0)
        });
        added++;
      }
      refreshAll();
      statusEl.textContent =
        added === items.length
          ? `Added ${added} item(s): ${items.map((i) => i.name).join(", ")}.`
          : `Added ${added} of ${items.length} item(s).`;
    } catch (err) {
      statusEl.textContent = "Error: " + (err.message || "Could not transcribe or add food.");
    }
    setLabel("Speak to log food");
    btn.disabled = false;
    return;
  }

  voiceRecording.mode = "food";
  setLabel("Click to stop");
  statusEl.textContent = "Listening… Say your foods (e.g. rice one cup, chicken 200 grams). Click the button when done.";
  btn.disabled = true;
  startVoiceRecording()
    .then((blobOrNull) => {
      if (blobOrNull) return;
      btn.disabled = false;
    })
    .catch((err) => {
      statusEl.textContent = "Error: " + (err.message || "Microphone access denied.");
      setLabel("Speak to log food");
      voiceRecording.active = false;
      voiceRecording.mode = null;
      btn.disabled = false;
    });
}

async function handleSpeechActivity() {
  const btn = document.getElementById("speech-activity-btn");
  const statusEl = document.getElementById("speech-activity-status");
  const labelEl = btn?.querySelector(".btn-voice-label");

  const setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
  };

  if (voiceRecording.active && voiceRecording.mode === "activity") {
    setLabel("Processing…");
    statusEl.textContent = "Transcribing and parsing…";
    let blob;
    try {
      blob = await stopVoiceRecording();
    } catch (_) {
      setLabel("Speak to log activity");
      statusEl.textContent = "Recording stopped.";
      return;
    }
    if (!blob || blob.size < 500) {
      setLabel("Speak to log activity");
      statusEl.textContent = "No audio captured. Try again and speak clearly.";
      return;
    }
    btn.disabled = true;
    try {
      const transcript = await transcribeAudio(blob);
      if (!transcript) {
        statusEl.textContent = "No speech detected. Try e.g. \"I walked 30 minutes\".";
        setLabel("Speak to log activity");
        btn.disabled = false;
        return;
      }
      setLabel("Parsing…");
      statusEl.textContent = "Parsing your activity…";
      const res = await fetch(`${API_BASE}/api/parse-speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "activity", transcript })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Parse failed.");
      const activities = data.activities || [];
      if (activities.length === 0) {
        statusEl.textContent = "No activity understood. Try e.g. \"I walked 30 minutes\".";
        setLabel("Speak to log activity");
        btn.disabled = false;
        return;
      }
      const appData = loadData();
      for (const a of activities) {
        addActivityEntry(appData, {
          type: a.type || "other",
          duration: String(a.duration || 0),
          intensity: a.intensity || "moderate"
        });
      }
      refreshAll();
      statusEl.textContent = `Added ${activities.length} activity session(s).`;
    } catch (err) {
      statusEl.textContent = "Error: " + (err.message || "Could not transcribe or add activity.");
    }
    setLabel("Speak to log activity");
    btn.disabled = false;
    return;
  }

  voiceRecording.mode = "activity";
  setLabel("Click to stop");
  statusEl.textContent = "Listening… Say your activities (e.g. I walked 30 minutes, ran 20). Click the button when done.";
  btn.disabled = true;
  startVoiceRecording()
    .then((blobOrNull) => {
      if (blobOrNull) return;
      btn.disabled = false;
    })
    .catch((err) => {
      statusEl.textContent = "Error: " + (err.message || "Microphone access denied.");
      setLabel("Speak to log activity");
      voiceRecording.active = false;
      voiceRecording.mode = null;
      btn.disabled = false;
    });
}

document.getElementById("speech-food-btn").addEventListener("click", handleSpeechFood);
document.getElementById("speech-activity-btn").addEventListener("click", handleSpeechActivity);

/* Chat: separate storage for Goals (Discussion and Goals tab) vs Talk (Talk to Calixo voice) */
const CHAT_STORAGE_KEY_GOALS = "calixolympics_goals_chat";
const CHAT_STORAGE_KEY_TALK = "calixolympics_talk_chat";
const CALIXO_WELCOME = "Hi! I'm Calixo, your fitness coach. Tell me what you'd like to achieve—lose weight, get stronger, eat better—and I'll help you set goals and give you personalized suggestions here and in your Suggestions tab.";

function getGoalsChatMessages() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY_GOALS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveGoalsChatMessages(messages) {
  localStorage.setItem(CHAT_STORAGE_KEY_GOALS, JSON.stringify(messages));
}

function getTalkChatMessages() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY_TALK);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveTalkChatMessages(messages) {
  localStorage.setItem(CHAT_STORAGE_KEY_TALK, JSON.stringify(messages));
}

function openChatPanel() {
  const panel = document.getElementById("chat-panel");
  if (panel) panel.classList.remove("hidden");
  const messages = getGoalsChatMessages();
  if (messages.length === 0) {
    const welcome = [{ role: "assistant", content: CALIXO_WELCOME }];
    saveGoalsChatMessages(welcome);
    renderGoalsChatMessages(welcome);
  } else {
    renderGoalsChatMessages(messages);
  }
  document.getElementById("chat-input")?.focus();
}

function closeChatPanel() {
  document.getElementById("chat-panel")?.classList.add("hidden");
}

function renderGoalsChatMessages(messages) {
  const html = messages
    .map((m) => {
      if (m.role === "user") {
        return `<div class="chat-message user">${escapeHtml(m.content)}</div>`;
      }
      return `<div class="chat-message assistant"><span class="chat-message-name">Calixo</span> ${escapeHtml(m.content)}</div>`;
    })
    .join("");
  const panelEl = document.getElementById("chat-messages");
  const inlineEl = document.getElementById("goals-chat-messages");
  if (panelEl) {
    panelEl.innerHTML = html;
    panelEl.scrollTop = panelEl.scrollHeight;
  }
  if (inlineEl) {
    inlineEl.innerHTML = html;
    inlineEl.scrollTop = inlineEl.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function getChatContext() {
  const data = loadData();
  const goals = getGoals(data);
  return {
    dietEntries: getDietToday(data).map((e) => ({ name: e.name, calories: e.calories, protein: e.protein })),
    activityEntries: getActivityToday(data).map((e) => ({ type: e.type, duration: e.duration, intensity: e.intensity })),
    goals: { calorieGoal: goals.calorieGoal, proteinGoal: goals.proteinGoal, activityGoal: goals.activityGoal },
    goalStory: goals.goalStory || ""
  };
}

async function tryLogFoodAndActivityFromTranscript(transcript) {
  const t = (transcript || "").trim();
  if (!t) return { foodCount: 0, activityCount: 0 };
  let foodCount = 0;
  let activityCount = 0;
  try {
    const foodRes = await fetch(`${API_BASE}/api/parse-speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "food", transcript: t })
    });
    const foodData = await foodRes.json().catch(() => ({}));
    if (foodRes.ok && Array.isArray(foodData.items) && foodData.items.length > 0) {
      const appData = loadData();
      for (const item of foodData.items) {
        const body = getBodyForFoodItem(item);
        const nutRes = await fetch(`${API_BASE}/api/food-nutrition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const nut = await nutRes.json().catch(() => ({}));
        if (!nutRes.ok) continue;
        addDietEntry(appData, {
          name: nut.name || item.name,
          calories: String(nut.calories ?? 0),
          protein: String(nut.protein ?? 0),
          carbs: String(nut.carbs ?? 0),
          fat: String(nut.fat ?? 0)
        });
        foodCount++;
      }
    }
  } catch (_) {}
  try {
    const actRes = await fetch(`${API_BASE}/api/parse-speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "activity", transcript: t })
    });
    const actData = await actRes.json().catch(() => ({}));
    if (actRes.ok && Array.isArray(actData.activities) && actData.activities.length > 0) {
      const appData = loadData();
      for (const a of actData.activities) {
        addActivityEntry(appData, {
          type: a.type || "other",
          duration: String(a.duration || 0),
          intensity: a.intensity || "moderate"
        });
        activityCount++;
      }
    }
  } catch (_) {}
  if (foodCount > 0 || activityCount > 0) refreshAll();
  return { foodCount, activityCount };
}

function applySuggestedGoals(payload) {
  if (!payload || !payload.goalStory) return;
  const data = loadData();
  saveGoals(data, {
    calorieGoal: payload.calorieGoal ?? 2000,
    proteinGoal: payload.proteinGoal ?? 50,
    activityGoal: payload.activityGoal ?? 30
  }, payload.goalStory || "");
  refreshAll();
}

async function runVoiceConversationTurn(transcript) {
  const trimmed = (transcript || "").trim();
  if (!trimmed) return null;
  const messages = getTalkChatMessages();
  messages.push({ role: "user", content: trimmed });
  saveTalkChatMessages(messages);
  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context: getChatContext() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Chat failed.");
    const reply = (data.reply || "").trim();
    messages.push({ role: "assistant", content: reply });
    saveTalkChatMessages(messages);
    if (data.suggestedGoals && data.suggestedGoals.goalStory) applySuggestedGoals(data.suggestedGoals);
    return reply || null;
  } catch (err) {
    const fallback = "Sorry, I couldn't respond right now. Please try again.";
    messages.push({ role: "assistant", content: fallback });
    saveTalkChatMessages(messages);
    return fallback;
  }
}

async function sendChatMessage(text, source) {
  const input = source === "goals" ? document.getElementById("goals-chat-input") : document.getElementById("chat-input");
  const statusEl = source === "goals" ? document.getElementById("goals-chat-status") : document.getElementById("chat-status");
  const sendBtn = source === "goals" ? document.getElementById("goals-chat-send") : document.getElementById("chat-send");
  const micBtn = source === "goals" ? document.getElementById("goals-chat-mic") : document.getElementById("chat-mic");
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  if (document.getElementById("chat-input")) document.getElementById("chat-input").value = "";
  if (document.getElementById("goals-chat-input")) document.getElementById("goals-chat-input").value = "";
  const messages = getGoalsChatMessages();
  messages.push({ role: "user", content: trimmed });
  saveGoalsChatMessages(messages);
  renderGoalsChatMessages(messages);

  if (sendBtn) sendBtn.disabled = true;
  if (micBtn) micBtn.disabled = true;
  const statusElPanel = document.getElementById("chat-status");
  const statusElGoals = document.getElementById("goals-chat-status");

  const { foodCount, activityCount } = await tryLogFoodAndActivityFromTranscript(trimmed);
  if (foodCount > 0 || activityCount > 0) {
    const parts = [];
    if (foodCount > 0) parts.push(foodCount === 1 ? "1 food" : foodCount + " foods");
    if (activityCount > 0) parts.push(activityCount === 1 ? "1 activity" : activityCount + " activities");
    const loggedMsg = "Logged " + parts.join(", ") + ". Getting reply…";
    if (statusElPanel) statusElPanel.textContent = loggedMsg;
    if (statusElGoals) statusElGoals.textContent = loggedMsg;
  } else {
    if (statusElPanel) statusElPanel.textContent = "Calixo is thinking…";
    if (statusElGoals) statusElGoals.textContent = "Calixo is thinking…";
  }

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context: getChatContext() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Chat failed.");

    messages.push({ role: "assistant", content: data.reply || "" });
    saveGoalsChatMessages(messages);
    renderGoalsChatMessages(messages);

    if (data.suggestedGoals && data.suggestedGoals.goalStory) applySuggestedGoals(data.suggestedGoals);
  } catch (err) {
    const errMsg = "Error: " + (err.message || "Could not send.");
    if (statusElPanel) statusElPanel.textContent = errMsg;
    if (statusElGoals) statusElGoals.textContent = errMsg;
    messages.push({ role: "assistant", content: "Sorry, I couldn't respond right now. Please try again." });
    saveGoalsChatMessages(messages);
    renderGoalsChatMessages(messages);
  } finally {
    if (statusElPanel) statusElPanel.textContent = "";
    if (statusElGoals) statusElGoals.textContent = "";
    const sendBtnPanel = document.getElementById("chat-send");
    const sendBtnGoals = document.getElementById("goals-chat-send");
    if (sendBtnPanel) sendBtnPanel.disabled = false;
    if (sendBtnGoals) sendBtnGoals.disabled = false;
    const micPanel = document.getElementById("chat-mic");
    const micGoals = document.getElementById("goals-chat-mic");
    if (micPanel) micPanel.disabled = false;
    if (micGoals) micGoals.disabled = false;
  }
}

document.getElementById("chat-calixo-open")?.addEventListener("click", openChatPanel);
document.getElementById("chat-panel-close").addEventListener("click", closeChatPanel);

function bindChatSend(inputId, sendBtnId, source) {
  const input = document.getElementById(inputId);
  const sendBtn = document.getElementById(sendBtnId);
  if (!input || !sendBtn) return;
  sendBtn.addEventListener("click", () => sendChatMessage(input.value, source));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage(input.value, source);
    }
  });
}
bindChatSend("chat-input", "chat-send", "panel");
bindChatSend("goals-chat-input", "goals-chat-send", "goals");

/* Chat voice: record then send transcript as message */
function setupChatMic(micId, labelId, statusId, source) {
  const micBtn = document.getElementById(micId);
  if (!micBtn) return;
  micBtn.addEventListener("click", async function chatMicClick() {
    const labelEl = document.getElementById(labelId);
    const statusEl = document.getElementById(statusId);
    if (voiceRecording.active && voiceRecording.mode === "chat") {
      if (labelEl) labelEl.textContent = "Processing…";
      if (statusEl) statusEl.textContent = "Transcribing…";
      let blob;
      try {
        blob = await stopVoiceRecording();
      } catch (_) {
        if (labelEl) labelEl.textContent = "Speak";
        voiceRecording.mode = null;
        if (statusEl) statusEl.textContent = "";
        return;
      }
      if (!blob || blob.size < 500) {
        if (labelEl) labelEl.textContent = "Speak";
        if (statusEl) statusEl.textContent = "No audio captured. Try again.";
        return;
      }
      try {
        const transcript = await transcribeAudio(blob);
        if (transcript) await sendChatMessage(transcript, source);
      } catch (err) {
        if (statusEl) statusEl.textContent = "Error: " + (err.message || "Transcription failed.");
      }
      if (labelEl) labelEl.textContent = "Speak";
      if (statusEl) statusEl.textContent = "";
      return;
    }
    voiceRecording.mode = "chat";
    if (labelEl) labelEl.textContent = "Stop";
    if (statusEl) statusEl.textContent = "Listening… Click again when done.";
    micBtn.disabled = true;
    startVoiceRecording()
      .then((blobOrNull) => {
        if (blobOrNull) return;
        micBtn.disabled = false;
      })
      .catch((err) => {
        if (statusEl) statusEl.textContent = "Error: " + (err.message || "Microphone access denied.");
        if (labelEl) labelEl.textContent = "Speak";
        voiceRecording.active = false;
        voiceRecording.mode = null;
        micBtn.disabled = false;
      });
  });
}
setupChatMic("chat-mic", "chat-mic-label", "chat-status", "panel");
setupChatMic("goals-chat-mic", "goals-chat-mic-label", "goals-chat-status", "goals");

/* Talk to Calixo: voice-only conversation (ElevenLabs STT → optional food/activity log → chat API → ElevenLabs TTS) */
(function initTalkCalixoMic() {
  const micBtn = document.getElementById("talk-calixo-mic");
  const labelEl = document.getElementById("talk-calixo-mic-label");
  const statusEl = document.getElementById("talk-calixo-status");
  const setButtonLabel = (text) => { if (labelEl) labelEl.textContent = text; };
  const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };
  const resetIdle = () => { setButtonLabel("Tap to speak"); micBtn.disabled = false; setStatus(""); };

  if (!micBtn) return;
  micBtn.addEventListener("click", async function talkCalixoMicClick() {
    if (voiceRecording.active && voiceRecording.mode === "talk-calixo") {
      setButtonLabel("Tap to speak");
      setStatus("Transcribing…");
      let blob;
      try {
        blob = await stopVoiceRecording();
      } catch (_) {
        voiceRecording.mode = null;
        resetIdle();
        return;
      }
      if (!blob || blob.size < 500) {
        setStatus("No audio captured. Try again.");
        resetIdle();
        return;
      }
      micBtn.disabled = true;
      try {
        const transcript = await transcribeAudio(blob);
        if (!transcript) {
          setStatus("No speech detected. Try again.");
          resetIdle();
          return;
        }
        setStatus("Checking for food or activity…");
        const { foodCount, activityCount } = await tryLogFoodAndActivityFromTranscript(transcript);
        if (foodCount > 0 || activityCount > 0) {
          const parts = [];
          if (foodCount > 0) parts.push(foodCount === 1 ? "1 food" : foodCount + " foods");
          if (activityCount > 0) parts.push(activityCount === 1 ? "1 activity" : activityCount + " activities");
          setStatus("Logged " + parts.join(", ") + ". Getting Calixo…");
        } else {
          setStatus("Calixo is thinking…");
        }
        const reply = await runVoiceConversationTurn(transcript);
        setStatus("Calixo is speaking…");
        if (reply) {
          await speakText(reply, null, () => { resetIdle(); });
        } else {
          resetIdle();
        }
      } catch (err) {
        setStatus("Error: " + (err.message || "Something went wrong."));
        resetIdle();
      }
      return;
    }
    voiceRecording.mode = "talk-calixo";
    setButtonLabel("Tap when done");
    setStatus("Listening… Tap again when you finish.");
    micBtn.disabled = true;
    startVoiceRecording()
      .then((blobOrNull) => {
        if (blobOrNull) return;
        micBtn.disabled = false;
      })
      .catch((err) => {
        setStatus("Error: " + (err.message || "Microphone access denied."));
        setButtonLabel("Tap to speak");
        voiceRecording.active = false;
        voiceRecording.mode = null;
        micBtn.disabled = false;
      });
  });
})();

fetchHealth();
initTabs();
refreshAll();
syncFromServer();
