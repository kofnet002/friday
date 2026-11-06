import type { ExtractedProblem } from '@friday/shared-types';

// A scroll scan reads the WHOLE problem. Tabs opened earlier from single
// screenshots of the same page are partial reads of it (top half, bottom
// half…), so the scanned tab replaces them instead of sitting beside them.

interface TabLike {
  fingerprint: string;
  problem: ExtractedProblem;
}

const SHINGLE = 3;
// Share of a tab's statement 3-grams found in the scanned statement for the
// tab to count as a partial read of the scanned problem.
const CONTAINMENT = 0.7;

function normTitle(title: string | null | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function shingles(text: string | null | undefined): Set<string> {
  const words = (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length < SHINGLE) return new Set(words.length ? [words.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - SHINGLE; i++) {
    out.add(words.slice(i, i + SHINGLE).join(' '));
  }
  return out;
}

function statementOf(problem: ExtractedProblem): string {
  return problem.problem_statement ?? '';
}

/** True when `tab` holds the same problem as `scanned` (a partial or
 *  earlier read of it). Titles decide when both exist; otherwise the tab's
 *  statement must be mostly contained in the scanned one. */
export function isSameProblem(tab: ExtractedProblem, scanned: ExtractedProblem): boolean {
  const a = normTitle(tab.title);
  const b = normTitle(scanned.title);
  if (a && b) return a === b;
  const tabSh = shingles(statementOf(tab));
  if (!tabSh.size) return false;
  const scannedSh = shingles(statementOf(scanned));
  let shared = 0;
  for (const s of tabSh) if (scannedSh.has(s)) shared++;
  return shared / tabSh.size >= CONTAINMENT;
}

/** Insert the scanned tab, replacing tabs that are partial reads of the same
 *  problem (in place, at the first one's position). Returns the new list and
 *  the fingerprints that were replaced. */
export function placeScannedTab<T extends TabLike>(
  tabs: readonly T[],
  scannedTab: T,
  maxTabs: number,
): { tabs: T[]; replaced: string[] } {
  const replaced = tabs
    .filter(
      (t) =>
        t.fingerprint !== scannedTab.fingerprint && isSameProblem(t.problem, scannedTab.problem),
    )
    .map((t) => t.fingerprint);
  const firstIdx = tabs.findIndex(
    (t) => t.fingerprint === scannedTab.fingerprint || replaced.includes(t.fingerprint),
  );
  const kept = tabs.filter(
    (t) => t.fingerprint !== scannedTab.fingerprint && !replaced.includes(t.fingerprint),
  );
  const insertAt =
    firstIdx === -1 ? kept.length : tabs.slice(0, firstIdx).filter((t) => kept.includes(t)).length;
  const next = [...kept.slice(0, insertAt), scannedTab, ...kept.slice(insertAt)];
  // Over the cap: drop the oldest tabs, never the scanned one.
  let toDrop = Math.max(0, next.length - maxTabs);
  const trimmed = next.filter((t) => {
    if (toDrop > 0 && t !== scannedTab) {
      toDrop--;
      return false;
    }
    return true;
  });
  return { tabs: trimmed, replaced };
}
