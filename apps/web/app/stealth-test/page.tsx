export default function StealthTestPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-600 dark:text-sky-400">
          Friday · Stealth Test
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Manual stealth verification</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Start a Zoom call with yourself, share your screen, and verify this window does not appear
          in the capture. Repeat the same check in Meet and Teams if those clients are part of your
          target environment.
        </p>
      </header>

      <section className="rounded-2xl border border-neutral-200 bg-white/80 p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900/60">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Suggested flow
        </h2>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          <li>Open Friday in the desktop shell and confirm the shield icon is green.</li>
          <li>Open Zoom and start a meeting with yourself.</li>
          <li>Put Zoom in fullscreen mode.</li>
          <li>Confirm Friday still appears above the Zoom meeting window.</li>
          <li>
            Start full-screen sharing and verify Friday does not appear in the outbound share.
          </li>
          <li>Repeat in single-window sharing mode while sharing a different app.</li>
          <li>Repeat the same checks in Google Meet and Microsoft Teams if relevant.</li>
        </ol>
      </section>

      <section className="rounded-2xl border border-sky-200 bg-sky-50 p-6 dark:border-sky-900 dark:bg-sky-950/30">
        <h2 className="text-lg font-semibold text-sky-950 dark:text-sky-100">Notes</h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-sky-900/90 dark:text-sky-100/90">
          <li>
            Use the settings panel to disable individual behaviors if you need to isolate a failure.
          </li>
          <li>Use `⌘ ⇧ \\` to verify hide/show re-application after the window returns.</li>
          <li>Use `⌘ ⇧ -` and `⌘ ⇧ =` to confirm opacity changes still work during testing.</li>
        </ul>
      </section>
    </main>
  );
}
