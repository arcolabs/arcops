// src/main.ts
import './lib/pipe-guard'; // KEH-278 B: must run before any output so a closed downstream pipe can never crash the process mid-action
import { maybeWarnUpdate } from './lib/update-check';
import { dispatch } from './dispatch';

// Announce newer releases on interactive startup (see src/lib/update-check.ts).
// Fire the check before dispatch so the bounded registry fetch (<=3s,
// 24h-cached) runs concurrently with the command instead of adding to its
// latency; await it before exit so the process never terminates mid-fetch.
const updateWarn = maybeWarnUpdate();

// Resolve once everything already queued on `stream` has been handed to the
// OS. Writes to a pipe are asynchronous in Node, so `process.exit()` right
// after a large write drops the unflushed tail (issue #3: piped JSON cut to
// one pipe buffer, exit 0). A zero-length write's callback runs after every
// earlier write completes - or with an error (EPIPE when the reader closed
// early, already swallowed by the pipe guard), which still means "done".
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0 || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => stream.write('', () => resolve()));
}

const code = await dispatch(process.argv.slice(2));
await updateWarn;
// Flush, then exit explicitly: keeping the hard exit means a stray timer or
// socket can never leave the CLI hanging after its work is done.
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
