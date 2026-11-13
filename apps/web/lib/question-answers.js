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
      if (answer && current.answer === null) current.answer = clean(answer[1]);
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

module.exports = { extractQuestionAnswers, headingLabel };
