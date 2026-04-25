'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * One panel-scoped error boundary. If a child crashes mid-render, the rest
 * of the session UI keeps working — the user just sees a small red "click
 * to reload this panel" card in place of the broken panel.
 *
 * React class component because hooks can't catch render errors.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[panel:${this.props.label}] crashed`, error, info);
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-start gap-3 rounded-2xl border border-red-400/40 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-200">
          <span className="text-xs font-semibold uppercase tracking-[0.18em]">
            {this.props.label} crashed
          </span>
          <span className="break-words font-mono text-xs opacity-80">
            {this.state.error.message}
          </span>
          <Button onClick={this.reset} size="sm" variant="outline">
            Reload panel
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
