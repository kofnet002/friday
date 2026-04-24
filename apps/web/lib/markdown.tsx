'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BundledLanguage, Highlighter } from 'shiki';

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
      <div
        className="friday-code overflow-x-auto rounded-md border border-neutral-200 text-sm dark:border-neutral-800"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <code>{source}</code>
    </pre>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-neutral max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:font-semibold prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] dark:prose-code:bg-neutral-800 prose-pre:bg-transparent prose-pre:p-0',
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
