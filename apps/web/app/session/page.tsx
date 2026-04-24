import { SessionClient } from './session-client';

export default function SessionPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-600 dark:text-sky-400">
          Friday · Session
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Live captions</h1>
        <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          Friday listens to whatever your Mac is playing and transcribes it in real time. Play a
          video anywhere on your screen — the current line is highlighted, earlier lines fade above.
        </p>
      </header>
      <SessionClient />
    </main>
  );
}
