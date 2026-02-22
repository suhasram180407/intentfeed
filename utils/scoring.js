// utils/scoring.js
// Keyword scoring engine — runs entirely in the browser, no API calls

const STOPWORDS = new Set([
  "the","a","an","is","in","it","of","to","and","or","for","on","with",
  "this","that","how","what","why","when","who","which","be","are","was",
  "were","has","have","had","do","does","did","will","would","could",
  "should","may","might","by","at","from","up","about","into","through","i"
]);

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .join(" ");
}

/**
 * Score a title against the active focus profile.
 * Returns positiveHits and negativeHits counts.
 */
function scoreContent(title, profile) {
  const normalized = normalizeText(title);
  let positiveHits = 0;
  let negativeHits = 0;

  // Topic name itself — strongest signal
  const topicNorm = normalizeText(profile.topic || "");
  if (topicNorm && normalized.includes(topicNorm)) {
    positiveHits += 3;
  }

  // Positive keyword matches
  for (const kw of (profile.positive_keywords || [])) {
    const kwNorm = kw.toLowerCase().trim();
    if (!kwNorm) continue;
    if (normalized.includes(kwNorm)) {
      positiveHits += kwNorm.split(/\s+/).length > 1 ? 2 : 1;
    }
  }

  // Subtopic matches
  for (const sub of (profile.subtopics || [])) {
    const subNorm = normalizeText(sub);
    if (subNorm && normalized.includes(subNorm)) {
      positiveHits += 2;
    }
  }

  // Negative keyword matches
  for (const kw of (profile.negative_keywords || [])) {
    const kwNorm = kw.toLowerCase().trim();
    if (kwNorm && normalized.includes(kwNorm)) {
      negativeHits++;
    }
  }

  return { positiveHits, negativeHits };
}

/**
 * THE CORE FIX:
 * A video must have at least 1 positive keyword match to be shown.
 * Zero matches = blocked. This ensures the feed stays on-topic.
 *
 * Previously the bug was: non-matching videos scored 0,
 * and threshold was 0.0, so 0 < 0.0 = false = not blocked.
 * Now zero positive hits always means blocked.
 */
function shouldBlock(title, profile) {
  if (!title || !profile) return false;
  if (!profile.positive_keywords || profile.positive_keywords.length === 0) return false;

  const { positiveHits, negativeHits } = scoreContent(title, profile);

  // Zero positive matches → BLOCK
  if (positiveHits === 0) return true;

  // Has positive matches but negatives overwhelm → BLOCK
  if (negativeHits > 0 && negativeHits >= positiveHits) return true;

  // Has positive matches → ALLOW
  return false;
}
