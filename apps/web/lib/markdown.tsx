'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BundledLanguage, Highlighter } from 'shiki';
import { Check, Code2, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';

const SUPPORTED_LANGS: BundledLanguage[] = [
  'python',
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'bash',
  'shell',
  'json',
  'sql',
  'go',
  'rust',
  'java',
  'cpp',
  'c',
  'html',
  'css',
  'yaml',
  'markdown',
];

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark-default', 'github-light-default'],
        langs: SUPPORTED_LANGS,
      }),
    );
  }
  return highlighterPromise;
}

function normalizeLang(raw?: string): BundledLanguage | 'text' {
  if (!raw) return 'text';
  const short = raw.replace(/^language-/, '').toLowerCase();
  if ((SUPPORTED_LANGS as string[]).includes(short)) {
    return short as BundledLanguage;
  }
  return 'text';
}

/**
 * Reusable shiki hook so other panels (e.g. the Coding solution card) can
 * render a highlighted code block without going through the Markdown
 * wrapper — useful when the surrounding chrome is already provided.
 */
export function useHighlightedCode(code: string, lang: string | undefined): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const normalized = normalizeLang(lang);
    if (!code || normalized === 'text') {
      setHtml(null);
      return;
    }
    getHighlighter()
      .then((h) =>
        h.codeToHtml(code, {
          lang: normalized,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
          defaultColor: false,
        }),
      )
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return html;
}

// IDE-style code card for fenced Markdown code blocks. Mirrors the
// CodeSection card used by Solve mode (traffic lights · language label ·
// always-visible Copy button · shiki body) so code reads the same way in
// Debug / Explain / Tests output and in copilot answers.
function CodeBlock({ children, className }: { children: string; className?: string }) {
  const lang = normalizeLang(className);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const source = children.replace(/\n$/, '');

  useEffect(() => {
    let cancelled = false;
    if (lang === 'text') {
      setHtml(null);
      return;
    }
    getHighlighter()
      .then((h) =>
        h.codeToHtml(source, {
          lang,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
          defaultColor: false,
        }),
      )
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source, lang]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const onCopy = async () => {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = source;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* swallow */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <section className="friday-code-card my-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm ring-1 ring-black/5 dark:border-neutral-800 dark:bg-[#0d1117] dark:ring-white/5">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-2 dark:border-neutral-800/80">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-red-400/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
          </span>
          <span className="ml-1 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
            <Code2 className="h-3 w-3" aria-hidden />
            {lang === 'text' ? 'code' : lang}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-[10px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-500" aria-hidden />
          ) : (
            <Copy className="h-3 w-3" aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <div className="friday-code-body relative overflow-x-auto text-[12px] leading-relaxed">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="px-3 py-2 font-mono text-neutral-800 dark:text-neutral-100">
            <code>{source || ' '}</code>
          </pre>
        )}
      </div>
    </section>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    // Deliberately NOT using `prose` — every prose selector tied or beat
    // our overrides on specificity, washing out the answer text. We
    // instead drive every element's styling through ReactMarkdown's
    // component map so colors live as inline classNames on the tags
    // themselves and can't lose. Spacing/font-size is reproduced here
    // by hand to keep parity with the old prose-sm look.
    <div className={cn('not-prose text-[12px] leading-relaxed', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Colors come from CSS variables via inline `style` — beats any
          // class-level cascade including the Typography plugin defaults.
          // See globals.css for the variable definitions.
          p: ({ children, ...rest }) => (
            <p className="my-3" style={{ color: 'rgb(var(--md-fg))' }} {...rest}>
              {children}
            </p>
          ),
          ul: ({ children, ...rest }) => (
            <ul
              className="my-3 ml-5 list-disc space-y-1.5 marker:[color:rgb(var(--md-fg-muted))]"
              style={{ color: 'rgb(var(--md-fg))' }}
              {...rest}
            >
              {children}
            </ul>
          ),
          ol: ({ children, ...rest }) => (
            <ol
              className="my-3 ml-5 list-decimal space-y-1.5 marker:[color:rgb(var(--md-fg-muted))]"
              style={{ color: 'rgb(var(--md-fg))' }}
              {...rest}
            >
              {children}
            </ol>
          ),
          li: ({ children, ...rest }) => (
            <li style={{ color: 'rgb(var(--md-fg))' }} {...rest}>
              {children}
            </li>
          ),
          strong: ({ children, ...rest }) => (
            <strong
              className="font-semibold"
              style={{ color: 'rgb(var(--md-fg-strong))' }}
              {...rest}
            >
              {children}
            </strong>
          ),
          em: ({ children, ...rest }) => (
            <em className="italic" style={{ color: 'rgb(var(--md-fg))' }} {...rest}>
              {children}
            </em>
          ),
          h1: ({ children, ...rest }) => (
            <h1
              className="mt-5 text-base font-semibold"
              style={{ color: 'rgb(var(--md-fg-strong))' }}
              {...rest}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...rest }) => (
            <h2
              className="mt-5 text-[13px] font-semibold"
              style={{ color: 'rgb(var(--md-fg-strong))' }}
              {...rest}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...rest }) => (
            <h3
              className="mt-4 text-[12px] font-semibold uppercase tracking-wide"
              style={{ color: 'rgb(var(--md-fg-strong))' }}
              {...rest}
            >
              {children}
            </h3>
          ),
          blockquote: ({ children, ...rest }) => (
            <blockquote
              className="my-3 border-l-2 border-neutral-300 pl-3 italic dark:border-neutral-700"
              style={{ color: 'rgb(var(--md-fg-muted))' }}
              {...rest}
            >
              {children}
            </blockquote>
          ),
          a: ({ children, href, ...rest }) => (
            <a
              href={href}
              className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
              {...rest}
            >
              {children}
            </a>
          ),
          code({ className: cls, children, ...rest }) {
            const text = String(children ?? '');
            // react-markdown v9: no `inline` prop. A fenced block always has a
            // `language-*` class; bare backtick code does not.
            const isBlock = Boolean(cls && /language-/.test(cls));
            if (!isBlock) {
              return (
                <code
                  className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800"
                  style={{ color: 'rgb(var(--md-fg-strong))' }}
                  {...rest}
                >
                  {text}
                </code>
              );
            }
            return <CodeBlock className={cls}>{text}</CodeBlock>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
