const { test } = require('node:test');
const assert = require('node:assert/strict');

const { noticeHtml, NOTICE_SCHEME } = require('./notice-html');

test('escapes every user-visible string', () => {
  const html = noticeHtml({
    title: '<b>t</b>',
    message: 'Port 8000 <in use> & "busy"',
    detail: "it's <script>alert(1)</script>",
    buttons: [{ id: 'ok', label: '<OK>' }],
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('Port 8000 &lt;in use&gt; &amp; &quot;busy&quot;'));
  assert.ok(html.includes('&lt;OK&gt;'));
});

test('buttons navigate to the notice scheme with their id', () => {
  const html = noticeHtml({
    title: 'x',
    message: 'y',
    buttons: [
      { id: 'open', label: 'Open settings file' },
      { id: 'later', label: 'Later' },
    ],
  });
  assert.ok(html.includes(`href="${NOTICE_SCHEME}open"`));
  assert.ok(html.includes(`href="${NOTICE_SCHEME}later"`));
});

test('the page loads nothing from outside', () => {
  const html = noticeHtml({ title: 'x', message: 'y', buttons: [{ id: 'ok', label: 'OK' }] });
  assert.match(
    html,
    /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/,
  );
});
