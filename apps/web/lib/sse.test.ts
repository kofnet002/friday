import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSseStream } from './sse.ts';

function responseOf(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body);
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const e of parseSseStream(responseOf(chunks))) out.push(e);
  return out;
}

test('parses LF-delimited events', async () => {
  assert.deepEqual(await collect(['event: token\ndata: {"text":"a"}\n\n']), [
    { event: 'token', data: '{"text":"a"}' },
  ]);
});

test('parses CRLF-delimited events, including a CR/LF split across chunks', async () => {
  const events = await collect([
    'event: token\r\ndata: {"text":"a"}\r\n\r',
    '\nevent: done\r\ndata: {}\r\n\r\n',
  ]);
  assert.deepEqual(events, [
    { event: 'token', data: '{"text":"a"}' },
    { event: 'done', data: '{}' },
  ]);
});
