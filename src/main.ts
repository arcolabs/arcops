// src/main.ts
import './lib/pipe-guard'; // KEH-278 B: must run before any output so a closed downstream pipe can never crash the process mid-action
import { maybeWarnUpdate } from './lib/update-check';
import { dispatch } from './dispatch';

// Announce newer releases on interactive startup (see src/lib/update-check.ts).
// Fire the check before dispatch so the bounded registry fetch (<=3s,
// 24h-cached) runs concurrently with the command instead of adding to its
// latency; await it before exit so the process never terminates mid-fetch.
const updateWarn = maybeWarnUpdate();

const code = await dispatch(process.argv.slice(2));
await updateWarn;
process.exit(code);
