function normalizeQuestion(question) {
  return String(question || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function screenQuestionAction(question, completeness, recentUserQuestion) {
  const normalized = normalizeQuestion(question);
  if (!normalized || completeness !== 'complete') return 'review';
  if (normalizeQuestion(recentUserQuestion) === normalized) return 'ignore';
  return 'answer';
}

/**
 * Decide which on-screen questions to answer. Every distinct question is
 * answered in page order, except ones already answered this session (a
 * rescan or the watcher seeing the same page again). When the page was only
 * partly captured, the last question is the one most likely cut off, so it
 * is held for review instead of being answered from a fragment.
 */
function planScreenQuestions(questions, completeness, answered) {
  const seen = new Set();
  const fresh = [];
  for (const raw of questions || []) {
    const question = String(raw || '').trim();
    const key = normalizeQuestion(question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (answered && answered.has(key)) continue;
    fresh.push(question);
  }
  if (completeness === 'complete' || !fresh.length) return { answer: fresh, review: null };
  return { answer: fresh.slice(0, -1), review: fresh[fresh.length - 1] };
}

/**
 * Turn the questions read off one page into a single answer request, so they
 * come back together on one answer page instead of one page each.
 */
function combineScreenQuestions(questions) {
  const list = (questions || []).map((q) => String(q || '').trim()).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const numbered = list.map((q, i) => `${i + 1}. ${q}`).join('\n\n');
  return `Answer each of these ${list.length} on-screen questions, in order:\n\n${numbered}`;
}

module.exports = {
  screenQuestionAction,
  planScreenQuestions,
  normalizeQuestion,
  combineScreenQuestions,
};
