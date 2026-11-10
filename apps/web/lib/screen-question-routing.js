function screenQuestionAction(question, completeness, recentUserQuestion) {
  const normalized = String(question || '')
    .trim()
    .toLowerCase();
  if (!normalized || completeness !== 'complete') return 'review';
  if (
    String(recentUserQuestion || '')
      .trim()
      .toLowerCase() === normalized
  )
    return 'ignore';
  return 'answer';
}

module.exports = { screenQuestionAction };
