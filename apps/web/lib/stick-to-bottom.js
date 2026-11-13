// "Stick to bottom" for streaming text: a scroller follows new content only
// while the reader is at (or within a small margin of) the bottom. Scrolling
// up to re-read stops following; scrolling back down resumes it.

const STICK_THRESHOLD_PX = 48;

/**
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} el
 * @param {number} [threshold]
 * @returns {boolean}
 */
function isNearBottom(el, threshold = STICK_THRESHOLD_PX) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

module.exports = { isNearBottom, STICK_THRESHOLD_PX };
