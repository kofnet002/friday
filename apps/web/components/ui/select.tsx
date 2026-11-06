'use client';

// A dropdown drawn inside the page. A native <select> opens its list as a
// macOS menu - a separate window that screen capture and meeting screen share
// can see even while Friday's own window is hidden from them. This keeps the
// <select>-style API (<option> children, onChange(e) with e.target.value) so
// call sites don't change, but renders the list in the DOM.

import { ChevronDown } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { placeListbox, type ListboxPlacement } from '@/lib/overlay-position';
import { cn } from '@/lib/utils';

interface Option {
  value: string;
  label: string;
  disabled: boolean;
}

export interface SelectChangeEvent {
  target: { value: string };
}

export interface SelectProps {
  value: string;
  onChange?: (event: SelectChangeEvent) => void;
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
  title?: string;
  'aria-label'?: string;
}

const ROW_HEIGHT = 30;
const LIST_PADDING = 8;

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node))
    return textOf(node.props.children);
  return '';
}

function readOptions(children: React.ReactNode): Option[] {
  const out: Option[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>(child)) return;
    if (child.type !== 'option') return;
    const label = textOf(child.props.children);
    out.push({
      value: child.props.value === undefined ? label : String(child.props.value),
      label,
      disabled: Boolean(child.props.disabled),
    });
  });
  return out;
}

function nextEnabled(options: Option[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < options.length; i += step) {
    if (!options[i]?.disabled) return i;
  }
  return from;
}

export function Select({
  value,
  onChange,
  children,
  className,
  disabled,
  id,
  title,
  'aria-label': ariaLabel,
}: SelectProps) {
  const options = readOptions(children);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [place, setPlace] = React.useState<ListboxPlacement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const listId = React.useId();

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange?.({ target: { value: option.value } });
    close(true);
  };

  const openList = () => {
    if (disabled || options.length === 0) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace(
      placeListbox(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        options.length * ROW_HEIGHT + LIST_PADDING,
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    setActive(selectedIndex >= 0 ? selectedIndex : nextEnabled(options, -1, 1));
    setOpen(true);
  };

  // Close on outside press, window blur, resize or scroll outside the list.
  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    const onBlur = () => close(false);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onBlur);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onBlur);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  // Keep the highlighted option in view.
  React.useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => nextEnabled(options, i, 1)),
      ArrowUp: () => setActive((i) => nextEnabled(options, i, -1)),
      Home: () => setActive(nextEnabled(options, -1, 1)),
      End: () => setActive(nextEnabled(options, options.length, -1)),
      Enter: () => choose(active),
      ' ': () => choose(active),
      Escape: () => close(true),
    };
    const handler = keys[event.key];
    if (handler) {
      event.preventDefault();
      handler();
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    // Type-ahead: jump to the next option starting with the typed letter.
    if (event.key.length === 1) {
      const letter = event.key.toLowerCase();
      const order = options.map((_, k) => (active + 1 + k) % options.length);
      const hit = order.find(
        (k) => !options[k]?.disabled && options[k]?.label.toLowerCase().startsWith(letter),
      );
      if (hit !== undefined) setActive(hit);
    }
  };

  const current = options[selectedIndex];

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-9 w-full items-center rounded-md border border-neutral-300 bg-white/70 px-3 pr-8 text-left text-sm shadow-sm transition-colors',
          'focus-visible:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/30',
          'disabled:opacity-50',
          'dark:border-neutral-700 dark:bg-neutral-950/60',
          className,
        )}
      >
        <span className="truncate">{current?.label ?? value}</span>
      </button>
      <ChevronDown
        className={cn(
          'pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500 transition-transform dark:text-neutral-400',
          open && 'rotate-180',
        )}
        aria-hidden
      />
      {open && place
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              data-interactive="true"
              style={{
                left: place.left,
                top: place.top,
                minWidth: place.width,
                maxHeight: place.maxHeight,
              }}
              className="fixed z-[9998] overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 text-sm text-neutral-900 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {options.map((option, index) => (
                <li
                  key={`${option.value}-${index}`}
                  id={`${listId}-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === selectedIndex}
                  aria-disabled={option.disabled || undefined}
                  onPointerEnter={() => !option.disabled && setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  style={{ minHeight: ROW_HEIGHT - 2 }}
                  className={cn(
                    'flex cursor-default select-none items-center whitespace-nowrap rounded px-2.5 py-1',
                    index === active &&
                      'bg-sky-500/15 text-sky-900 dark:bg-sky-400/20 dark:text-sky-50',
                    index === selectedIndex && 'font-medium',
                    option.disabled && 'opacity-40',
                  )}
                >
                  {option.label}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
