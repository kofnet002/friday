const test = require('node:test');
const assert = require('node:assert/strict');
const { extractQuestionAnswers } = require('./question-answers');

const grouped = `**Q1 · Which region had the highest return rate?**
- **Answer:** C) Highland
- Highland: 480 / 12,000 = 4.0%.

**Q2 · True or false: delivery time halved?**
- **Answer:** A) True
- 4 days to 2.
- ⚠️ Check: the year label was partly cut off.

**Q3 · Increase in Highland's shipments**
- **Answer:** **B) 2,000**
- 12,000 – 10,000 = 2,000.`;

test('reads each numbered question and its answer, in order', () => {
  assert.deepEqual(extractQuestionAnswers([grouped]), [
    { label: 'Q1', answer: 'C) Highland', check: false },
    { label: 'Q2', answer: 'A) True', check: true },
    { label: 'Q3', answer: 'B) 2,000', check: false },
  ]);
});

test('later turns add questions and override a repeated label', () => {
  const followUp = `**Q4 · Next one**\n- **Answer:** D) None\n\n**Q2 · Revised**\n- **Answer:** B) False`;
  assert.deepEqual(
    extractQuestionAnswers([grouped, followUp]).map((qa) => `${qa.label}=${qa.answer}`),
    ['Q1=C) Highland', 'Q2=B) False', 'Q3=B) 2,000', 'Q4=D) None'],
  );
});

test('ordinary answers without Q blocks yield nothing', () => {
  assert.deepEqual(
    extractQuestionAnswers(['**💬 Question:** What is X?\n\n**⭐ Answer:**\n- It is Y.']),
    [],
  );
});
