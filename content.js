// content.js — FocusRewire main content script

let focusProfile = null;
let currentMode = "strict";
let rewireMode = false;
let mainObserver = null;
let filterInterval = null;
let searchGuardActive = false;
const cardDecisions = new WeakMap();

// ── VIDEO QUEUE ───────────────────────────────────────────────────────────
// Stores on-topic video {title, url, videoId} objects collected from feed/search.
// When a watched video ends, we play the next one from this queue.
let videoQueue = [];
let videoQueueIndex = 0;

// ── BOOT ──────────────────────────────────────────────────────────────────

chrome.storage.local.get(
  ["activeFocusProfile", "currentMode", "rewireMode", "videoQueue", "videoQueueIndex"],
  (data) => {
    if (data.currentMode) currentMode = data.currentMode;
    if (data.videoQueue) { videoQueue = data.videoQueue; }
    if (data.videoQueueIndex) { videoQueueIndex = data.videoQueueIndex; }
    if (data.activeFocusProfile) {
      focusProfile = data.activeFocusProfile;
      startFiltering();
      if (!searchGuardActive) {
        initSearchGuard(focusProfile, currentMode);
        searchGuardActive = true;
      }
    }
    if (data.rewireMode) { rewireMode = true; activateRewireMode(); }
  }
);

// ── MESSAGES ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "START_FILTERING") {
    focusProfile = message.profile;
    videoQueue = [];
    videoQueueIndex = 0;
    startFiltering();
    if (!searchGuardActive) {
      initSearchGuard(focusProfile, currentMode);
      searchGuardActive = true;
    }
    trackTopic(message.profile.topic);
  }
  if (message.type === "SET_MODE") { currentMode = message.mode; _sgMode = message.mode; }
  if (message.type === "SET_REWIRE_MODE") {
    rewireMode = message.enabled;
    rewireMode ? activateRewireMode() : deactivateRewireMode();
  }
});

// ── CORE ENGINE ───────────────────────────────────────────────────────────

function startFiltering() {
  [0, 300, 700, 1200, 2000, 3500].forEach(ms => setTimeout(runPageFilter, ms));
  if (filterInterval) clearInterval(filterInterval);
  filterInterval = setInterval(runPageFilter, 700);
  if (mainObserver) mainObserver.disconnect();
  mainObserver = new MutationObserver(runPageFilter);
  mainObserver.observe(document.body, { childList: true, subtree: true });
  blockShortsNavigation();
}

function runPageFilter() {
  if (!focusProfile) return;
  const path = location.pathname;
  hideDistractingElements();

  if (path.startsWith("/shorts")) {
    filterShortsPage();
  } else if (path.startsWith("/watch")) {
    applyWatchPageMode();
  } else {
    filterFeedCards();
    collectVideoQueue(); // build the queue from visible on-topic cards
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: FEED FILTER (homepage + search results)
// Filters cards and collects allowed ones into the video queue.
// ─────────────────────────────────────────────────────────────────────────

function filterFeedCards() {
  document.querySelectorAll([
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer"
  ].join(",")).forEach(card => {
    // Block Shorts overlay cards
    if (card.querySelector("[overlay-style='SHORTS']")) {
      killCard(card, "short");
      return;
    }
    const title = extractTitle(card);
    if (!title) { cardDecisions.delete(card); return; }
    if (cardDecisions.get(card) === title) return;
    cardDecisions.set(card, title);

    if (shouldBlock(title, focusProfile)) {
      killCard(card, "video", title);
    } else {
      card.style.removeProperty("display");
    }
  });
}

// Collect all currently visible on-topic video links from the feed
function collectVideoQueue() {
  const newQueue = [];
  document.querySelectorAll([
    "ytd-rich-item-renderer a#thumbnail[href]",
    "ytd-video-renderer a#thumbnail[href]",
    "ytd-grid-video-renderer a#thumbnail[href]"
  ].join(",")).forEach(link => {
    const card = link.closest(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer"
    );
    if (!card || card.style.display === "none") return;

    const href = link.getAttribute("href") || "";
    if (!href.includes("/watch")) return;

    const urlParams = new URLSearchParams(href.split("?")[1] || "");
    const videoId = urlParams.get("v");
    if (!videoId) return;

    const title = extractTitle(card);
    if (!title || shouldBlock(title, focusProfile)) return;

    newQueue.push({ videoId, title, url: "https://www.youtube.com" + href });
  });

  if (newQueue.length > 0) {
    videoQueue = newQueue;
    videoQueueIndex = 0;
    chrome.storage.local.set({ videoQueue, videoQueueIndex });
  }
}

function killCard(card, type, title = "") {
  card.style.setProperty("display", "none", "important");
  if (!card.dataset.frTracked) {
    card.dataset.frTracked = "1";
    if (type === "short") trackStat("shortsBlocked");
    else { trackStat("blockedVideos"); if (title) logEvent("video", title); }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: WATCH PAGE
//
// Goal: Show ONLY the video. No sidebar recommendations at all.
// Inject a minimal "Now Watching" panel in the sidebar space.
// When video ends → play next from queue.
// ─────────────────────────────────────────────────────────────────────────

let watchPageSetup = false;
let videoEndedListenerAttached = false;

function applyWatchPageMode() {
  // Hide the entire sidebar — no recommendations, no autoplay cards
  hideSidebar();

  // Inject our custom "Now Watching" panel once
  if (!document.getElementById("fr-watch-panel")) {
    injectWatchPanel();
    watchPageSetup = false; // force re-setup on new page
  }

  // Attach video ended listener
  if (!videoEndedListenerAttached) {
    attachVideoEndedListener();
    videoEndedListenerAttached = false; // will be set true inside
  }
}

function hideSidebar() {
  // All possible sidebar containers YouTube uses
  const sidebarSelectors = [
    "#secondary",
    "#secondary-inner",
    "ytd-watch-next-secondary-results-renderer",
    "#related",
    "ytd-compact-autoplay-renderer"
  ];
  sidebarSelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.style.setProperty("display", "none", "important");
  });
}

function injectWatchPanel() {
  // Don't inject if already there
  if (document.getElementById("fr-watch-panel")) return;

  // Find the current video title from the watch page
  const pageTitle = (
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.innerText ||
    document.querySelector("#title h1")?.innerText ||
    document.querySelector("h1.style-scope")?.innerText ||
    document.title.replace("- YouTube", "").trim()
  );

  const panel = document.createElement("div");
  panel.id = "fr-watch-panel";
  panel.style.cssText = `
    position: sticky;
    top: 70px;
    width: 402px;
    background: #111;
    border: 1px solid #222;
    border-radius: 12px;
    padding: 20px;
    font-family: 'Segoe UI', sans-serif;
    color: #f0f0f0;
    margin-left: 16px;
    box-sizing: border-box;
  `;

  const queueLen = videoQueue.length;
  const queueInfo = queueLen > 0
    ? `<div style="color:#888;font-size:12px;margin-top:8px">${queueLen} on-topic video${queueLen !== 1 ? "s" : ""} queued</div>`
    : `<div style="color:#555;font-size:12px;margin-top:8px">No queue — go to feed to build one</div>`;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <div style="width:8px;height:8px;background:#ff4444;border-radius:50%;animation:frPulse 1.5s infinite"></div>
      <span style="font-size:11px;color:#ff4444;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">FocusRewire Active</span>
    </div>
    <div style="font-size:13px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;font-size:10px">Now Watching</div>
    <div id="fr-panel-title" style="font-size:14px;font-weight:600;color:#fff;line-height:1.4;margin-bottom:12px">
      ${pageTitle || "Loading..."}
    </div>
    <div style="background:#1a1a1a;border-radius:8px;padding:10px 12px;margin-bottom:14px">
      <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Topic</div>
      <div style="font-size:13px;color:#ff4444;font-weight:600">${focusProfile?.topic || "—"}</div>
    </div>
    ${queueInfo}
    <div id="fr-next-info" style="margin-top:12px;display:none">
      <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Up Next</div>
      <div id="fr-next-title" style="font-size:12px;color:#aaa;line-height:1.4"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="fr-back-btn" style="
        flex:1;padding:9px;background:#1a1a1a;border:1px solid #333;
        border-radius:8px;color:#888;font-size:12px;cursor:pointer;font-family:'Segoe UI',sans-serif">
        ← Back to Feed
      </button>
      <button id="fr-next-btn" style="
        flex:1;padding:9px;background:#ff4444;border:none;
        border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:'Segoe UI',sans-serif">
        Next Video →
      </button>
    </div>
    <style>
      @keyframes frPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.8)} }
      #fr-back-btn:hover{border-color:#ff4444;color:#ff4444}
      #fr-next-btn:hover{background:#cc2222}
    </style>
  `;

  // Try to inject into the secondary column
  const secondary = document.querySelector("#secondary, #secondary-inner");
  if (secondary) {
    secondary.style.removeProperty("display"); // un-hide the container div
    secondary.style.overflow = "visible";
    secondary.innerHTML = ""; // clear any remaining recommendation content
    secondary.appendChild(panel);
  } else {
    // Fallback: inject beside the player
    const player = document.querySelector("#primary, ytd-watch-flexy");
    if (player) player.insertAdjacentElement("afterend", panel);
    else document.body.appendChild(panel);
  }

  // Show "Up Next" info if queue exists
  updateNextVideoInfo();

  // Wire buttons
  document.getElementById("fr-back-btn").addEventListener("click", () => {
    history.back();
  });
  document.getElementById("fr-next-btn").addEventListener("click", () => {
    playNextFromQueue();
  });
}

function updateNextVideoInfo() {
  const nextIdx = (videoQueueIndex + 1) % Math.max(videoQueue.length, 1);
  const next = videoQueue[nextIdx];
  const nextInfo = document.getElementById("fr-next-info");
  const nextTitle = document.getElementById("fr-next-title");
  if (nextInfo && nextTitle && next) {
    nextInfo.style.display = "block";
    nextTitle.textContent = next.title;
  }
}

function attachVideoEndedListener() {
  // Poll for the video element — it may not exist yet when this first runs
  const tryAttach = () => {
    const video = document.querySelector("video.html5-main-video, video#movie_player video, video");
    if (video && !video.dataset.frEndedListener) {
      video.dataset.frEndedListener = "1";
      videoEndedListenerAttached = true;
      video.addEventListener("ended", () => {
        playNextFromQueue();
      });
      return true;
    }
    return false;
  };

  if (!tryAttach()) {
    // Retry until video element appears
    const retryInterval = setInterval(() => {
      if (tryAttach()) clearInterval(retryInterval);
    }, 500);
    // Give up after 10 seconds
    setTimeout(() => clearInterval(retryInterval), 10000);
  }
}

function playNextFromQueue() {
  if (videoQueue.length === 0) {
    // No queue — go back to feed
    window.location.href = "/";
    return;
  }
  videoQueueIndex = (videoQueueIndex + 1) % videoQueue.length;
  chrome.storage.local.set({ videoQueueIndex });
  window.location.href = videoQueue[videoQueueIndex].url;
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: SHORTS PAGE
//
// Strategy: Watch document.title changes (YouTube always updates this tag
// when navigating to a new short). Extract title from there — it's the
// most reliable source. Remove() off-topic reel elements entirely from DOM.
// ─────────────────────────────────────────────────────────────────────────

let titleObserver = null;
let lastCheckedTitle = "";
let shortsFilterInterval = null;

function filterShortsPage() {
  if (!focusProfile) return;
  
  if (!titleObserver) {
    const titleEl = document.querySelector("title");
    if (titleEl) {
      titleObserver = new MutationObserver(() => {
        checkCurrentShort();
      });
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  if (!shortsFilterInterval) {
    shortsFilterInterval = setInterval(() => {
      checkCurrentShort();
      removeOffTopicReels();
    }, 800);
  }

  checkCurrentShort();
  removeOffTopicReels();
}

function checkCurrentShort() {
  const rawTitle = document.title || "";
  const title = rawTitle
    .replace(/\s*[-–|]\s*YouTube\s*$/i, "")
    .replace(/#shorts\b/gi, "")
    .trim();

  if (!title || title === lastCheckedTitle) return;
  if (title.toLowerCase() === "youtube" || title.toLowerCase() === "shorts") return;

  lastCheckedTitle = title;

  if (shouldBlock(title, focusProfile)) {
    removeActiveShort(title);
    trackStat("shortsBlocked");
    logEvent("short", title);
  }
}

function removeActiveShort(blockedTitle) {
  // The currently playing reel is marked as "active" or is the first visible one
  document.querySelectorAll("ytd-reel-video-renderer").forEach(reel => {
    if (reel.dataset.frRemoved) return;

    const reelTitle = extractReelTitle(reel);

    // Match by extracted title, or by document.title match
    const isActive = (
      reel.hasAttribute("is-active") ||
      reel.getAttribute("is-active") !== null ||
      reel.classList.contains("iron-selected") ||
      reel.style.transform === "translateY(0px)" ||
      reel.style.transform === ""
    );

    if (
      reelTitle === blockedTitle ||
      (isActive && (reelTitle === blockedTitle || !reelTitle))
    ) {
      reel.dataset.frRemoved = "1";
      reel.remove(); // physically remove from DOM
    }
  });
}

// Remove ALL reel-video-renderer elements whose titles are off-topic
function removeOffTopicReels() {
  if (!focusProfile) return;

  document.querySelectorAll("ytd-reel-video-renderer:not([data-fr-removed])").forEach(reel => {
    const title = extractReelTitle(reel);
    if (!title) return; // not loaded yet — don't remove

    if (shouldBlock(title, focusProfile)) {
      reel.dataset.frRemoved = "1";
      reel.remove(); // physically remove from DOM stack
      trackStat("shortsBlocked");
      logEvent("short", title);
    }
  });

  // Also remove off-topic shorts from the thumbnail grid view
  document.querySelectorAll("ytd-reel-item-renderer:not([data-fr-removed])").forEach(item => {
    const title = extractTitle(item);
    if (!title) return;
    if (shouldBlock(title, focusProfile)) {
      item.dataset.frRemoved = "1";
      item.remove();
      trackStat("shortsBlocked");
    }
  });
}

function extractReelTitle(reel) {
  const selectors = [
    // 2024 overlay structure
    "ytd-reel-player-overlay-renderer #title yt-formatted-string",
    "ytd-reel-player-overlay-renderer h2 yt-formatted-string",
    "ytd-reel-player-overlay-renderer h2",
    "ytd-reel-player-overlay-renderer #title",
    // Header renderer
    "ytd-reel-player-header-renderer yt-formatted-string",
    "ytd-reel-player-header-renderer span",
    // Legacy
    "#video-title",
    "yt-formatted-string#video-title",
    ".ytd-reel-video-renderer #title"
  ];

  for (const sel of selectors) {
    const el = reel.querySelector(sel);
    const text = (el?.innerText || el?.textContent || "").trim();
    if (text && text.length > 2 && !text.toLowerCase().includes("youtube")) return text;
  }

  // Try aria-label
  const aria = (reel.getAttribute("aria-label") || "").trim();
  if (aria.length > 2) return aria;

  return "";
}

// Clean up shorts-specific intervals when navigating away
function cleanupShortsObservers() {
  if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
  if (shortsFilterInterval) { clearInterval(shortsFilterInterval); shortsFilterInterval = null; }
  lastCheckedTitle = "";
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: HIDE DISTRACTING ELEMENTS
// ─────────────────────────────────────────────────────────────────────────

function hideDistractingElements() {
  const targets = [
    "ytd-feed-filter-chip-bar-renderer",
    "ytd-rich-section-renderer ytd-statement-banner-renderer",
    "ytd-rich-section-renderer ytd-banner-promo-renderer",
    "ytd-horizontal-card-list-renderer",
    "ytd-channel-renderer",
    "ytd-radio-renderer",
    "ytd-compact-radio-renderer",
    "ytd-movie-renderer",
    "ytd-compact-movie-renderer"
  ];

  document.querySelectorAll(targets.join(",")).forEach(el => {
    if (!el.dataset.frBanner) {
      el.style.setProperty("display", "none", "important");
      el.dataset.frBanner = "1";
    }
  });

  document.querySelectorAll("ytd-rich-section-renderer:not([data-fr-banner]):not([data-fr-done])").forEach(section => {
    const heading = (section.querySelector("#title")?.innerText || "").toLowerCase();
    if (
      heading.includes("explore") || heading.includes("topic") ||
      heading.includes("trending") || heading.includes("news") ||
      heading.includes("for you") || heading.includes("recommended channel") ||
      heading.includes("people also") || heading.includes("short")
    ) {
      section.style.setProperty("display", "none", "important");
      section.dataset.frBanner = "1";
    }
  });
}

// ── TITLE EXTRACTION ──────────────────────────────────────────────────────

function extractTitle(el) {
  const selectors = [
    "#video-title", "yt-formatted-string#video-title", "span#video-title",
    "#video-title.ytd-compact-video-renderer",
    "#title-text", "h3 a#video-title", "h3 span", "a[title]"
  ];
  for (const sel of selectors) {
    const node = el.querySelector(sel);
    const text = (node?.innerText || node?.textContent || node?.getAttribute("title") || "").trim();
    if (text && text.length > 1) return text;
  }
  const aria = el.getAttribute("aria-label") || "";
  if (aria.length > 2) return aria.split("\n")[0].trim();
  return "";
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────

function trackStat(key) {
  chrome.storage.local.get("analytics", (data) => {
    const a = Object.assign({
      blockedVideos: 0, shortsBlocked: 0, blockedSearches: 0,
      timeSaved: 0, sessionsCompleted: 0, totalFocusMinutes: 0,
      dailyStats: {}, topicsStudied: [], lastUpdated: null
    }, data.analytics || {});
    a[key] = (a[key] || 0) + 1;
    a.timeSaved = Math.round((a.blockedVideos || 0) * 1.5);
    const today = new Date().toISOString().split("T")[0];
    if (!a.dailyStats[today]) a.dailyStats[today] = { blockedVideos: 0, shortsBlocked: 0, blockedSearches: 0, focusMinutes: 0 };
    if (a.dailyStats[today][key] !== undefined) a.dailyStats[today][key]++;
    a.lastUpdated = Date.now();
    chrome.storage.local.set({ analytics: a });
  });
}

function logEvent(type, title) {
  chrome.storage.local.get("eventLog", (data) => {
    const log = data.eventLog || [];
    log.push({ type, title, ts: Date.now() });
    chrome.storage.local.set({ eventLog: log.slice(-200) });
  });
}

function trackTopic(topic) {
  chrome.storage.local.get("analytics", (data) => {
    const a = data.analytics || {};
    const topics = a.topicsStudied || [];
    if (!topics.includes(topic)) {
      topics.push(topic);
      chrome.storage.local.set({ analytics: { ...a, topicsStudied: topics } });
    }
  });
}

// ── PLATFORM REWIRE MODE ──────────────────────────────────────────────────

function activateRewireMode() {
  if (!location.pathname.match(/^\/($|feed\/)/)) return;
  const feed = document.querySelector("ytd-browse");
  if (feed) feed.style.display = "none";
  if (document.getElementById("fr-rewire-dashboard")) return;
  const panel = document.createElement("div");
  panel.id = "fr-rewire-dashboard";
  panel.innerHTML = `
    <style>
      #fr-rewire-dashboard{position:fixed;top:56px;left:0;right:0;bottom:0;background:#0a0a0a;
        z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;
        font-family:'Segoe UI',sans-serif;color:#f0f0f0}
      #fr-rewire-dashboard h1{font-size:2.2rem;font-weight:700;color:#ff4444;letter-spacing:-1px;margin-bottom:8px}
      .fr-sub{color:#888;font-size:14px;margin-bottom:32px}
      .fr-topic-badge{background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.3);
        color:#ff4444;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600;margin-bottom:32px}
      .fr-stats{display:flex;gap:16px;margin-bottom:32px}
      .fr-stat-box{background:#111;border:1px solid #222;border-radius:12px;padding:16px 24px;text-align:center;min-width:100px}
      .fr-stat-num{font-size:2rem;font-weight:700;color:#ff4444}
      .fr-stat-lbl{font-size:11px;color:#666;margin-top:2px}
      .fr-search-wrap{display:flex;gap:10px;align-items:center}
      #fr-search-input{padding:12px 20px;width:420px;border-radius:24px;background:#1a1a1a;
        border:1px solid #333;color:#fff;font-size:14px;outline:none}
      #fr-search-input:focus{border-color:#ff4444}
      #fr-search-btn{padding:12px 22px;background:#ff4444;border:none;border-radius:24px;
        color:#fff;font-size:14px;font-weight:600;cursor:pointer}
      .fr-hint{margin-top:20px;font-size:11px;color:#444}
      .fr-open-dash{margin-top:16px;font-size:12px;color:#666;cursor:pointer;
        text-decoration:underline;background:none;border:none}
      .fr-open-dash:hover{color:#ff4444}
    </style>
    <h1>🎯 FocusRewire</h1>
    <div class="fr-sub">YouTube homepage is hidden. Stay focused.</div>
    <div class="fr-topic-badge">${focusProfile?.topic || "No topic set"}</div>
    <div class="fr-stats">
      <div class="fr-stat-box"><div class="fr-stat-num" id="fr-stat-blocked">0</div><div class="fr-stat-lbl">Blocked Today</div></div>
      <div class="fr-stat-box"><div class="fr-stat-num" id="fr-stat-shorts">0</div><div class="fr-stat-lbl">Shorts Hidden</div></div>
      <div class="fr-stat-box"><div class="fr-stat-num" id="fr-stat-time">0m</div><div class="fr-stat-lbl">Time Saved</div></div>
    </div>
    <div class="fr-search-wrap">
      <input id="fr-search-input" type="text" placeholder="Search within your topic..." />
      <button id="fr-search-btn">Search</button>
    </div>
    <div class="fr-hint">Only on-topic content will show.</div>
    <button class="fr-open-dash" id="fr-open-dashboard">View full analytics dashboard →</button>
  `;
  document.body.appendChild(panel);
  document.getElementById("fr-search-btn").addEventListener("click", frDoSearch);
  document.getElementById("fr-search-input").addEventListener("keydown", e => { if (e.key === "Enter") frDoSearch(); });
  document.getElementById("fr-open-dashboard").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }));
  frUpdateStats();
  panel._statsInterval = setInterval(frUpdateStats, 3000);
}

function frUpdateStats() {
  chrome.storage.local.get("analytics", (data) => {
    const a = data.analytics || {};
    const today = new Date().toISOString().split("T")[0];
    const day = (a.dailyStats || {})[today] || {};
    const b = document.getElementById("fr-stat-blocked");
    const s = document.getElementById("fr-stat-shorts");
    const t = document.getElementById("fr-stat-time");
    if (b) b.textContent = day.blockedVideos || 0;
    if (s) s.textContent = day.shortsBlocked || 0;
    if (t) t.textContent = `${a.timeSaved || 0}m`;
  });
}

function frDoSearch() {
  const query = document.getElementById("fr-search-input")?.value?.trim();
  if (!query) return;
  window.location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function deactivateRewireMode() {
  const panel = document.getElementById("fr-rewire-dashboard");
  if (panel) { if (panel._statsInterval) clearInterval(panel._statsInterval); panel.remove(); }
  const feed = document.querySelector("ytd-browse");
  if (feed) feed.style.display = "";
}

// ── SPA NAVIGATION ────────────────────────────────────────────────────────

function blockShortsNavigation() {
  const blockShorts = (e) => {
    if (!focusProfile) return;
    const target = e.target;
    const sidebarLink = target.closest('ytd-guide-entry-renderer a, ytd-mini-guide-entry-renderer a');
    
    if (sidebarLink) {
      const href = sidebarLink.getAttribute('href');
      const title = sidebarLink.getAttribute('title');
      
      if (href === '/shorts' || title === 'Shorts' || href?.includes('/shorts')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showBlockMessage();
        return false;
      }
    }
  };
  
  document.addEventListener('click', blockShorts, true);
  document.addEventListener('mousedown', blockShorts, true);
  document.addEventListener('mouseup', blockShorts, true);
  
  setInterval(() => {
    if (!focusProfile) return;
    document.querySelectorAll('ytd-guide-entry-renderer a[href="/shorts"], ytd-mini-guide-entry-renderer a[href="/shorts"]').forEach(link => {
      link.style.pointerEvents = 'none';
      link.style.opacity = '0.5';
    });
  }, 500);
}

function showBlockMessage() {
  if (document.getElementById('fr-block-msg')) return;
  const msg = document.createElement('div');
  msg.id = 'fr-block-msg';
  msg.style.cssText = `
    position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
    background: #ff4444; color: #fff; padding: 16px 24px;
    border-radius: 8px; font-size: 14px; font-weight: 600;
    z-index: 10000; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    font-family: 'Segoe UI', sans-serif;
  `;
  msg.textContent = 'Shorts are blocked while IntentFeed is running';
  document.body.appendChild(msg);
  setTimeout(() => msg.remove(), 3000);
}

let lastPath = location.pathname;
new MutationObserver(() => {
  const p = location.pathname;
  if (p !== lastPath) {
    const prevPath = lastPath;
    lastPath = p;

    // Clean up shorts observers when leaving /shorts
    if (prevPath.startsWith("/shorts") && !p.startsWith("/shorts")) {
      cleanupShortsObservers();
    }

    // Clean up watch panel state when leaving /watch
    if (prevPath.startsWith("/watch") && !p.startsWith("/watch")) {
      watchPageSetup = false;
      videoEndedListenerAttached = false;
      const panel = document.getElementById("fr-watch-panel");
      if (panel) panel.remove();
    }

    if (rewireMode) { deactivateRewireMode(); setTimeout(activateRewireMode, 500); }
    if (focusProfile) [300, 700, 1400, 2500].forEach(ms => setTimeout(runPageFilter, ms));
  }
}).observe(document.body, { childList: true, subtree: true });
