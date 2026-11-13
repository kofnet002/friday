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
// bottom) arrive a frame later. They're told from the reader's by POSITION:
// a scroll that lands above where we last scrolled to is the reader scrolling
// up, and unpins at once. Otherwise, this long after our own scroll, events
// are not taken as the reader's.
const OWN_SCROLL_QUIET_MS = 150;
// Sub-pixel rounding between the scrollTop we set and the one reported.
const OWN_SCROLL_TOLERANCE_PX = 2;

/**
 * "Pinned" state for the Screen tab, where answers grow inside a shared
 * scroller: a new answer page starts unpinned (its start stays in view) and
 * only the reader scrolling to the bottom pins it; scrolling up unpins, even
 * while an answer streams.
 * @param {{ quietMs?: number }} [options]
 */
function screenPin({ quietMs = OWN_SCROLL_QUIET_MS } = {}) {
  let pinned = false;
  let quietUntil = -Infinity;
  /** @type {number | null} scrollTop our last own scroll landed on */
  let lastSetTop = null;
  return {
    get pinned() {
      return pinned;
    },
    /** A new answer page arrived; call before revealing its start. */
    newPage(now) {
      pinned = false;
      quietUntil = now + quietMs;
      lastSetTop = null;
    },
    /**
     * We just scrolled the host ourselves.
     * @param {number} now
     * @param {number} [top] the scrollTop it landed on
     */
    ownScroll(now, top) {
      quietUntil = now + quietMs;
      if (typeof top === 'number') lastSetTop = top;
    },
    /** A scroll event on the host. */
    onScroll(el, now) {
      if (lastSetTop !== null && el.scrollTop < lastSetTop - OWN_SCROLL_TOLERANCE_PX) {
        pinned = false;
        lastSetTop = null;
        return;
      }
      if (now < quietUntil) return;
      pinned = isNearBottom(el);
    },
  };
}

module.exports = { isNearBottom, STICK_THRESHOLD_PX, screenPin };
