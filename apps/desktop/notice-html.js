// The page shown in a Friday notice window (see notice.js): plain HTML with no
// scripts and no network. Buttons are links to NOTICE_SCHEME + id; the window
// intercepts that navigation to learn which one was pressed.

const NOTICE_SCHEME = 'friday-notice://';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {string} text */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/**
 * @param {{ title: string, message: string, detail?: string,
 *           buttons: { id: string, label: string }[] }} notice
 * @returns {string}
 */
function noticeHtml({ title, message, detail, buttons }) {
  const links = buttons
    .map(
      (b, i) =>
        `<a class="btn${i === 0 ? ' primary' : ''}" href="${NOTICE_SCHEME}${encodeURIComponent(b.id)}">${escapeHtml(b.label)}</a>`,
    )
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 22px 24px 18px; font: 13px/1.5 -apple-system, system-ui, sans-serif;
         background: #fbfbfa; color: #1c1c1a; -webkit-user-select: text; }
  h1 { font-size: 14px; margin: 0 0 6px; }
  p { margin: 0 0 8px; white-space: pre-wrap; }
  .detail { color: #5c5c58; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .btn { padding: 5px 14px; border-radius: 6px; border: 1px solid #d4d4cf; color: inherit;
         text-decoration: none; background: #fff; }
  .btn.primary { background: #1c1c1a; border-color: #1c1c1a; color: #fff; }
  @media (prefers-color-scheme: dark) {
    body { background: #1d1d1b; color: #ededea; }
    .detail { color: #a3a39e; }
    .btn { background: #2a2a28; border-color: #3a3a37; }
    .btn.primary { background: #ededea; border-color: #ededea; color: #1d1d1b; }
  }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${detail ? `<p class="detail">${escapeHtml(detail)}</p>` : ''}
  <div class="row">${links}</div>
</body></html>`;
}

module.exports = { noticeHtml, escapeHtml, NOTICE_SCHEME };
