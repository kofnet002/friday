'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BundledLanguage, Highlighter } from 'shiki';
import { Check, Copy } from 'lucide-react';

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

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const onClick = async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
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
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? 'Copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
      className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-300/60 bg-white/80 text-neutral-600 opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-neutral-900 group-hover:opacity-100 focus-visible:opacity-100 dark:border-neutral-700/60 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:text-neutral-50"
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}

function CodeBlock({ children, className }: { children: string; className?: string }) {
  const lang = normalizeLang(className);
  const [html, setHtml] = useState<string | null>(null);
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

  if (html) {
    return (
      <div className="group relative">
        <div
          className="friday-code overflow-x-auto rounded-md border border-neutral-200 text-sm dark:border-neutral-800"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <CopyButton getText={() => source} />
      </div>
    );
  }
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <code>{source}</code>
      </pre>
      <CopyButton getText={() => source} />
    </div>
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
