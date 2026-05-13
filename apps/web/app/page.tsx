import Link from 'next/link';

import { ChatForm } from '@/components/chat-form';

// Hero version of the Owl mascot — same artwork as FridayMark on the bar
// (and /mascots), at home-page scale. Sits inside a sky-tinted rounded tile
// to anchor it visually next to the wordmark.
function FridayHero() {
  return (
    <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 ring-1 ring-sky-200/60 dark:bg-sky-950/40 dark:ring-sky-500/20">
      <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" className="h-9 w-9" aria-hidden>
        <path d="M14 16 Q12 4 22 8 L20 20 Z" fill="#075985" />
        <path d="M50 16 Q52 4 42 8 L44 20 Z" fill="#075985" />
        <ellipse cx="32" cy="36" rx="20" ry="22" fill="#0284c7" />
        <ellipse cx="32" cy="42" rx="11" ry="14" fill="#7dd3fc" />
        <circle cx="23" cy="28" r="10" fill="#f0f9ff" />
        <circle cx="41" cy="28" r="10" fill="#f0f9ff" />
        <circle cx="23" cy="28" r="6" fill="#0c4a6e" />
        <circle cx="41" cy="28" r="6" fill="#0c4a6e" />
        <circle cx="23" cy="28" r="3" fill="#1e293b" />
        <circle cx="41" cy="28" r="3" fill="#1e293b" />
        <circle cx="24.5" cy="26.5" r="1.2" fill="white" />
        <circle cx="42.5" cy="26.5" r="1.2" fill="white" />
        <path d="M29 34 L35 34 L32 40 Z" fill="#f59e0b" />
        <path d="M14 36 Q10 44 14 50 Q18 46 16 40 Z" fill="#075985" />
        <path d="M50 36 Q54 44 50 50 Q46 46 48 40 Z" fill="#075985" />
      </svg>
    </span>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center gap-4">
        <FridayHero />
        <div className="flex flex-col gap-1">
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
        </div>
      </header>
      <ChatForm />
    </main>
  );
}
