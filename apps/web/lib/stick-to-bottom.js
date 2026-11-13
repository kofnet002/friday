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

// Scroll events we caused ourselves (revealing a new answer, following the
// bottom) arrive a frame later; this long after our own scroll they are ignored.
const OWN_SCROLL_QUIET_MS = 150;

/**
 * "Pinned" state for the Screen tab, where answers grow inside a shared
 * scroller: a new answer page starts unpinned (its start stays in view) and
 * only the reader scrolling to the bottom pins it; scrolling up unpins.
 * @param {{ quietMs?: number }} [options]
 */
function screenPin({ quietMs = OWN_SCROLL_QUIET_MS } = {}) {
  let pinned = false;
  let quietUntil = -Infinity;
  return {
    get pinned() {
      return pinned;
    },
    /** A new answer page arrived; call before revealing its start. */
    newPage(now) {
      pinned = false;
      quietUntil = now + quietMs;
    },
    /** We are about to scroll the host ourselves. */
    ownScroll(now) {
      quietUntil = now + quietMs;
    },
    /** A scroll event on the host. */
    onScroll(el, now) {
      if (now < quietUntil) return;
      pinned = isNearBottom(el);
    },
  };
}

module.exports = { isNearBottom, STICK_THRESHOLD_PX, screenPin };
