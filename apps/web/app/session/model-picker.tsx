'use client';

import { useState } from 'react';
import {
  MODEL_CATALOG,
  REASONING_EFFORTS,
  isReasoningEffort,
  providerForModel,
} from '@friday/shared-types';
import type { ReasoningEffort } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const CUSTOM_VALUE = '__custom__';
const DEFAULT_EFFORT_VALUE = '';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'XHigh effort',
  max: 'Max effort',
};

export interface ModelPickerOption {
  id: string;
  label: string;
}

export interface ModelPickerProps {
  model: string;
  onModelChange: (model: string) => void;
  /** Effort selector is shown only when both are passed. */
  effort?: ReasoningEffort | null;
  onEffortChange?: (effort: ReasoningEffort | null) => void;
  /** Preset list (default: the model catalog). Custom IDs are always allowed. */
  options?: readonly ModelPickerOption[];
  /** Accessible name of the model select. */
  ariaLabel?: string;
  title?: string;
  /** compact = dense Copilot header, default = Coding header,
   *  comfortable = full-size form fields (Setup page). */
  density?: Density;
  className?: string;
}

type Density = 'compact' | 'default' | 'comfortable';

// Height + type size per density; comfortable matches the base Select/Input.
const CONTROL_CLASS: Record<Density, string> = {
  compact: 'h-7 text-xs',
  default: 'h-8 text-xs',
  comfortable: 'h-9 text-sm',
};

/** Catalog models plus a free-form "Custom model…" entry (any vendor ID, or
 *  `provider:model`), and a reasoning-effort selector. */
export function ModelPicker({
  model,
  onModelChange,
  effort = null,
  onEffortChange,
  options = MODEL_CATALOG,
  ariaLabel = 'model',
  title,
  density = 'default',
  className,
}: ModelPickerProps) {
  const control = CONTROL_CLASS[density];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isCustom = !options.some((entry) => entry.id === model);
  const draftId = draft.trim();
  const draftProvider = draftId ? providerForModel(draftId) : undefined;

  const commitDraft = () => {
    if (!draftProvider) return;
    onModelChange(draftId);
    setEditing(false);
  };

  if (editing) {
    return (
      // Not a <form>: the picker also sits inside the Setup page's form, and
      // nested forms are invalid (Enter would submit the whole page).
      <div role="group" className={cn('flex items-center gap-1.5', className)}>
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          placeholder="claude-opus-5-5 · openai:my-model"
          aria-label="custom model id"
          aria-invalid={draftId !== '' && !draftProvider}
          title={
            draftId && !draftProvider
              ? 'Unknown vendor prefix — use provider:model (gemini, openai, deepseek, claude)'
              : draftProvider
                ? `Routes to ${draftProvider}`
                : undefined
          }
          className={cn(
            control,
            'min-w-0 flex-1 font-mono aria-[invalid=true]:border-rose-400 sm:w-56 sm:flex-none',
          )}
        />
        <Button
          type="button"
          size="sm"
          className={control}
          disabled={!draftProvider}
          onClick={commitDraft}
        >
          Use
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={control}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Select
        value={model}
        onChange={(e) => {
          if (e.target.value === CUSTOM_VALUE) {
            setDraft(isCustom ? model : '');
            setEditing(true);
            return;
          }
          onModelChange(e.target.value);
        }}
        className={control}
        aria-label={ariaLabel}
        title={title}
      >
        {options.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
        {isCustom ? <option value={model}>{model}</option> : null}
        <option value={CUSTOM_VALUE}>Custom model…</option>
      </Select>
      {onEffortChange ? (
        <Select
          value={effort ?? DEFAULT_EFFORT_VALUE}
          onChange={(e) =>
            onEffortChange(isReasoningEffort(e.target.value) ? e.target.value : null)
          }
          className={control}
          aria-label="reasoning effort"
          title="Reasoning effort — higher thinks longer before answering"
        >
          <option value={DEFAULT_EFFORT_VALUE}>Default effort</option>
          {REASONING_EFFORTS.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
