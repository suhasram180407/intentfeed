// dashboard.js
// Drives all charts, stats, and UI updates for the analytics dashboard

let weeklyChartInstance = null;
let breakdownChartInstance = null;

// ── INIT ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  setHeaderDate();
  loadDashboard();

  // Refresh every 5 seconds while open
  setInterval(loadDashboard, 5000);
});

function setHeaderDate() {
  const now = new Date();
  document.getElementById("headerDate").textContent =
    now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// ── LOAD ALL DATA ─────────────────────────────────────────────────────────

function loadDashboard() {
  chrome.storage.local.get(
    ["analytics", "activeFocusProfile", "currentMode", "eventLog"],
    (data) => {
      const a = Object.assign({}, Analytics.defaultAnalytics, data.analytics || {});
      const profile = data.activeFocusProfile || null;
      const mode = data.currentMode || "strict";
      const log = data.eventLog || [];

      updateSessionBanner(profile, mode);
      updateStatCards(a);
      updateEfficiencyRing(a);
      updateWeeklyChart(a);
      updateBreakdownChart(a);
      updateTopicsList(a);
      updateSessionSummary(a);
      updateStreakRow(a);
      updateEventLog(log);
      updateFooter(a);
    }
  );
}

// ── SESSION BANNER ────────────────────────────────────────────────────────

function updateSessionBanner(profile, mode) {
  const banner = document.getElementById("sessionBanner");
  if (profile) {
    banner.style.display = "flex";
    document.getElementById("bannerTopic").textContent = profile.topic;
    const modeEl = document.getElementById("bannerMode");
    modeEl.textContent = mode.toUpperCase();
    modeEl.className = `session-mode ${mode}`;
  } else {
    banner.style.display = "none";
  }
}

// ── STAT CARDS ────────────────────────────────────────────────────────────

function updateStatCards(a) {
  animateCount("statBlocked", a.blockedVideos || 0);
  animateCount("statShorts", a.shortsBlocked || 0);
  animateCount("statSearches", a.blockedSearches || 0);
  animateCount("statTime", a.timeSaved || 0);
}

function animateCount(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  const step = Math.ceil(Math.abs(target - current) / 10);
  let val = current;
  const interval = setInterval(() => {
    val = val < target ? Math.min(val + step, target) : Math.max(val - step, target);
    el.textContent = val;
    if (val === target) clearInterval(interval);
  }, 30);
}

// ── EFFICIENCY RING ──────────────────────────────────────────────────────

function updateEfficiencyRing(a) {
  const pct = Analytics.getEfficiencyScore(a);
  document.getElementById("efficiencyPct").textContent = `${pct}%`;

  const ring = document.getElementById("efficiencyRing");
  const circumference = 2 * Math.PI * 40; // r=40
  const offset = circumference - (pct / 100) * circumference;
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = offset;

  const desc = document.getElementById("efficiencyDesc");
  if (pct === 0) {
    desc.textContent = "Start a session to track your efficiency.";
  } else if (pct < 40) {
    desc.textContent = "Many distractions encountered. Keep pushing!";
  } else if (pct < 70) {
    desc.textContent = "Good focus! You're making solid progress.";
  } else {
    desc.textContent = "Excellent focus! You're in the zone. 🔥";
  }
}

// ── WEEKLY CHART ─────────────────────────────────────────────────────────

function updateWeeklyChart(a) {
  const days = Analytics.getLast7Days(a);

  // Streak bars
  const streakRow = document.getElementById("streakRow");
  streakRow.innerHTML = days.map(d => {
    const maxH = 32;
    const total = d.blockedVideos + d.shortsBlocked + d.blockedSearches;
    const maxTotal = Math.max(...days.map(x => x.blockedVideos + x.shortsBlocked + x.blockedSearches), 1);
    const h = Math.max(4, (total / maxTotal) * maxH);
    const active = total > 0 ? "active" : "";
    return `
      <div class="streak-day">
        <div class="streak-bar ${active}" style="height:${h}px" title="${total} blocked on ${d.date}"></div>
        <div class="streak-lbl">${d.label.slice(0, 1)}</div>
      </div>
    `;
  }).join("");

  // Update week total badge
  const weekTotal = days.reduce((s, d) => s + d.blockedVideos + d.shortsBlocked + d.blockedSearches, 0);
  document.getElementById("weekTotal").textContent = `${weekTotal} this week`;

  // Bar chart
  const ctx = document.getElementById("weeklyChart").getContext("2d");
  const labels = days.map(d => d.label);
  const datasets = [
    {
      label: "Videos",
      data: days.map(d => d.blockedVideos),
      backgroundColor: "rgba(255, 68, 68, 0.8)",
      borderRadius: 4,
      borderSkipped: false
    },
    {
      label: "Shorts",
      data: days.map(d => d.shortsBlocked),
      backgroundColor: "rgba(245, 158, 11, 0.7)",
      borderRadius: 4,
      borderSkipped: false
    },
    {
      label: "Searches",
      data: days.map(d => d.blockedSearches),
      backgroundColor: "rgba(96, 165, 250, 0.7)",
      borderRadius: 4,
      borderSkipped: false
    }
  ];

  if (weeklyChartInstance) weeklyChartInstance.destroy();
  weeklyChartInstance = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#888",
            font: { size: 10 },
            boxWidth: 10,
            padding: 10
          }
        },
        tooltip: { mode: "index" }
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: "rgba(255,255,255,0.03)" },
          ticks: { color: "#666", font: { size: 10 } }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: {
            color: "#666",
            font: { size: 10 },
            precision: 0
          }
        }
      }
    }
  });
}

// ── BREAKDOWN CHART ──────────────────────────────────────────────────────

function updateBreakdownChart(a) {
  const videos = a.blockedVideos || 0;
  const shorts = a.shortsBlocked || 0;
  const searches = a.blockedSearches || 0;

  const ctx = document.getElementById("breakdownChart").getContext("2d");

  if (breakdownChartInstance) breakdownChartInstance.destroy();
  breakdownChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Videos", "Shorts", "Searches"],
      datasets: [{
        data: [videos, shorts, searches].map(v => v || 0),
        backgroundColor: [
          "rgba(255, 68, 68, 0.85)",
          "rgba(245, 158, 11, 0.85)",
          "rgba(96, 165, 250, 0.85)"
        ],
        borderColor: "#111",
        borderWidth: 2,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: {
        legend: {
          position: "right",
          labels: {
            color: "#888",
            font: { size: 10 },
            boxWidth: 10,
            padding: 8
          }
        }
      }
    }
  });
}

// ── TOPICS LIST ──────────────────────────────────────────────────────────

function updateTopicsList(a) {
  const list = document.getElementById("topicsList");
  const topics = a.topicsStudied || [];
  document.getElementById("topicCount").textContent = `${topics.length} topic${topics.length !== 1 ? "s" : ""}`;

  if (topics.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📚</div>
        No topics yet. Start a focus session!
      </div>`;
    return;
  }

  list.innerHTML = topics.slice().reverse().map(t => `
    <div class="topic-item">
      <span class="topic-name">${t}</span>
      <span class="topic-tag">STUDIED</span>
    </div>
  `).join("");
}

// ── SESSION SUMMARY ──────────────────────────────────────────────────────

function updateSessionSummary(a) {
  document.getElementById("sessionsCount").textContent = a.sessionsCompleted || 0;
  document.getElementById("focusMins").textContent = a.totalFocusMinutes || 0;
}

// ── STREAK ROW ───────────────────────────────────────────────────────────

function updateStreakRow(a) {
  // Already handled inside updateWeeklyChart
}

// ── EVENT LOG ────────────────────────────────────────────────────────────

function updateEventLog(log) {
  const logList = document.getElementById("logList");

  if (log.length === 0) {
    logList.innerHTML = `
      <div class="empty-state" style="padding:20px">
        <div class="empty-icon">📋</div>
        No activity yet.
      </div>`;
    return;
  }

  logList.innerHTML = log.slice().reverse().slice(0, 20).map(entry => {
    const dotClass = entry.type === "video" ? "block" :
                     entry.type === "short" ? "short" : "search";
    const icon = entry.type === "video" ? "🚫" :
                 entry.type === "short" ? "⚡" : "🔍";
    const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `
      <div class="log-item">
        <div class="log-dot ${dotClass}"></div>
        <span class="log-text">${icon} ${entry.title || entry.query || "Unknown"}</span>
        <span class="log-time">${time}</span>
      </div>
    `;
  }).join("");
}

// ── FOOTER ───────────────────────────────────────────────────────────────

function updateFooter(a) {
  const el = document.getElementById("footerLastUpdated");
  if (a.lastUpdated) {
    const d = new Date(a.lastUpdated);
    el.textContent = `Last updated: ${d.toLocaleTimeString()}`;
  } else {
    el.textContent = "No activity recorded yet";
  }
}

// ── ACTIONS ──────────────────────────────────────────────────────────────

function resetAnalytics() {
  if (!confirm("Reset all analytics? This cannot be undone.")) return;
  Analytics.reset(() => {
    loadDashboard();
  });
}

function exportData() {
  chrome.storage.local.get(["analytics", "activeFocusProfile", "eventLog"], (data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `focusrewire-export-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
