// popup.js

let timerInterval = null;
let timeLeft = 25 * 60;
let timerRunning = false;
let currentMode = "strict";
let activeProfile = null;

// ── INIT ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get([
    "activeFocusProfile", "currentMode", "analytics", "rewireMode"
  ]);

  if (data.activeFocusProfile) {
    activeProfile = data.activeFocusProfile;
    document.getElementById("topicInput").value = activeProfile.topic;
    setStatus(`✅ Active: ${activeProfile.topic}`, "green");
    document.getElementById("deactivateBtn").style.display = "block";
  }

  if (data.currentMode) setMode(data.currentMode, false);
  if (data.analytics) updateStatsUI(data.analytics);

  if (data.rewireMode) {
    document.getElementById("rewireBtn").classList.add("active");
    document.getElementById("rewireBtn").textContent = "🔁 Rewire: ON";
  }

  // Refresh stats every 2s while popup is open
  setInterval(refreshStats, 2000);
});

// ── ACTIVATE / DEACTIVATE ─────────────────────────────────────────────────

document.getElementById("activateBtn").addEventListener("click", async () => {
  const topic = document.getElementById("topicInput").value.trim();
  if (!topic) { setStatus("⚠️ Please enter a topic.", "red"); return; }

  setStatus("⏳ Generating AI keywords...", "dim");
  document.getElementById("activateBtn").disabled = true;

  const response = await chrome.runtime.sendMessage({
    type: "GENERATE_KEYWORDS",
    topic
  });

  document.getElementById("activateBtn").disabled = false;

  if (response && response.success) {
    activeProfile = response.profile;
    const cached = response.fromCache ? " (cached)" : "";
    const fallback = response.fallback ? " (offline mode)" : "";
    setStatus(`✅ Active: ${topic}${cached}${fallback}`, "green");
    document.getElementById("deactivateBtn").style.display = "block";

    // Tell content script to start filtering
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "START_FILTERING",
        profile: response.profile
      });
    }
  } else {
    setStatus("❌ Error generating keywords. Check API key.", "red");
  }
});

document.getElementById("deactivateBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove("activeFocusProfile");
  activeProfile = null;
  setStatus("⏸ Session ended.", "dim");
  document.getElementById("deactivateBtn").style.display = "none";
  document.getElementById("topicInput").value = "";
});

// ── MODE TOGGLE ───────────────────────────────────────────────────────────

document.getElementById("strictBtn").addEventListener("click", () => setMode("strict"));
document.getElementById("casualBtn").addEventListener("click", () => setMode("casual"));

function setMode(mode, broadcast = true) {
  currentMode = mode;
  chrome.storage.local.set({ currentMode: mode });
  document.getElementById("strictBtn").classList.toggle("active", mode === "strict");
  document.getElementById("casualBtn").classList.toggle("active", mode === "casual");

  if (broadcast) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SET_MODE", mode });
    });
  }
}

// ── TIMER ────────────────────────────────────────────────────────────────

document.getElementById("timerBtn").addEventListener("click", () => {
  if (timerRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
});

document.getElementById("resetTimerBtn").addEventListener("click", () => {
  clearInterval(timerInterval);
  timerRunning = false;
  timeLeft = 25 * 60;
  updateTimerDisplay();
  document.getElementById("timerBtn").textContent = "▶ Start";
});

function startTimer() {
  timerRunning = true;
  document.getElementById("timerBtn").textContent = "⏸ Pause";
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      timerRunning = false;
      document.getElementById("timerBtn").textContent = "▶ Start";
      timeLeft = 5 * 60; // 5 min break
      onSessionComplete();
    }
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  document.getElementById("timerBtn").textContent = "▶ Resume";
}

function updateTimerDisplay() {
  const m = Math.floor(timeLeft / 60).toString().padStart(2, "0");
  const s = (timeLeft % 60).toString().padStart(2, "0");
  document.getElementById("timerDisplay").textContent = `${m}:${s}`;
}

async function onSessionComplete() {
  // Track session
  chrome.storage.local.get("analytics", (data) => {
    const a = data.analytics || {};
    a.sessionsCompleted = (a.sessionsCompleted || 0) + 1;
    a.totalFocusMinutes = (a.totalFocusMinutes || 0) + 25;
    const today = new Date().toISOString().split("T")[0];
    if (!a.dailyStats) a.dailyStats = {};
    if (!a.dailyStats[today]) a.dailyStats[today] = { blockedVideos: 0, shortsBlocked: 0, blockedSearches: 0, focusMinutes: 0 };
    a.dailyStats[today].focusMinutes = (a.dailyStats[today].focusMinutes || 0) + 25;
    chrome.storage.local.set({ analytics: a });
  });

  setStatus("☕ Break time! 5 min rest.", "green");
  setTimeout(() => {
    timeLeft = 25 * 60;
    updateTimerDisplay();
    setStatus(`✅ Active: ${activeProfile?.topic || ""}`, "green");
  }, 5 * 60 * 1000);
}

// ── REWIRE MODE ──────────────────────────────────────────────────────────

document.getElementById("rewireBtn").addEventListener("click", async () => {
  const data = await chrome.storage.local.get("rewireMode");
  const newVal = !data.rewireMode;
  await chrome.storage.local.set({ rewireMode: newVal });

  const btn = document.getElementById("rewireBtn");
  btn.classList.toggle("active", newVal);
  btn.textContent = newVal ? "🔁 Rewire: ON" : "🔁 Rewire Mode";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_REWIRE_MODE", enabled: newVal });
  }
});

// ── OPEN DASHBOARD ───────────────────────────────────────────────────────

document.getElementById("dashboardBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// ── STATS REFRESH ────────────────────────────────────────────────────────

async function refreshStats() {
  const data = await chrome.storage.local.get("analytics");
  if (data.analytics) updateStatsUI(data.analytics);
}

function updateStatsUI(a) {
  document.getElementById("blockedCount").textContent = a.blockedVideos || 0;
  document.getElementById("shortsCount").textContent = a.shortsBlocked || 0;
  document.getElementById("timeSaved").textContent = `${a.timeSaved || 0}m`;
}

// ── HELPERS ──────────────────────────────────────────────────────────────

function setStatus(msg, type = "dim") {
  const el = document.getElementById("statusMsg");
  el.textContent = msg;
  el.style.color = type === "green" ? "#4ade80" :
                   type === "red"   ? "#ff4444" : "#888";
}
