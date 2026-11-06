// Where to draw an in-window tooltip so it stays inside the viewport. Friday's
// window can be as short as its control bar, so the tip flips above the
// anchor when there's no room below and is clamped to the edges.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

const GAP = 6;
const MARGIN = 4;

export function placeTooltip(
  anchor: Box,
  tip: Size,
  viewport: Size,
): { left: number; top: number } {
  const centered = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(MARGIN, Math.min(centered, viewport.width - tip.width - MARGIN));
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - tip.height;
  const fitsBelow = below + tip.height <= viewport.height - MARGIN;
  const top =
    fitsBelow || above < MARGIN ? Math.min(below, viewport.height - tip.height - MARGIN) : above;
  return { left, top: Math.max(MARGIN, top) };
}

const LIST_GAP = 2;

export interface ListboxPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

/** Where to open a dropdown list of natural height `contentHeight` under (or
 *  over) its trigger. Below when it fits; otherwise whichever side has more
 *  room, with maxHeight capping it so the list scrolls instead of clipping. */
export function placeListbox(anchor: Box, contentHeight: number, viewport: Size): ListboxPlacement {
  const bottom = anchor.top + anchor.height;
  const roomBelow = viewport.height - bottom - LIST_GAP - MARGIN;
  const roomAbove = anchor.top - LIST_GAP - MARGIN;
  const above = roomBelow < contentHeight && roomAbove > roomBelow;
  const maxHeight = Math.max(0, Math.min(contentHeight, above ? roomAbove : roomBelow));
  const width = anchor.width;
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN));
  const top = above ? anchor.top - LIST_GAP - maxHeight : bottom + LIST_GAP;
  return { left, top, width, maxHeight, above };
}
