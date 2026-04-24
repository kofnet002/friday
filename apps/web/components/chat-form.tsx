'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChatRequest, ChatTokenEvent, Provider } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { parseSseStream } from '@/lib/sse';

export function ChatForm() {
  const [provider, setProvider] = useState<Provider>('gemini');
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (body: ChatRequest) => {
      setOutput('');
      setError(null);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      for await (const ev of parseSseStream(res)) {
        if (ev.event === 'token') {
          const { text } = JSON.parse(ev.data) as ChatTokenEvent;
          setOutput((prev) => prev + text);
        } else if (ev.event === 'error') {
          const { message: msg } = JSON.parse(ev.data) as { message: string };
          setError(msg);
        } else if (ev.event === 'done') {
          return;
        }
      }
    },
  });

  return (
    <form
      className="flex w-full max-w-2xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!message.trim()) return;
        mutation.mutate({ provider, message });
      }}
    >
      <div className="flex items-center gap-3">
        <label htmlFor="provider" className="text-sm font-medium">
          Provider
        </label>
        <Select
          id="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
        >
          <option value="gemini">Gemini (gemini-2.5-pro)</option>
          <option value="openai">OpenAI (gpt-5)</option>
        </Select>
      </div>

      <Textarea
        placeholder="Ask Friday something…"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={mutation.isPending || !message.trim()}>
          {mutation.isPending ? 'Streaming…' : 'Send'}
        </Button>
        {error ? <span className="text-sm text-red-600">Error: {error}</span> : null}
      </div>

      <div className="min-h-[160px] whitespace-pre-wrap rounded-md border border-neutral-300 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900">
        {output || <span className="text-neutral-500">Streamed response will appear here.</span>}
      </div>
    </form>
  );
}
