// Pure selection logic for guided screen scans. Image acquisition and IPC stay
// in the Electron main process; raw frames are held only until submission.

function hammingDistance(a, b) {
  if (!a || !b) return Infinity;
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let value = (a[i] ^ b[i]) & 0xff;
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

// Mean absolute difference between two equal-length grayscale signatures
// (e.g. 32x32 downsamples). Finer than the 8x8 hash, so it notices a slow
// scroll through a text page that barely moves the coarse hash.
function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return Infinity;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

// A view is "the same" as the last kept one when its signature barely differs.
const SAME_VIEW_SIGNATURE_DISTANCE = 1.5;

// Decide whether a guided scan should end on its own. The user scrolls, then
// stops: once the screen has been still for `idleAfterScrollMs` we finish.
// If they never scrolled (content fits, or they are still reading), give them
// longer before concluding they're done.
function autoFinishReason({
  scrolled,
  startedAt,
  lastMotionAt,
  now,
  idleAfterScrollMs,
  idleWithoutScrollMs,
}) {
  const stillFor = now - Math.max(startedAt, lastMotionAt || 0);
  const limit = scrolled ? idleAfterScrollMs : idleWithoutScrollMs;
  return stillFor >= limit ? 'idle' : null;
}

class ScanSelector {
  constructor({ maxFrames = 10, distanceThreshold = 8 } = {}) {
    this.maxFrames = maxFrames;
    this.distanceThreshold = distanceThreshold;
    this.frames = [];
  }

  add(frame) {
    if (!frame || !frame.hash || !frame.base64) {
      return { kept: false, limitReached: false };
    }
    if (
      this.frames.length &&
      hammingDistance(this.frames.at(-1).hash, frame.hash) < this.distanceThreshold
    ) {
      return { kept: false, limitReached: false };
    }
    if (this.frames.length >= this.maxFrames) {
      return { kept: false, limitReached: true };
    }
    this.frames.push(frame);
    return { kept: true, limitReached: this.frames.length >= this.maxFrames };
  }

  // Keep a frame regardless of the coarse hash — used when the user asks for
  // a capture, or when scrolling has just settled on a new position. Still
  // skips a view that is effectively identical to the last kept one.
  addManual(frame) {
    if (!frame || !frame.base64) return { kept: false, limitReached: false };
    const last = this.frames.at(-1);
    if (last && signatureDistance(last.sig, frame.sig) < SAME_VIEW_SIGNATURE_DISTANCE) {
      return { kept: false, limitReached: false };
    }
    if (this.frames.length >= this.maxFrames) return { kept: false, limitReached: true };
    this.frames.push(frame);
    return { kept: true, limitReached: this.frames.length >= this.maxFrames };
  }

  finish(frame) {
    if (!frame || !frame.hash || !frame.base64) return { kept: false, limitReached: false };
    if (
      this.frames.length &&
      hammingDistance(this.frames.at(-1).hash, frame.hash) < this.distanceThreshold
    ) {
      // Final capture is same position/content; treat existing last frame as final.
      return { kept: true, limitReached: false };
    }
    if (this.frames.length >= this.maxFrames) {
      this.frames[this.maxFrames - 1] = frame;
      return { kept: true, limitReached: true, replaced: true };
    }
    this.frames.push(frame);
    return { kept: true, limitReached: false };
  }
}

// The read of a scan that saw the most: most questions, then highest
// confidence; a tie goes to the later read. A scan's last read can come back
// weaker than one made mid-scan (the model is not deterministic), so the
// scan is judged by its best read, not only its last. Null when none.
function bestScanRead(problems) {
  let best = null;
  for (const problem of problems) {
    if (!problem) continue;
    if (!best) {
      best = problem;
      continue;
    }
    const count = problem.questions?.length ?? 0;
    const bestCount = best.questions?.length ?? 0;
    if (
      count > bestCount ||
      (count === bestCount && (problem.confidence ?? 0) >= (best.confidence ?? 0))
    )
      best = problem;
  }
  return best;
}

module.exports = {
  ScanSelector,
  bestScanRead,
  hammingDistance,
  signatureDistance,
  autoFinishReason,
  SAME_VIEW_SIGNATURE_DISTANCE,
};
