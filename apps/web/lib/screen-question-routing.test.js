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
