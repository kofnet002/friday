'use client';

// Inside Friday's window, a native `title` tooltip is drawn by macOS in its own
// window, which screen capture and meeting screen share CAN see (only Friday's
// main window is excluded from capture). This guard moves every `title` into
// `data-tip` and draws the tip inside the page instead, so it stays as hidden
// as the rest of Friday. Outside the Electron shell (a normal browser) it does
// nothing.

import { useEffect, useRef, useState } from 'react';

import { placeTooltip } from '@/lib/overlay-position';

const SHOW_DELAY_MS = 450;

function adoptTitle(el: Element): void {
  const text = el.getAttribute('title');
  if (text === null) return;
  el.removeAttribute('title');
  if (!text.trim()) return;
  el.setAttribute('data-tip', text);
  // Keep the accessible name for icon-only controls that relied on title.
  if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) {
    el.setAttribute('aria-label', text);
  }
}

function adoptAll(root: ParentNode): void {
  if (root instanceof Element) adoptTitle(root);
  root.querySelectorAll('[title]').forEach(adoptTitle);
}

interface Tip {
  text: string;
  left: number;
  top: number;
  visible: boolean;
}

export function InWindowTooltips() {
  const [active, setActive] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null);

  useEffect(() => setActive(Boolean(window.friday)), []);

  // Strip native titles as soon as they appear or change.
  useEffect(() => {
    if (!active) return;
    adoptAll(document.body);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element) adoptTitle(r.target);
        r.addedNodes.forEach((node) => {
          if (node instanceof Element) adoptAll(node);
        });
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    });
    return () => observer.disconnect();
  }, [active]);

  // Show the in-page tip after a short hover; hide on leave, click, key, scroll.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      anchorRef.current = null;
      setTip(null);
    };
    const onOver = (event: PointerEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (anchor === anchorRef.current) return;
      hide();
      if (!anchor) return;
      anchorRef.current = anchor;
      timer = setTimeout(() => {
        const text = anchor.getAttribute('data-tip');
        if (text && anchorRef.current === anchor) setTip({ text, left: 0, top: 0, visible: false });
      }, SHOW_DELAY_MS);
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [active]);

  // Measure, then position inside the viewport.
  useEffect(() => {
    if (!tip || tip.visible || !tipRef.current || !anchorRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const pos = placeTooltip(
      { left: a.left, top: a.top, width: a.width, height: a.height },
      { width: t.width, height: t.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setTip({ ...tip, ...pos, visible: true });
  }, [tip]);

  if (!active || !tip) return null;
  return (
    <div
      ref={tipRef}
      role="tooltip"
      style={{ left: tip.left, top: tip.top, opacity: tip.visible ? 1 : 0 }}
      className="pointer-events-none fixed z-[9999] max-w-[280px] rounded-md bg-neutral-900/95 px-2 py-1 text-[11px] leading-snug text-neutral-50 shadow-lg ring-1 ring-white/10 transition-opacity duration-100"
    >
      {tip.text}
    </div>
  );
}
