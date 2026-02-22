// background.js
// Service worker — handles API calls, messaging, and background tasks

const OPENROUTER_API_KEY = "place your api key";
// OR use OpenAI: const OPENAI_API_KEY = "place your api key";

// ── MESSAGE ROUTER ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "GENERATE_KEYWORDS") {
    generateKeywords(message.topic).then(sendResponse);
    return true; // keeps async channel open
  }

  if (message.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    return;
  }

  if (message.type === "CLEAR_PROFILE") {
    chrome.storage.local.remove("activeFocusProfile", () => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "CHECK_SEARCH_RELEVANCE") {
    checkSearchRelevance(message.query, message.topic).then(sendResponse);
    return true;
  }

});

// ── KEYWORD GENERATION ────────────────────────────────────────────────────

async function generateKeywords(topic) {
  // Check local cache first
  const cached = await chrome.storage.local.get(`kw_${topic}`);
  if (cached[`kw_${topic}`]) {
    const profile = cached[`kw_${topic}`];
    await chrome.storage.local.set({ activeFocusProfile: profile });
    return { success: true, profile, fromCache: true };
  }

  const prompt = `You are a focus assistant. The user wants to study: "${topic}".

Return ONLY a valid JSON object with this exact structure and no other text:
{
  "positive_keywords": [list of exactly 30 relevant keywords and multi-word phrases about ${topic}],
  "negative_keywords": [list of exactly 20 keywords that represent unrelated distractions, entertainment, or off-topic content],
  "subtopics": [list of exactly 5 specific subtopics within ${topic}]
}

Rules:
- positive_keywords: highly specific to ${topic}, include terminology, tools, concepts, names
- negative_keywords: generic entertainment, gaming, music, vlogs, unrelated tech, news, etc.
- subtopics: specific subcategories the user might search within ${topic}
- Return RAW JSON only. No markdown. No backticks. No explanation.`;

  try {
    // Try OpenRouter first
    const result = await callOpenRouter(prompt);
    if (result.success) {
      const profile = buildProfile(topic, result.data);
      await cacheProfile(topic, profile);
      return { success: true, profile };
    }
  } catch (e) {
    console.warn("OpenRouter failed, using fallback:", e.message);
  }

  // Fallback: basic generic keywords
  const fallback = buildFallbackProfile(topic);
  await cacheProfile(topic, fallback);
  return { success: true, profile: fallback, fallback: true };
}

async function callOpenRouter(prompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://focusrewire.extension",
      "X-Title": "FocusRewire"
    },
    body: JSON.stringify({
      model: "openai/gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 800
    })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "";

  // Strip markdown fences if model adds them
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  return { success: true, data: parsed };
}

function buildProfile(topic, parsed) {
  return {
    topic,
    positive_keywords: parsed.positive_keywords || [],
    negative_keywords: parsed.negative_keywords || [],
    subtopics: parsed.subtopics || [],
    threshold: 0.0,   // liberal default — lower = show more
    strict_threshold: 0.05,
    generated_at: Date.now()
  };
}

function buildFallbackProfile(topic) {
  const t = topic.toLowerCase().trim();
  const words = t.split(/\s+/);

  // Build comprehensive positive keywords from the topic
  const positive_keywords = [
    // The topic word(s) themselves
    t,
    ...words,
    // Common learning/tutorial patterns with the topic
    `${t} tutorial`,
    `${t} course`,
    `${t} for beginners`,
    `${t} beginner`,
    `${t} advanced`,
    `${t} explained`,
    `learn ${t}`,
    `${t} guide`,
    `${t} tips`,
    `${t} examples`,
    `${t} project`,
    `${t} projects`,
    `${t} crash course`,
    `${t} full course`,
    `${t} programming`,
    `${t} coding`,
    `${t} introduction`,
    `intro to ${t}`,
    `${t} in hindi`,         // common on YouTube India
    `${t} in english`,
    `${t} 2024`,
    `${t} 2025`,
    `${t} basics`,
    `${t} fundamentals`,
    `${t} complete`,
    `${t} how to`,
    `how to use ${t}`,
    `${t} for students`,
    `${t} roadmap`
  ];

  // Generic distraction keywords — things totally unrelated to studying
  const negative_keywords = [
    "funny", "prank", "vlog", "challenge", "reaction", "drama",
    "gaming", "minecraft", "fortnite", "roblox", "among us",
    "meme", "shorts", "tiktok", "music video", "song", "trailer",
    "movie", "celebrity", "gossip", "roast", "compilation",
    "unboxing", "review phone", "sneakers", "food", "travel vlog",
    "dance", "comedy", "fails", "satisfying", "asmr"
  ];

  return {
    topic,
    positive_keywords,
    negative_keywords,
    subtopics: [
      `${t} basics`,
      `${t} advanced`,
      `${t} projects`,
      `${t} interview`,
      `${t} tips`
    ],
    threshold: 0.0,      // not used anymore — shouldBlock uses hit-count logic
    generated_at: Date.now(),
    isFallback: true
  };
}

async function cacheProfile(topic, profile) {
  await chrome.storage.local.set({
    [`kw_${topic}`]: profile,
    activeFocusProfile: profile
  });
}

async function checkSearchRelevance(query, topic) {
  const prompt = `Is the search query "${query}" related to the topic "${topic}"? Answer only with YES or NO.`;
  
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://focusrewire.extension",
        "X-Title": "FocusRewire"
      },
      body: JSON.stringify({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 10
      })
    });

    if (!response.ok) return { related: false };

    const data = await response.json();
    const answer = (data.choices?.[0]?.message?.content || "").trim().toUpperCase();
    
    return { related: answer.includes("YES") };
  } catch (e) {
    return { related: false };
  }
}

// ── ALARM: daily stats rollup ─────────────────────────────────────────────

chrome.alarms.create("dailyRollup", { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dailyRollup") {
    // Trim old daily stats (keep last 30 days)
    chrome.storage.local.get("analytics", (data) => {
      const a = data.analytics;
      if (!a || !a.dailyStats) return;
      const keys = Object.keys(a.dailyStats).sort();
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(k => delete a.dailyStats[k]);
        chrome.storage.local.set({ analytics: a });
      }
    });
  }
});
