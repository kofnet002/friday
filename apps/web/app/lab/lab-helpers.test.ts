import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkRubric, problemToQuestion, wordCount } from './lab-helpers.ts';

test('screen question is passed through verbatim', () => {
  const q = problemToQuestion({
    is_coding_problem: false,
    is_screen_question: true,
    question: '  Write the customer reply.\nKeep it under 250 words.  ',
    confidence: 0.9,
  });
  assert.equal(q, 'Write the customer reply.\nKeep it under 250 words.');
});

test('coding problem keeps examples, constraints and signature', () => {
  const q = problemToQuestion({
    is_coding_problem: true,
    title: 'Two Sum',
    problem_statement: 'Return indices of two numbers adding to target.',
    examples: [{ input: 'nums = [2,7], target = 9', output: '[0,1]', explanation: '2 + 7 = 9' }],
    constraints: ['2 <= nums.length <= 10^4'],
    function_signature: 'def twoSum(nums, target):',
    confidence: 0.95,
  });
  assert.match(q, /^Two Sum/);
  assert.match(
    q,
    /Example 1:\nInput: nums = \[2,7\], target = 9\nOutput: \[0,1\]\nExplanation: 2 \+ 7 = 9/,
  );
  assert.match(q, /Constraints:\n- 2 <= nums.length <= 10\^4/);
  assert.match(q, /def twoSum\(nums, target\):$/);
});

test('rubric lines match any alternative, case-insensitively', () => {
  const checks = checkRubric(
    'Map StripeInvalidRequestError to a 4XX. Send a Payment Link.',
    'invalidrequesterror\npayment link | checkout link\n\nsilently replace | lose their membership',
  );
  assert.deepEqual(checks, [
    { label: 'invalidrequesterror', hit: true },
    { label: 'payment link | checkout link', hit: true },
    { label: 'silently replace | lose their membership', hit: false },
  ]);
});

test('word count ignores surrounding whitespace', () => {
  assert.equal(wordCount('  one two\nthree  '), 3);
  assert.equal(wordCount('   '), 0);
});
