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
    <div
      className={cn(
        // prose-sm clamps the body to ~12px in our font-size system; everything
        // else (headings, lists, code) scales proportionally.
        'prose prose-sm prose-neutral max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:font-semibold prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] dark:prose-code:bg-neutral-800 prose-pre:bg-transparent prose-pre:p-0',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: cls, children, ...rest }) {
            const text = String(children ?? '');
            // react-markdown v9: no `inline` prop. A fenced block always has a
            // `language-*` class; bare backtick code does not.
            const isBlock = Boolean(cls && /language-/.test(cls));
            if (!isBlock) {
              return (
                <code className={cls} {...rest}>
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
