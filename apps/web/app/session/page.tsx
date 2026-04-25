import { SessionClient } from './session-client';

/**
 * Floating control bar — minimal page wrapper, no backdrop.
 * The Electron window itself is transparent below the bar so popovers
 * appear to float over the user's desktop content.
 */
export default function SessionPage() {
  return (
    <main className="px-3 py-3">
      <SessionClient />
    </main>
  );
}
