// Frame-selection tests for the scroll scan. Pages are synthetic "text" made of
// word-shaped bars, rendered at real screen sizes, so scrolling shifts real
// content the way a problem page does.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  ScanSelector,
  computeSignature,
  spread,
  MOTION_KEEP_MS,
  SPREAD_THRESHOLD,
} = require('./scan');

const LINE_H = 28;

// Deterministic word widths per document line, so line N looks the same
// wherever it lands on screen.
function lineWords(lineIndex) {
  const words = [];
  let seed = (lineIndex + 1) * 2654435761;
  let x = 0;
  const lineLen = 300 + (lineIndex % 7) * 60;
  while (x < lineLen) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const w = 20 + (seed % 70);
    words.push([x, w]);
    x += w + 9;
  }
  return words;
}

/**
 * @param {object} o
 * @param {number} o.width screen width
 * @param {number} o.height screen height
 * @param {number} o.scroll document scroll offset (px) of the scrolling pane
 * @param {number} [o.paneFrac] fraction of the width that scrolls (rest = static editor)
 * @param {boolean} [o.dark]
 * @param {boolean} [o.caret] draw a caret in the static pane
 * @param {string} [o.timer] text drawn in a corner (ticking clock)
 */
async function renderScreen({ width, height, scroll, paneFrac = 1, dark = false, caret, timer }) {
  const bg = dark ? '#1a1a1a' : '#ffffff';
  const fg = dark ? '#d4d4d4' : '#262626';
  const paneW = Math.round(width * paneFrac);
  const parts = [`<rect width="${width}" height="${height}" fill="${bg}"/>`];
  const first = Math.floor(scroll / LINE_H);
  const last = Math.ceil((scroll + height) / LINE_H);
  for (let line = first; line <= last; line++) {
    const y = line * LINE_H - scroll + 8;
    // Paragraph breaks every 6 lines, like a real problem statement.
    if (line % 6 === 5) continue;
    for (const [x, w] of lineWords(line)) {
      if (32 + x + w > paneW - 24) break;
      parts.push(`<rect x="${32 + x}" y="${y}" width="${w}" height="12" fill="${fg}"/>`);
    }
  }
  if (paneFrac < 1) {
    // Static editor pane with a few code lines.
    parts.push(
      `<rect x="${paneW}" width="${width - paneW}" height="${height}" fill="${dark ? '#111' : '#f5f5f5'}"/>`,
    );
    for (let i = 0; i < 12; i++) {
      parts.push(
        `<rect x="${paneW + 40}" y="${60 + i * 26}" width="${120 + (i % 4) * 70}" height="11" fill="${fg}"/>`,
      );
    }
  }
  if (caret) {
    parts.push(`<rect x="${width - 300}" y="400" width="2" height="20" fill="${fg}"/>`);
  }
  if (timer) {
    parts.push(
      `<text x="${width - 140}" y="30" font-size="18" font-family="monospace" fill="${fg}">${timer}</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function sig(opts) {
  return computeSignature(await renderScreen(opts));
}

const SCREENS = [
  { width: 1920, height: 1080, label: '1080p' },
  { width: 1440, height: 900, label: 'MacBook Air' },
  { width: 1280, height: 720, label: '720p' },
];

for (const screen of SCREENS) {
  test(`${screen.label}: settled scroll positions are kept, re-visits are not`, async () => {
    const sel = new ScanSelector();
    const at = (scroll) => sig({ ...screen, scroll });
    const page = screen.height * 0.8;
    let t = 0;
    assert.equal(sel.consider(await at(0), (t += 400)), 'kept');
    assert.equal(sel.consider(await at(0), (t += 400)), 'duplicate');
    // Mid-scroll sample (still moving); the landing sample is kept.
    assert.equal(sel.consider(await at(page * 0.4), (t += 400)), 'moving');
    assert.equal(sel.consider(await at(page), (t += 400)), 'kept');
    assert.equal(sel.consider(await at(page), (t += 400)), 'duplicate');
    assert.equal(sel.consider(await at(page), (t += 400)), 'duplicate');
    // Second scroll, caught only once it settles.
    assert.equal(sel.consider(await at(page * 2), (t += 400)), 'moving');
    assert.equal(sel.consider(await at(page * 2), (t += 400)), 'kept');
    // Scroll back to the top: already captured.
    assert.equal(sel.consider(await at(0), (t += 400)), 'duplicate');
    assert.equal(sel.consider(await at(0), (t += 400)), 'duplicate');
    assert.equal(sel.count, 3);
  });
}

test('split layout: only the problem pane scrolls (LeetCode style)', async () => {
  const base = { width: 1920, height: 1080, paneFrac: 0.45 };
  const sel = new ScanSelector();
  let t = 0;
  assert.equal(sel.consider(await sig({ ...base, scroll: 0 }), (t += 400)), 'kept');
  assert.equal(sel.consider(await sig({ ...base, scroll: 700 }), (t += 400)), 'moving');
  assert.equal(sel.consider(await sig({ ...base, scroll: 700 }), (t += 400)), 'kept');
  assert.equal(sel.consider(await sig({ ...base, scroll: 700 }), (t += 400)), 'duplicate');
  assert.equal(sel.consider(await sig({ ...base, scroll: 1400 }), (t += 400)), 'moving');
  assert.equal(sel.consider(await sig({ ...base, scroll: 1400 }), (t += 400)), 'kept');
  assert.equal(sel.count, 3);
});

test('narrow scrolling pane (30% of an ultrawide screen) still registers', async () => {
  const base = { width: 3440, height: 1440, paneFrac: 0.3 };
  const a = await sig({ ...base, scroll: 0 });
  const b = await sig({ ...base, scroll: 1100 });
  const sel = new ScanSelector();
  assert.equal(sel.consider(a, 400), 'kept');
  assert.equal(sel.consider(b, 800), 'moving');
  assert.equal(sel.consider(b, 1200), 'kept');
});

test('dark theme behaves like light', async () => {
  const base = { width: 1440, height: 900, dark: true };
  const sel = new ScanSelector();
  assert.equal(sel.consider(await sig({ ...base, scroll: 0 }), 400), 'kept');
  assert.equal(sel.consider(await sig({ ...base, scroll: 750 }), 800), 'moving');
  assert.equal(sel.consider(await sig({ ...base, scroll: 750 }), 1200), 'kept');
});

test('blinking caret and a ticking timer are not new content', async () => {
  const base = { width: 1920, height: 1080, paneFrac: 0.45, scroll: 0 };
  const frames = [
    await sig({ ...base, caret: true, timer: '00:44:59' }),
    await sig({ ...base, caret: false, timer: '00:44:58' }),
    await sig({ ...base, caret: true, timer: '00:44:57' }),
  ];
  assert.ok(spread(frames[0], frames[1]) < 0.05, 'settles despite caret/timer');
  const sel = new ScanSelector();
  assert.equal(sel.consider(frames[0], 400), 'kept');
  assert.equal(sel.consider(frames[1], 800), 'duplicate');
  assert.equal(sel.consider(frames[2], 5000), 'duplicate');
});

test('a playing video tile does not stop settled scroll positions being kept', async () => {
  // Interviewer's camera in a corner: ~2.5% of the screen changes every sample.
  const base = { width: 1920, height: 1080, paneFrac: 0.45 };
  const withVideo = async (scroll, tick) => {
    const png = await renderScreen({ ...base, scroll });
    const shade = 40 + ((tick * 67) % 180);
    const tile = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: { r: shade, g: 255 - shade, b: shade },
      },
    })
      .png()
      .toBuffer();
    const composed = await sharp(png)
      .composite([{ input: tile, left: 1560, top: 860 }])
      .png()
      .toBuffer();
    return computeSignature(composed);
  };
  const sel = new ScanSelector();
  let t = 0;
  let tick = 0;
  assert.equal(sel.consider(await withVideo(0, tick++), (t += 400)), 'kept');
  // Video alone is not new content.
  assert.equal(sel.consider(await withVideo(0, tick++), (t += 400)), 'duplicate');
  assert.equal(sel.consider(await withVideo(0, tick++), (t += 2000)), 'duplicate');
  // After a scroll, the new position settles despite the video and is kept once.
  const decisions = [];
  for (let i = 0; i < 5; i++)
    decisions.push(sel.consider(await withVideo(700, tick++), (t += 400)));
  assert.deepEqual(decisions, ['moving', 'kept', 'duplicate', 'duplicate', 'duplicate']);
  assert.equal(sel.count, 2);
});

test('continuous scrolling that never settles still yields frames', async () => {
  const sel = new ScanSelector();
  const screen = { width: 1440, height: 900 };
  let kept = 0;
  // 200px every 400ms without ever stopping.
  for (let i = 0; i < 12; i++) {
    const decision = sel.consider(await sig({ ...screen, scroll: i * 200 }), i * 400);
    if (decision === 'kept') kept++;
  }
  // Every 2nd moving sample is kept: kept frames are ≤ 400px apart on a 900px
  // screen, so consecutive frames overlap and nothing is skipped.
  assert.equal(MOTION_KEEP_MS, 400);
  assert.ok(kept >= 5 && kept <= 7, `kept ${kept}`);
});

test('finishing keeps the final screen even if it never settled', async () => {
  const sel = new ScanSelector();
  const screen = { width: 1440, height: 900 };
  assert.equal(sel.consider(await sig({ ...screen, scroll: 0 }), 0), 'kept');
  // The fling is mid-way at 350 when the user presses Finish; it lands at 700.
  assert.equal(sel.consider(await sig({ ...screen, scroll: 350 }), 400), 'moving');
  assert.equal(sel.considerFinal(await sig({ ...screen, scroll: 700 }), 600), 'kept');
  // Finishing on an already-captured screen adds nothing.
  assert.equal(sel.considerFinal(await sig({ ...screen, scroll: 700 }), 700), 'duplicate');
  assert.equal(sel.count, 2);
});

test('frame cap: returns full once maxFrames are kept', async () => {
  const sel = new ScanSelector({ maxFrames: 2 });
  const screen = { width: 1280, height: 720 };
  assert.equal(sel.consider(await sig({ ...screen, scroll: 0 }), 0), 'kept');
  const b = await sig({ ...screen, scroll: 600 });
  sel.consider(b, 400);
  assert.equal(sel.consider(b, 800), 'kept');
  assert.equal(sel.isFull, true);
  assert.equal(sel.consider(await sig({ ...screen, scroll: 1200 }), 1200), 'full');
});

test('spread is 1 for mismatched or missing signatures', () => {
  assert.equal(spread(null, new Uint8Array(4)), 1);
  assert.equal(spread(new Uint8Array(3), new Uint8Array(4)), 1);
});

test('stacked layout: a problem pane in the top half of the screen still registers', async () => {
  // Statement above the editor (narrow-window LeetCode): only ~45% of rows scroll.
  const top = async (scroll) => {
    const pane = await renderScreen({ width: 1440, height: 450, scroll });
    const screen = await sharp({
      create: { width: 1440, height: 900, channels: 3, background: '#f5f5f5' },
    })
      .composite([{ input: pane, left: 0, top: 0 }])
      .png()
      .toBuffer();
    return computeSignature(screen);
  };
  const a = await top(0);
  const b = await top(380);
  assert.ok(spread(a, b) >= SPREAD_THRESHOLD, `spread ${spread(a, b)}`);
});

// ─── pane detection + payload ────────────────────────────────────────────────

const { paneBox, buildScanImages } = require('./scan');

async function scanSigs(opts, scrolls, decorate = (png) => png) {
  const out = [];
  for (const [i, scroll] of scrolls.entries()) {
    out.push(await computeSignature(await decorate(await renderScreen({ ...opts, scroll }), i)));
  }
  return out;
}

async function addVideoTile(png, tick) {
  const { width, height } = await sharp(png).metadata();
  const shade = 30 + ((tick * 71) % 190);
  const tile = await sharp({
    create: {
      width: 400,
      height: 225,
      channels: 3,
      background: { r: shade, g: 120, b: 255 - shade },
    },
  })
    .png()
    .toBuffer();
  return sharp(png)
    .composite([{ input: tile, left: width - 430, top: height - 255 }])
    .png()
    .toBuffer();
}

// The crop must contain every cell that changed (no text cut off).
function allChangedInside(sigs, box) {
  const W = 160;
  for (let k = 1; k < sigs.length; k++) {
    for (let i = 0; i < sigs[k].length; i++) {
      if (Math.abs(sigs[k][i] - sigs[k - 1][i]) <= 12) continue;
      const x = (i % W) / W;
      const y = Math.floor(i / W) / 100;
      if (x < box.left || x >= box.left + box.width || y < box.top || y >= box.top + box.height) {
        return false;
      }
    }
  }
  return true;
}

test('paneBox: side-by-side problem pane is cropped to its columns', async () => {
  const sigs = await scanSigs({ width: 1920, height: 1080, paneFrac: 0.45 }, [0, 700, 1400]);
  const box = paneBox(sigs);
  assert.ok(box, 'expected a crop');
  assert.ok(box.left <= 0.02 && box.left + box.width <= 0.47, JSON.stringify(box));
  assert.ok(box.height >= 0.9, JSON.stringify(box));
  assert.ok(allChangedInside(sigs, box), 'crop cuts off changed text');
});

test('paneBox: ragged long lines at the pane edge are never cut off', async () => {
  // Only every 9th line reaches the right edge of the pane.
  const sigs = [];
  for (const scroll of [0, 650, 1300]) {
    const png = await renderScreen({ width: 1920, height: 1080, paneFrac: 0.45, scroll });
    const longLines = [];
    for (let y = 40 - (scroll % 252); y < 1080; y += 252) {
      if (y > 0) longLines.push(`<rect x="40" y="${y}" width="800" height="12" fill="#262626"/>`);
    }
    const overlay = Buffer.from(`<svg width="1920" height="1080">${longLines.join('')}</svg>`);
    sigs.push(
      await computeSignature(
        await sharp(png)
          .composite([{ input: overlay }])
          .png()
          .toBuffer(),
      ),
    );
  }
  const box = paneBox(sigs);
  assert.ok(box && allChangedInside(sigs, box), JSON.stringify(box));
});

test('paneBox: an interviewer video tile does not widen the crop', async () => {
  const sigs = await scanSigs(
    { width: 1920, height: 1080, paneFrac: 0.45 },
    [0, 700, 1400],
    addVideoTile,
  );
  const box = paneBox(sigs);
  assert.ok(box && box.left + box.width <= 0.55, JSON.stringify(box));
});

test('paneBox: statement-above-editor pane is cropped to its rows', async () => {
  const shots = [];
  for (const scroll of [0, 380, 760]) {
    const pane = await renderScreen({ width: 1440, height: 450, scroll });
    const screen = await sharp({
      create: { width: 1440, height: 900, channels: 3, background: '#f5f5f5' },
    })
      .composite([{ input: pane, left: 0, top: 0 }])
      .png()
      .toBuffer();
    shots.push(await computeSignature(screen));
  }
  const box = paneBox(shots);
  assert.ok(box && box.top <= 0.02 && box.height <= 0.6 && box.width >= 0.2, JSON.stringify(box));
});

test('paneBox: whole-page scroll crops only to the text that moved', async () => {
  const sigs = await scanSigs({ width: 1366, height: 768 }, [0, 600, 1200]);
  const box = paneBox(sigs);
  // Text spans x≈32–700 of 1366: cropped to that column, nothing cut.
  assert.ok(box === null || allChangedInside(sigs, box), JSON.stringify(box));
});

test('paneBox: full-width page scroll is not cropped', async () => {
  const wide = [];
  for (const scroll of [0, 600, 1200]) {
    const png = await renderScreen({ width: 1280, height: 800, scroll });
    // Stretch the synthetic text across the whole screen.
    wide.push(
      await computeSignature(
        await sharp(png)
          .extract({ left: 0, top: 0, width: 720, height: 800 })
          .resize(1280, 800, { fit: 'fill' })
          .png()
          .toBuffer(),
      ),
    );
  }
  assert.equal(paneBox(wide), null);
});

test('paneBox: a single frame or a static screen gives no crop', async () => {
  const one = await scanSigs({ width: 1440, height: 900 }, [0]);
  assert.equal(paneBox(one), null);
  assert.equal(paneBox([one[0], one[0]]), null);
});

test('buildScanImages: cropped scan sends one whole frame + full-resolution crops', async () => {
  const frames = [];
  for (const scroll of [0, 900]) {
    const png = await renderScreen({ width: 3440, height: 1440, paneFrac: 0.3, scroll });
    frames.push(await sharp(png).jpeg({ quality: 92 }).toBuffer());
  }
  const box = { left: 0, top: 0.05, width: 0.32, height: 0.95 };
  const { images, cropped } = await buildScanImages(frames, box);
  assert.equal(cropped, true);
  assert.equal(images.length, 3);
  const metas = await Promise.all(images.map((b) => sharp(Buffer.from(b, 'base64')).metadata()));
  assert.equal(metas[0].width, 1920); // whole screen, downscaled for context
  // Crops keep native pixels: 32% of 3440 ≈ 1101px wide (vs 614px if cut
  // from the 1920px downscale).
  assert.ok(metas[1].width >= 1090 && metas[1].width <= 1110, String(metas[1].width));
  assert.equal(metas[1].format, 'jpeg');
});

test('buildScanImages: uncropped scan sends every frame capped at 1920 wide', async () => {
  const png = await renderScreen({ width: 2880, height: 1800, scroll: 0 });
  const jpeg = await sharp(png).jpeg().toBuffer();
  const { images, cropped } = await buildScanImages([jpeg, jpeg], null);
  assert.equal(cropped, false);
  assert.equal(images.length, 2);
  assert.equal((await sharp(Buffer.from(images[0], 'base64')).metadata()).width, 1920);
});
