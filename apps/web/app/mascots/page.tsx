// Mascot picker — three candidates inspired by the Parakeet parrot.
// Visit /mascots to compare. Pick one and the chosen SVG can replace the
// current FridayMark (glyph) as Friday's primary brand image.

import Link from 'next/link';

type MascotProps = { className?: string };

function Owl({ className }: MascotProps) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
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
  );
}

function Bat({ className }: MascotProps) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path
        d="M32 32 Q22 24 14 26 Q6 22 4 32 Q8 36 14 36 Q14 40 18 40 Q22 42 28 38 Z"
        fill="#1e293b"
      />
      <path
        d="M32 32 Q42 24 50 26 Q58 22 60 32 Q56 36 50 36 Q50 40 46 40 Q42 42 36 38 Z"
        fill="#1e293b"
      />
      <path d="M24 16 L28 24 L30 18 Z" fill="#0f172a" />
      <path d="M40 16 L36 24 L34 18 Z" fill="#0f172a" />
      <circle cx="32" cy="26" r="10" fill="#1e293b" />
      <circle cx="28.5" cy="26" r="2.5" fill="#38bdf8" />
      <circle cx="35.5" cy="26" r="2.5" fill="#38bdf8" />
      <circle cx="29" cy="25.5" r="0.8" fill="white" />
      <circle cx="36" cy="25.5" r="0.8" fill="white" />
      <path
        d="M30 31 Q32 33 34 31"
        stroke="#7dd3fc"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Fox({ className }: MascotProps) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path d="M14 22 L16 6 L28 18 Z" fill="#c2410c" />
      <path d="M50 22 L48 6 L36 18 Z" fill="#c2410c" />
      <path d="M19 18 L20 10 L25 18 Z" fill="#fed7aa" />
      <path d="M45 18 L44 10 L39 18 Z" fill="#fed7aa" />
      <path
        d="M14 22 Q14 18 18 16 L46 16 Q50 18 50 22 L40 38 Q36 44 32 44 Q28 44 24 38 Z"
        fill="#ea580c"
      />
      <path d="M26 30 L38 30 L32 44 L28 38 Z" fill="#fff7ed" />
      <path d="M32 44 L36 38 L38 30 Z" fill="#fef3c7" />
      <ellipse cx="24" cy="26" rx="2.2" ry="2.8" fill="#1c1917" />
      <ellipse cx="40" cy="26" rx="2.2" ry="2.8" fill="#1c1917" />
      <circle cx="24.5" cy="25" r="0.8" fill="white" />
      <circle cx="40.5" cy="25" r="0.8" fill="white" />
      <ellipse cx="32" cy="38" rx="1.8" ry="1.2" fill="#1c1917" />
    </svg>
  );
}

const MASCOTS = [
  {
    key: 'owl',
    name: 'Owl',
    tagline: 'Silent listener · wisdom · stealth-coded',
    Component: Owl,
    pitch:
      "Watches and listens silently from the periphery. Big eyes map to the screen-vision pipeline; the silent-flight metaphor maps to stealth mode. Reads cleanly at any size and doesn't compete with the listening-pulse glyph in the tray.",
  },
  {
    key: 'bat',
    name: 'Bat',
    tagline: 'Echolocation · nocturnal · audio-native',
    Component: Bat,
    pitch:
      'The most literal fit — bats are audio-navigators, and Friday is an audio-first assistant. Echolocation is exactly what the transcribe pipeline does in spirit: emit nothing, listen for the answer. Distinctive (under-used as a mascot) but needs the friendly-cute treatment to avoid gothic.',
  },
  {
    key: 'fox',
    name: 'Fox',
    tagline: 'Clever · quick-witted · Stark-coded',
    Component: Fox,
    pitch:
      'Pairs with the Tony Stark heritage — quick, clever, a little roguish. Big alert ears nod to the listening function. Warm orange contrasts the sky-blue UI palette nicely. The downside is Firefox owns this mascot in tech circles.',
  },
] as const;

export default function MascotsPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Pick a Friday mascot</h1>
        <p className="text-sm text-neutral-500">
          Three candidates. Each is rendered at hero size and at favicon size so you can see how it
          scales. Tell Claude which one and the chosen SVG replaces FridayMark.
        </p>
        <Link href="/" className="text-sm text-sky-600 hover:underline dark:text-sky-400">
          ← back home
        </Link>
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {MASCOTS.map(({ key, name, tagline, pitch, Component }) => (
          <article
            key={key}
            className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="flex items-start justify-between gap-3">
              <Component className="h-24 w-24" />
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] uppercase tracking-wider text-neutral-400">
                  Favicon
                </span>
                <Component className="h-6 w-6" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold">{name}</h2>
              <p className="text-xs uppercase tracking-wide text-sky-600 dark:text-sky-400">
                {tagline}
              </p>
            </div>
            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              {pitch}
            </p>
          </article>
        ))}
      </div>

      <footer className="text-xs text-neutral-500">
        Drafts are flat-color illustrations sized for a 64×64 viewBox. The chosen one will get a
        polish pass (line weights, sub-pixel snapping, optional dark-mode variant) before it
        replaces FridayMark.
      </footer>
    </main>
  );
}
