export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse a Response body as a stream of Server-Sent Events.
 * Yields one event per `event:`/`data:` block separated by a blank line.
 */
export async function* parseSseStream(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // The spec allows CRLF line endings (sse-starlette sends them); fold
      // them to LF so blocks split on a blank line. A trailing lone CR stays
      // until the next chunk shows whether an LF follows it.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join('\n') };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
