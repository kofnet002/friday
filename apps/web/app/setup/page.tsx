import { SetupForm } from './setup-form';

export default function SetupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-600 dark:text-sky-400">
          Friday · Setup
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Session context</h1>
        <p className="max-w-xl text-sm text-neutral-500 dark:text-neutral-400">
          Friday uses this context to ground the copilot's answers during the live interview.
          Nothing you enter leaves your machine unless you trigger a question.
        </p>
      </header>
      <SetupForm />
    </main>
  );
}
