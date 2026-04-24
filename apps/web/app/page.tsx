import Link from 'next/link';

import { ChatForm } from '@/components/chat-form';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Friday</h1>
        <p className="text-sm text-neutral-500">
          Smoke test: stream a reply from Gemini or OpenAI through the FastAPI backend.
        </p>
        <div className="mt-2 flex flex-col gap-1 text-sm">
          <Link href="/setup" className="text-sky-600 hover:underline dark:text-sky-400">
            → configure session context
          </Link>
          <Link href="/session" className="text-sky-600 hover:underline dark:text-sky-400">
            → live transcription + copilot
          </Link>
        </div>
      </header>
      <ChatForm />
    </main>
  );
}
