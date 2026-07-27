// src/lib/pipe-guard.ts
//
// KEH-278 B: keep write-class verbs from dying mid-action when a downstream
// pipe consumer (`head` / `jq` / `grep` / an agent wrapper) closes stdout or
// stderr early. Agent-first tools get piped constantly, and those consumers
// close the read end as soon as they have what they need.
//
// What actually crashes the process: a write to a closed pipe emits an async
// 'error' event (errno EPIPE) on the stream. `process.stdout` / `process.stderr`
// ship with no 'error' listener, so the runtime turns the unhandled event into
// an uncaught exception that terminates the process at an arbitrary future
// tick - including mid-`await` inside a send-class verb. The stderr send
// preview has already printed by then, so the run "looks successful" while the
// email may never have been sent. That is the "looked successful, nothing
// happened" failure mode (acceptance B1) this guard kills.
//
// Mechanism (acceptance B2 - explicit EPIPE handling): attach an 'error'
// listener to stdout and stderr that swallows EPIPE and re-throws anything
// else (a real I/O fault stays visible instead of being masked). With EPIPE
// neutralized, a write verb always runs its action to completion - the send +
// verify-after-send happen before the final stdout write, so a closed pipe
// only means the trailing data is not delivered, not that the action was
// skipped. Read verbs (`inbox ls | head`) stop crashing too: the consumer
// closes early, remaining writes are silently dropped, and the process exits
// cleanly when its work is done (B4 - read verbs stay pipe-friendly, never
// chatty or erroring).
//
// Why not the other mechanisms: ignoring SIGPIPE process-wide is too blunt
// (it is a process signal, not a stream event) and unnecessary - Node already
// ignores SIGPIPE; the crash comes from the unhandled stream 'error' event,
// which is what we handle here. "Complete the write before touching stdout" is
// already the send-verb structure (send + verify precede the result print);
// this guard is the defense-in-depth that holds regardless of call site or
// future code path.

// True for the EPIPE that a closed downstream pipe produces. Other write
// errors (ENOSPC, EIO, ...) are real faults and must still surface.
export function isPipeError(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === 'EPIPE';
}

// Minimal structural type so both process.stdout (fd: 1) and process.stderr
// (fd: 2) are accepted despite their distinct literal `fd` types.
type Guardable = { on(event: 'error', listener: (err: unknown) => void): unknown };

function guardStream(stream: Guardable): void {
  stream.on('error', (e: unknown) => {
    if (isPipeError(e)) return; // downstream pipe closed - drop the write quietly
    throw e;                    // real I/O fault - surface it, do not mask
  });
}

let installed = false;

// Attach the EPIPE guard to stdout + stderr. Idempotent: process streams are
// process-global, so a single install lasts for the whole run. Exported so a
// caller can force installation (and tests can observe the flag); the module
// also auto-installs on import below.
export function installPipeGuard(): void {
  if (installed) return;
  installed = true;
  guardStream(process.stdout);
  guardStream(process.stderr);
}

// Auto-install on import. main.ts imports this before dispatch, so every CLI
// entrypoint is protected before any output happens.
installPipeGuard();
