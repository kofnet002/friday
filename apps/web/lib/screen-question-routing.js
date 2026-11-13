// Two reads of the same page can differ only in typography (a curly vs a
// straight apostrophe), so fold quotes and dashes before comparing.
function normalizeQuestion(question) {
  return String(question || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
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

const SCREEN_QUESTIONS_PREFIX = 'Answer each of these';

/**
 * Turn the questions read off one page into a single answer request, so they
 * come back together on one answer page instead of one page each. `grouped`
 * forces the numbered format even for one question (scan pages, where more
 * questions may follow on the same page).
 */
function combineScreenQuestions(questions, { grouped = false } = {}) {
  const list = (questions || []).map((q) => String(q || '').trim()).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1 && !grouped) return list[0];
  const numbered = list.map((q, i) => `${i + 1}. ${q}`).join('\n\n');
  const noun = list.length === 1 ? 'on-screen question' : 'on-screen questions';
  return `${SCREEN_QUESTIONS_PREFIX} ${list.length} ${noun}, in order:\n\n${numbered}`;
}

/** True for the request text combineScreenQuestions builds for a group. */
function isScreenQuestionPrompt(text) {
  return String(text || '').startsWith(SCREEN_QUESTIONS_PREFIX);
}

/**
 * Decide what to do with questions read off the screen.
 *  - mode 'new': start an answer page with `text`.
 *  - mode 'followup': add `text` to this scan's existing answer page.
 *  - mode 'none': nothing new to answer.
 * Mid-scan (speculative) reads never prompt for review — the page is still
 * being scrolled, so a cut-off last question will be read again shortly.
 */
function planScreenAnswer({ questions, completeness, speculative, answered, hasScanEntry }) {
  const plan = planScreenQuestions(questions, speculative ? 'partial' : completeness, answered);
  const review = speculative ? null : plan.review;
  const isScan = Boolean(speculative || hasScanEntry);
  const text = combineScreenQuestions(plan.answer, { grouped: isScan });
  if (!text) return { mode: 'none', text: null, questions: [], review };
  return { mode: hasScanEntry ? 'followup' : 'new', text, questions: plan.answer, review };
}

module.exports = {
  screenQuestionAction,
  planScreenQuestions,
  normalizeQuestion,
  combineScreenQuestions,
  isScreenQuestionPrompt,
  planScreenAnswer,
  SCREEN_QUESTIONS_PREFIX,
};
