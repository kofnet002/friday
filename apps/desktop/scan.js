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

module.exports = { ScanSelector, hammingDistance };
