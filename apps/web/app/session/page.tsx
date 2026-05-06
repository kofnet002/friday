import { SessionClient } from './session-client';

/**
 * Floating control bar — no page-level wrapper or padding. The Electron
 * window is click-through by default; only the SessionClient's own
 * data-interactive surfaces capture mouse events.
 */
export default function SessionPage() {
  return <SessionClient />;
}
