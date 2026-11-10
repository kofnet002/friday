// Preloaded (`--require`) into the bundled web server: exit when the Friday
// app that spawned it is gone, so a crash or force-quit doesn't leave the
// server holding :3333 and blocking the next launch. The backend does the
// same in apps/backend/app/server.py.

const PARENT_POLL_MS = 1000;
const HARD_EXIT_AFTER_MS = 5000;
const parentPid = Number(process.env.FRIDAY_PARENT_PID);

if (parentPid) {
  const poll = setInterval(() => {
    if (process.ppid === parentPid) return;
    clearInterval(poll);
    process.kill(process.pid, 'SIGTERM');
    // Backstop if graceful shutdown hangs; unref'd so it never delays a clean exit.
    setTimeout(() => process.exit(1), HARD_EXIT_AFTER_MS).unref();
  }, PARENT_POLL_MS);
  poll.unref();
}
