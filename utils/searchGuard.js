// utils/searchGuard.js
// Intercepts YouTube searches and blocks/warns if off-topic

let _sgProfile = null;
let _sgMode = "strict";

function initSearchGuard(profile, mode) {
  _sgProfile = profile;
  _sgMode = mode;

  // Watch for YouTube SPA URL changes
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onUrlChange(location.href);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Intercept keyboard Enter in search bar
  document.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const searchInput = document.querySelector("input#search, input[name='search_query']");
    if (document.activeElement === searchInput && searchInput.value.trim()) {
      const query = searchInput.value.trim();
      e.preventDefault();
      e.stopImmediatePropagation();
      
      const result = await chrome.runtime.sendMessage({
        type: "CHECK_SEARCH_RELEVANCE",
        query: query,
        topic: _sgProfile.topic
      });
      
      if (result.related) {
        window.location.href = `/results?search_query=${encodeURIComponent(query)}`;
      } else {
        handleBlockedSearch(query, false);
      }
      return true;
    }
  }, true);

  // Intercept search button click
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(
      "#search-icon-legacy, button#search-icon-legacy, yt-icon-button#search-icon-legacy, [id='search-icon-legacy']"
    );
    if (btn) {
      const searchInput = document.querySelector("input#search");
      const query = searchInput?.value?.trim();
      if (query) {
        e.preventDefault();
        e.stopImmediatePropagation();
        
        const result = await chrome.runtime.sendMessage({
          type: "CHECK_SEARCH_RELEVANCE",
          query: query,
          topic: _sgProfile.topic
        });
        
        if (result.related) {
          window.location.href = `/results?search_query=${encodeURIComponent(query)}`;
        } else {
          handleBlockedSearch(query, false);
        }
      }
    }
  }, true);
}

async function onUrlChange(url) {
  if (!url.includes("/results?")) return;
  try {
    const params = new URLSearchParams(url.split("?")[1]);
    const query = params.get("search_query") || "";
    if (query) {
      const result = await chrome.runtime.sendMessage({
        type: "CHECK_SEARCH_RELEVANCE",
        query: query,
        topic: _sgProfile.topic
      });
      
      if (!result.related) {
        handleBlockedSearch(query, true);
      }
    }
  } catch (e) {}
}

function handleBlockedSearch(query, alreadyNavigated) {
  // Track it
  chrome.storage.local.get("analytics", (data) => {
    const a = data.analytics || {};
    a.blockedSearches = (a.blockedSearches || 0) + 1;
    const today = new Date().toISOString().split("T")[0];
    if (!a.dailyStats) a.dailyStats = {};
    if (!a.dailyStats[today]) a.dailyStats[today] = { blockedVideos: 0, shortsBlocked: 0, blockedSearches: 0, focusMinutes: 0 };
    a.dailyStats[today].blockedSearches++;
    a.lastUpdated = Date.now();
    chrome.storage.local.set({ analytics: a });
  });

  if (_sgMode === "strict") {
    if (alreadyNavigated) {
      history.back();
      setTimeout(() => showBlockBanner(`🚫 Off-topic search blocked: "${query}"`), 400);
    } else {
      showBlockBanner(`🚫 Off-topic search blocked: "${query}"`);
    }
  } else {
    showWarningModal(query, alreadyNavigated);
  }
}

function showBlockBanner(message) {
  document.getElementById("fr-block-banner")?.remove();
  if (!document.getElementById("fr-banner-style")) {
    const style = document.createElement("style");
    style.id = "fr-banner-style";
    style.textContent = `
      @keyframes frBannerIn {
        from { opacity:0; transform:translateX(-50%) translateY(-10px); }
        to   { opacity:1; transform:translateX(-50%) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }
  const banner = document.createElement("div");
  banner.id = "fr-block-banner";
  banner.style.cssText = `
    position:fixed; top:70px; left:50%; transform:translateX(-50%);
    background:#ff4444; color:#fff; padding:12px 24px; border-radius:10px;
    font-size:14px; font-weight:600; z-index:2147483647;
    font-family:'Segoe UI',sans-serif; box-shadow:0 8px 32px rgba(255,68,68,0.4);
    animation:frBannerIn 0.2s ease;
  `;
  banner.textContent = message;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3500);
}

function showWarningModal(query, alreadyNavigated) {
  document.getElementById("fr-warning-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "fr-warning-modal";
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.75);
    display:flex; align-items:center; justify-content:center;
    z-index:2147483647; font-family:'Segoe UI',sans-serif; backdrop-filter:blur(4px);
  `;
  modal.innerHTML = `
    <div style="background:#111;border:1px solid #2a2a2a;border-top:3px solid #ff4444;
      border-radius:14px;padding:32px;color:#f0f0f0;text-align:center;
      max-width:380px;width:90%;box-shadow:0 24px 64px rgba(0,0,0,0.6);">
      <div style="font-size:36px;margin-bottom:12px">⚠️</div>
      <h3 style="color:#ff4444;margin:0 0 8px;font-size:18px">Off-Topic Search</h3>
      <p style="color:#888;font-size:13px;margin:0 0 8px;line-height:1.5">
        <strong style="color:#ccc">"${query}"</strong><br/>seems unrelated to your focus topic.
      </p>
      <p style="color:#555;font-size:11px;margin:0 0 24px">You're in Casual Mode — you can override once.</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <button id="fr-modal-back" style="flex:1;padding:10px 16px;background:#ff4444;
          border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">
          ← Go Back
        </button>
        <button id="fr-modal-proceed" style="flex:1;padding:10px 16px;background:#222;
          border:1px solid #333;border-radius:8px;color:#888;font-size:13px;cursor:pointer">
          Continue Anyway
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("fr-modal-back").addEventListener("click", () => {
    modal.remove();
    if (alreadyNavigated) history.back();
  });
  document.getElementById("fr-modal-proceed").addEventListener("click", () => modal.remove());
}
