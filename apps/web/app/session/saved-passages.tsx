'use client';

import { X } from 'lucide-react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/lib/markdown';
import { passagePreview } from '@/lib/saved-passages';
import {
  fetchSavedPassages,
  removeSavedPassage,
  screenImageUrl,
  type SavedPassage,
} from '@/lib/session-context';
import { cn } from '@/lib/utils';

import { AssistScrollContext } from './assist-panel';

interface SavedPassagesProps {
  sessionId: string;
  /** Changes whenever the backend's remembered passages may have changed. */
  refreshKey: number;
  onClearAll: () => void;
}

export function SavedPassages({ sessionId, refreshKey, onClearAll }: SavedPassagesProps) {
  const [passages, setPassages] = useState<SavedPassage[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [viewing, setViewing] = useState<{ key: string; label: string | null } | null>(null);
  const closeViewer = useCallback(() => setViewing(null), []);

  const refresh = useCallback(async () => {
    const list = await fetchSavedPassages(sessionId);
    if (list) setPassages(list);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const newest = passages[passages.length - 1];
  if (!newest) return null;

  return (
    <div className="w-full border-t border-sky-200/70 pt-2 text-xs dark:border-sky-900/70">
      <div role="status" className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={passagePreview(newest.text, 400)}>
          <span className="font-medium">Saved passages ({passages.length}):</span>{' '}
          <span className="text-muted-foreground">“{passagePreview(newest.text)}”</span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={onClearAll}
          aria-label="Clear remembered screen context"
        >
          Clear all
        </Button>
      </div>
      {expanded ? (
        <ol className="mt-2 space-y-2">
          {passages.map((p, i) => (
            <li
              key={p.id}
              className="rounded-md border border-sky-200/70 p-2 dark:border-sky-900/70"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Passage {i + 1}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  aria-label={`Remove passage ${i + 1}`}
                  onClick={async () => {
                    if (await removeSavedPassage(sessionId, p.id)) await refresh();
                  }}
                >
                  Remove
                </Button>
              </div>
              {/* No inner scroll: passages grow and the Screen tab's own scroll
                  is the only one (the list is already behind Show/Hide). */}
              <Markdown text={p.text} />
              {p.images.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.images.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setViewing({ key, label: label ?? null })}
                      aria-label={`Open saved screenshot${label ? `: ${label}` : ''}`}
                      title={label ?? undefined}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={screenImageUrl(sessionId, key)}
                        alt={label || 'Saved screenshot'}
                        className="h-16 rounded border border-sky-200/70 dark:border-sky-900/70"
                      />
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {viewing ? (
        <ScreenshotLightbox
          src={screenImageUrl(sessionId, viewing.key)}
          label={viewing.label}
          onClose={closeViewer}
        />
      ) : null}
    </div>
  );
}

/**
 * A saved screenshot shown full size over the Assist panel (fit to it, the
 * label as caption) — never in a browser window. Closed by Esc, a click
 * outside the image, or the close button.
 */
function ScreenshotLightbox({
  src,
  label,
  onClose,
}: {
  src: string;
  label: string | null;
  onClose: () => void;
}) {
  const hostScrollRef = useContext(AssistScrollContext);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // The Assist panel's section (the scroller's parent): the overlay covers
    // the panel, not the whole window.
    setHost(hostScrollRef?.current?.parentElement ?? null);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hostScrollRef, onClose]);

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label ? `Screenshot: ${label}` : 'Screenshot'}
      data-interactive="true"
      className={cn(
        'z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150',
        host ? 'absolute inset-0 rounded-lg' : 'fixed inset-0',
      )}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close screenshot"
        onClick={onClose}
        className="absolute right-2 top-2 rounded-md p-1.5 text-white/90 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      <figure
        className="flex max-h-full min-h-0 max-w-full flex-col items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label || 'Saved screenshot'}
          className="min-h-0 max-w-full flex-1 rounded object-contain"
        />
        {label ? <figcaption className="text-xs text-white/90">{label}</figcaption> : null}
      </figure>
    </div>
  );
  return host ? createPortal(overlay, host) : overlay;
}
