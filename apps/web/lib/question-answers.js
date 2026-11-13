// Pulls the per-question answers out of a grouped screen answer, e.g.
//   **Q2 · True or false: …**
//   - **Answer:** A) True
//   - ⚠️ Check: …
// so the answer panel can offer copy per question (by key or heading icon).

const HEADING = /^\*\*Q(\d+)\s*[·:.\-–—]/;
const ANSWER = /^[-*]\s*\*\*Answer:?\*\*:?\s*(.+)$/;
const CHECK = /⚠️\s*\*{0,2}Check/;

function clean(text) {
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/**
 * @param {string[]} texts assistant turns in thread order
 * @returns {{ label: string, answer: string, check: boolean }[]} by question number
 */
function extractQuestionAnswers(texts) {
  const byNumber = new Map();
  for (const text of texts || []) {
    let current = null;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      const heading = line.match(HEADING);
      if (heading) {
        current = { number: Number(heading[1]), answer: null, check: false };
        byNumber.set(current.number, current);
        continue;
      }
      if (!current) continue;
      const answer = line.match(ANSWER);
      // A block that still holds several Answer lines (a visible self-correction)
      // copies the last one, the model's final word.
      if (answer) current.answer = clean(answer[1]);
      else if (CHECK.test(line)) current.check = true;
    }
  }
  return [...byNumber.values()]
    .filter((qa) => qa.answer)
    .sort((a, b) => a.number - b.number)
    .map((qa) => ({ label: `Q${qa.number}`, answer: qa.answer, check: qa.check }));
}

const HEADING_TEXT = /^Q(\d+)\s*[·:.\-–—]/;

/**
 * The question label ("Q2") of a rendered heading's text, e.g. the bold
 * "Q2 · True or false: …", or null when the text isn't a question heading.
 * @param {string} text
 * @returns {string | null}
 */
function headingLabel(text) {
  const match = String(text || '')
    .trim()
    .match(HEADING_TEXT);
  return match ? `Q${Number(match[1])}` : null;
}

const SINGLE_QUESTION = /^\*\*💬\s*Question:?\*\*:?\s*Q(\d+)\s*[·:.\-–—]\s*(.+)$/;
const STAR_ANSWER = /^\*\*⭐\s*Answer:?\*\*:?\s*$/;
const BULLET = /^([-*])\s+(.*)$/;

/**
 * A screen question answered on its own (a later question in a scan) comes
 * back in the single-question layout:
 *   **💬 Question:** Q7 — title
 *   **⭐ Answer:**
 *   - …
 * Rewrite it as the grouped layout (**Q7 · title** / - **Answer:** …) so a
 * scan's answers read as one list and every question can be copied.
 * Anything else is returned unchanged.
 * @param {string} text
 * @returns {string}
 */
function asQuestionBlocks(text) {
  const lines = String(text || '').split('\n');
  if (!lines.some((line) => SINGLE_QUESTION.test(line.trim()))) return String(text || '');
  const out = [];
  let inQuestion = false;
  let labelNextBullet = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const question = trimmed.match(SINGLE_QUESTION);
    if (question) {
      out.push(`**Q${Number(question[1])} · ${question[2].replace(/\*\*/g, '').trim()}**`);
      inQuestion = true;
      labelNextBullet = false;
      continue;
    }
    if (inQuestion && STAR_ANSWER.test(trimmed)) {
      labelNextBullet = true;
      continue;
    }
    // Drop the blank lines between the heading, the ⭐ line and the bullets.
    if (inQuestion && !trimmed && (labelNextBullet || out[out.length - 1]?.startsWith('**Q'))) {
      continue;
    }
    const bullet = labelNextBullet ? trimmed.match(BULLET) : null;
    if (bullet) {
      out.push(
        /^\*\*Answer:?\*\*/.test(bullet[2]) ? trimmed : `${bullet[1]} **Answer:** ${bullet[2]}`,
      );
      labelNextBullet = false;
      inQuestion = false;
      continue;
    }
    if (trimmed) {
      labelNextBullet = false;
      inQuestion = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

module.exports = { extractQuestionAnswers, headingLabel, asQuestionBlocks };
