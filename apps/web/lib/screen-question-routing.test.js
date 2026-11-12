const test = require('node:test');
const assert = require('node:assert/strict');
const { screenQuestionAction } = require('./screen-question-routing');

test('complete unique screen question is routed to answers', () => {
  assert.equal(screenQuestionAction('  Explain Kafka partitions? ', 'complete', ''), 'answer');
});

test('complete recent duplicate is ignored after trimming and case folding', () => {
  assert.equal(
    screenQuestionAction('Explain Kafka partitions?', 'complete', ' explain kafka partitions?  '),
    'ignore',
  );
});

test('partial and uncertain questions are shown for review', () => {
  assert.equal(screenQuestionAction('How would you design this?', 'partial', ''), 'review');
  assert.equal(screenQuestionAction('How would you design this?', 'uncertain', ''), 'review');
});

const { planScreenQuestions } = require('./screen-question-routing');

test('every question on a complete page is queued, in order', () => {
  const plan = planScreenQuestions(
    ['Q1 A) x B) y', 'Q2 A) p B) q', 'Q3 explain'],
    'complete',
    new Set(),
  );
  assert.deepEqual(plan.answer, ['Q1 A) x B) y', 'Q2 A) p B) q', 'Q3 explain']);
  assert.equal(plan.review, null);
});

test('questions answered earlier this session are skipped on a rescan', () => {
  const answered = new Set(['q1 a) x b) y']);
  const plan = planScreenQuestions(['Q1  A) x B) y', 'Q2', 'Q2'], 'complete', answered);
  assert.deepEqual(plan.answer, ['Q2']);
});

test('on a partial page, the last (likely clipped) question goes to review', () => {
  const plan = planScreenQuestions(['Q1', 'Q2', 'Q3 which of the fol'], 'partial', new Set());
  assert.deepEqual(plan.answer, ['Q1', 'Q2']);
  assert.equal(plan.review, 'Q3 which of the fol');
});

test('a single partial question is reviewed, not answered', () => {
  const plan = planScreenQuestions(['How would you design'], 'uncertain', new Set());
  assert.deepEqual(plan.answer, []);
  assert.equal(plan.review, 'How would you design');
});

test('blank entries are ignored', () => {
  assert.deepEqual(planScreenQuestions(['', '  ', null], 'complete', new Set()), {
    answer: [],
    review: null,
  });
});

const { combineScreenQuestions } = require('./screen-question-routing');

test('a single question is sent as-is', () => {
  assert.equal(combineScreenQuestions(['Which is O(1)?']), 'Which is O(1)?');
});

test('several questions become one numbered request, in page order', () => {
  const combined = combineScreenQuestions(['Q1 text', 'Q2 text', 'Q3 text']);
  assert.match(combined, /^Answer each of these 3 on-screen questions/);
  assert.ok(combined.indexOf('1. Q1 text') < combined.indexOf('2. Q2 text'));
  assert.ok(combined.indexOf('2. Q2 text') < combined.indexOf('3. Q3 text'));
});

test('nothing to combine yields null', () => {
  assert.equal(combineScreenQuestions([]), null);
});

const {
  planScreenAnswer,
  isScreenQuestionPrompt,
  SCREEN_QUESTIONS_PREFIX,
} = require('./screen-question-routing');

test('mid-scan read answers visible questions in a new grouped answer, holding the last', () => {
  const plan = planScreenAnswer({
    questions: ['Q1', 'Q2', 'Q3 which of the fol'],
    completeness: 'partial',
    speculative: true,
    answered: new Set(),
    hasScanEntry: false,
  });
  assert.equal(plan.mode, 'new');
  assert.deepEqual(plan.questions, ['Q1', 'Q2']);
  assert.match(plan.text, /^Answer each of these 2 on-screen questions/);
  assert.equal(plan.review, null, 'no review prompt while still scrolling');
});

test('questions found later in the same scan are a follow-up on the same page', () => {
  const plan = planScreenAnswer({
    questions: ['Q1', 'Q2', 'Q3 full text'],
    completeness: 'complete',
    speculative: false,
    answered: new Set(['q1', 'q2']),
    hasScanEntry: true,
  });
  assert.equal(plan.mode, 'followup');
  assert.deepEqual(plan.questions, ['Q3 full text']);
  // Even one question keeps the grouped, numbered format on a scan page.
  assert.ok(isScreenQuestionPrompt(plan.text));
});

test('nothing new means nothing to send', () => {
  const plan = planScreenAnswer({
    questions: ['Q1'],
    completeness: 'complete',
    speculative: false,
    answered: new Set(['q1']),
    hasScanEntry: true,
  });
  assert.equal(plan.mode, 'none');
});

test('a single question outside a scan is asked as-is', () => {
  const plan = planScreenAnswer({
    questions: ['What is a mutex?'],
    completeness: 'complete',
    speculative: false,
    answered: new Set(),
    hasScanEntry: false,
  });
  assert.equal(plan.mode, 'new');
  assert.equal(plan.text, 'What is a mutex?');
  assert.ok(!isScreenQuestionPrompt(plan.text));
  assert.ok(SCREEN_QUESTIONS_PREFIX.length > 0);
});
