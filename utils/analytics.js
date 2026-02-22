// utils/analytics.js
// Centralized analytics tracking and retrieval

const Analytics = (() => {

  // Default analytics structure
  const defaultAnalytics = {
    blockedVideos: 0,
    shortsBlocked: 0,
    blockedSearches: 0,
    timeSaved: 0,
    sessionsCompleted: 0,
    totalFocusMinutes: 0,
    dailyStats: {},     // { "YYYY-MM-DD": { blockedVideos, shorts, searches, minutes } }
    weeklyStats: [],    // last 7 days summary
    topicsStudied: [],  // list of topics used
    lastUpdated: null
  };

  // Get today's date key
  function todayKey() {
    return new Date().toISOString().split("T")[0];
  }

  // Increment a specific counter
  function track(key, amount = 1) {
    chrome.storage.local.get("analytics", (data) => {
      const a = Object.assign({}, defaultAnalytics, data.analytics || {});

      // Global count
      a[key] = (a[key] || 0) + amount;

      // Recalculate time saved
      a.timeSaved = Math.round(a.blockedVideos * 1.5);

      // Daily stat
      const today = todayKey();
      if (!a.dailyStats[today]) {
        a.dailyStats[today] = {
          blockedVideos: 0,
          shortsBlocked: 0,
          blockedSearches: 0,
          focusMinutes: 0
        };
      }
      if (a.dailyStats[today][key] !== undefined) {
        a.dailyStats[today][key] += amount;
      }

      a.lastUpdated = Date.now();
      chrome.storage.local.set({ analytics: a });
    });
  }

  // Add focus session time
  function trackSession(durationMinutes) {
    chrome.storage.local.get("analytics", (data) => {
      const a = Object.assign({}, defaultAnalytics, data.analytics || {});
      a.sessionsCompleted = (a.sessionsCompleted || 0) + 1;
      a.totalFocusMinutes = (a.totalFocusMinutes || 0) + durationMinutes;

      const today = todayKey();
      if (!a.dailyStats[today]) {
        a.dailyStats[today] = { blockedVideos: 0, shortsBlocked: 0, blockedSearches: 0, focusMinutes: 0 };
      }
      a.dailyStats[today].focusMinutes = (a.dailyStats[today].focusMinutes || 0) + durationMinutes;

      chrome.storage.local.set({ analytics: a });
    });
  }

  // Add topic to studied list
  function trackTopic(topic) {
    chrome.storage.local.get("analytics", (data) => {
      const a = Object.assign({}, defaultAnalytics, data.analytics || {});
      if (!a.topicsStudied.includes(topic)) {
        a.topicsStudied.push(topic);
      }
      chrome.storage.local.set({ analytics: a });
    });
  }

  // Get last 7 days data for chart
  function getLast7Days(analytics) {
    const result = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      const dayLabel = d.toLocaleDateString("en-US", { weekday: "short" });
      const stat = (analytics.dailyStats || {})[key] || {};
      result.push({
        date: key,
        label: dayLabel,
        blockedVideos: stat.blockedVideos || 0,
        shortsBlocked: stat.shortsBlocked || 0,
        blockedSearches: stat.blockedSearches || 0,
        focusMinutes: stat.focusMinutes || 0
      });
    }
    return result;
  }

  // Calculate efficiency score (0-100)
  function getEfficiencyScore(analytics) {
    const allowed = analytics.totalFocusMinutes || 0;
    const blocked = analytics.blockedVideos || 0;
    if (allowed + blocked === 0) return 0;
    return Math.round((allowed / (allowed + blocked)) * 100);
  }

  // Reset all analytics
  function reset(callback) {
    chrome.storage.local.set({ analytics: { ...defaultAnalytics } }, callback);
  }

  return { track, trackSession, trackTopic, getLast7Days, getEfficiencyScore, reset, defaultAnalytics };
})();
