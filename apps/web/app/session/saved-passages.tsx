'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/lib/markdown';
import { passagePreview } from '@/lib/saved-passages';
import {
  fetchSavedPassages,
  removeSavedPassage,
  screenImageUrl,
  type SavedPassage,
} from '@/lib/session-context';

interface SavedPassagesProps {
  sessionId: string;
  /** Changes whenever the backend's remembered passages may have changed. */
  refreshKey: number;
  onClearAll: () => void;
}

export function SavedPassages({ sessionId, refreshKey, onClearAll }: SavedPassagesProps) {
  const [passages, setPassages] = useState<SavedPassage[]>([]);
  const [expanded, setExpanded] = useState(false);

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
                  {p.images.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => window.open(screenImageUrl(sessionId, key))}
                      aria-label="Open saved screenshot"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={screenImageUrl(sessionId, key)}
                        alt="Saved screenshot"
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
    </div>
  );
}
