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

test('headingLabel recognises a question heading', () => {
  const { headingLabel } = require('./question-answers');
  assert.equal(headingLabel('Q2 · True or false: delivery time halved?'), 'Q2');
  assert.equal(headingLabel('Q12: Something'), 'Q12');
  assert.equal(headingLabel('Answer:'), null);
  assert.equal(headingLabel('Quarterly · revenue'), null);
});

test('asQuestionBlocks turns a single-question answer into a Q heading block', () => {
  const { asQuestionBlocks } = require('./question-answers');
  const single = `**💬 Question:** Q7 — North March + June orders minus Online Q4 sales

**⭐ Answer:**
- **Answer:** A) 58
- Figure 1: Mar ≈ 50.`;
  assert.equal(
    asQuestionBlocks(single),
    `**Q7 · North March + June orders minus Online Q4 sales**
- **Answer:** A) 58
- Figure 1: Mar ≈ 50.`,
  );
  // The answer bullet gets its label when the model left it off.
  const unlabeled = `**💬 Question:** Q7: Result?\n\n**⭐ Answer:**\n- **B) 68**\n- Sum = 120.`;
  assert.equal(
    asQuestionBlocks(unlabeled),
    `**Q7 · Result?**\n- **Answer:** **B) 68**\n- Sum = 120.`,
  );
  assert.deepEqual(extractQuestionAnswers([asQuestionBlocks(unlabeled)]), [
    { label: 'Q7', answer: 'B) 68', check: false },
  ]);
});

test('asQuestionBlocks leaves other answers alone', () => {
  const { asQuestionBlocks } = require('./question-answers');
  const spoken = '**💬 Question:** What is a mutex?\n\n**⭐ Answer:**\n- A lock.';
  assert.equal(asQuestionBlocks(spoken), spoken);
  const grouped = '**Q1 · Title**\n- **Answer:** B) April';
  assert.equal(asQuestionBlocks(grouped), grouped);
});

test('a block with several Answer lines copies the last one', () => {
  const corrected = `**Q7 · Result?**
- **Answer:** A) 58
- The earlier sum was wrong.
- **Answer:** B) 68`;
  assert.deepEqual(extractQuestionAnswers([corrected]), [
    { label: 'Q7', answer: 'B) 68', check: false },
  ]);
});

test('asQuestionBlocks labels a plain-paragraph answer and keeps it apart from the heading', () => {
  const { asQuestionBlocks } = require('./question-answers');
  const plain = `**💬 Question:** Q7 — Result?\n\n**⭐ Answer:**\n\nB) 68\n\nSum = 120.`;
  assert.equal(asQuestionBlocks(plain), `**Q7 · Result?**\n\n**Answer:** B) 68\n\nSum = 120.`);
  assert.deepEqual(extractQuestionAnswers([asQuestionBlocks(plain)]), [
    { label: 'Q7', answer: 'B) 68', check: false },
  ]);
});

test('asQuestionBlocks rewrites every question when a text holds several', () => {
  const { asQuestionBlocks } = require('./question-answers');
  const two = `**💬 Question:** Q6 — First?\n\n**⭐ Answer:**\n- C) Highland\n- Why.\n\n**💬 Question:** Q7 — Second?\n\n**⭐ Answer:**\nB) 68`;
  assert.equal(
    asQuestionBlocks(two),
    `**Q6 · First?**\n- **Answer:** C) Highland\n- Why.\n\n**Q7 · Second?**\n\n**Answer:** B) 68`,
  );
  assert.deepEqual(
    extractQuestionAnswers([asQuestionBlocks(two)]).map((qa) => `${qa.label}=${qa.answer}`),
    ['Q6=C) Highland', 'Q7=B) 68'],
  );
});
