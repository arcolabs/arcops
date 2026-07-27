import { describe, expect, test, beforeAll } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// KEH-278 B: regression test for the "write verb hit a closed pipe and
// silently never sent" failure. Reproduces the original fault end-to-end:
//   `arcops inbox send ... --yes 2>&1 | head -1`
// with a body large enough to overflow the 64KB pipe buffer once `head`
// closes. Without the pipe guard, the uncaught EPIPE 'error' event on
// process.stdout/stderr crashes the process mid-send (Node turns the unhandled
// stream error into an uncaught exception); with the guard the EPIPE is
// swallowed and the send completes cleanly (acceptance B1: either complete
// the write or fail non-zero - never exit-0-without-sending; here the send
// fires AND exit is 0).
//
// Runtime fidelity: this MUST run the CLI under Node - the production runtime
// (the published binary is `#!/usr/bin/env node`). Two reasons it cannot run
// under Bun: (1) Bun's runtime swallows EPIPE on its own, so it would not
// reproduce the crash and could not detect regressions; (2) Node cannot load
// the raw .ts sources. So we bundle src/main.ts (target node) - the same shape
// as the shipped dist/arcops.mjs - which inlines the pipe-guard import so the
// guard ships exactly as in production. Node is preinstalled on GitHub Actions
// ubuntu-latest and on the dev machine; if it is absent the tests skip (they
// do not silently pass).
//
// Why the mock delays the send response: the EPIPE fires on a future tick, so
// it races `process.exit(0)` at the end of main.ts. A fast mock lets exit win
// and hides the crash. The 250ms delay holds the CLI inside the send `await`
// when the EPIPE fires, making the crash (without the guard) deterministic.

type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

function mockServer(routes: Route[]): { base: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      for (const r of routes) {
        const res = await r(req, url);
        if (res) return res;
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, 'main.ts');
const NODE = (typeof Bun !== 'undefined' && typeof Bun.which === 'function') ? Bun.which('node') : null;

let BUNDLE: string | null = null;
beforeAll(async () => {
  if (!NODE) return;
  const outdir = mkdtempSync(resolve(tmpdir(), 'arcops-sigpipe-'));
  const r = await Bun.build({ entrypoints: [MAIN], target: 'node', outdir, minify: false });
  if (!r.success) throw new Error('sigpipe bundle failed: ' + r.logs.map(String).join('; '));
  BUNDLE = resolve(outdir, 'main.js');
});

// `{ node BUNDLE ... 2>&1; echo X:$? >&2; } | head -1` - head closes the read
// end after one line; the CLI's next write EPIPEs. `$?` right after the CLI is
// its exit code; echo to FD 2 so it survives head closing the pipe (the
// group's stdout is the pipe, FD 2 is the parent's stderr).
function pipelineCmd(args: string): string {
  return `{ '${NODE}' '${BUNDLE}' ${args} 2>&1; echo "X:$?" >&2; } | head -1`;
}

async function runPipeline(cmd: string): Promise<{ stdout: string; stderr: string; cliExit: number | null }> {
  const proc = Bun.spawn(['sh', '-c', cmd], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const m = stderr.match(/X:(-?\d+)/);
  return { stdout, stderr, cliExit: m ? Number(m[1]) : null };
}

// Huge body: the stderr send preview overflows the 64KB pipe buffer once head
// closes, guaranteeing an EPIPE on the merged stream during the send await.
const HUGE_BODY = '# Quote\n\n' + ('x'.repeat(1000) + '\n').repeat(80);
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

describe.skipIf(!NODE)('pipe guard: write verb survives a closed downstream pipe (KEH-278 B)', () => {
  test('inbox send completes the send when piped to `head` (EPIPE suppressed)', async () => {
    let sendHits = 0;
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined,
      async (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/send' && req.method === 'POST') {
          sendHits++;
          // Hold the response so the EPIPE from the closed pipe fires during
          // the send await (deterministic crash without the guard).
          await new Promise((r) => setTimeout(r, 250));
          return json({ threadId: 1, messageId: 99 });
        }
        return undefined;
      },
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? json({ thread: { id: 1 }, messages: [{ id: 99, direction: 'outbound' }] }) : undefined,
    ]);
    try {
      const args = `--api ${base} inbox send sunor.cc --to a@b.com --subject Q --body ${shellQuote(HUGE_BODY)} --yes`;
      const r = await runPipeline(pipelineCmd(args));
      expect(sendHits).toBe(1);          // the send actually fired
      expect(r.cliExit).toBe(0);         // clean exit - no EPIPE crash
    } finally {
      await stop();
    }
  });

  test('inbox reply completes the send when piped to `head` (EPIPE suppressed)', async () => {
    let replyHits = 0;
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 7, domain: 'sunor.cc' }] }) : undefined,
      async (req, url) => {
        if (url.pathname === '/api/sites/7/inbox/threads/11' && req.method === 'GET') {
          return json({
            thread: { subject: 'Refund', participant_emails: ['cust@x.com'], status: 'open' },
            messages: [
              { id: 1, from_email: 'cust@x.com', received_at: '2026-07-16T10:00:00Z', direction: 'inbound' },
              { id: 99, direction: 'outbound' },
            ],
          });
        }
        return undefined;
      },
      async (req, url) => {
        if (url.pathname === '/api/sites/7/inbox/threads/11/reply' && req.method === 'POST') {
          replyHits++;
          await new Promise((r) => setTimeout(r, 250));
          return json({ messageId: 99 });
        }
        return undefined;
      },
    ]);
    try {
      const args = `--api ${base} inbox reply sunor.cc 11 --body ${shellQuote(HUGE_BODY)} --yes`;
      const r = await runPipeline(pipelineCmd(args));
      expect(replyHits).toBe(1);
      expect(r.cliExit).toBe(0);
    } finally {
      await stop();
    }
  });

  test('read verb (`inbox ls | head`) still exits cleanly - not chatty, not erroring (B4)', async () => {
    // B4: the guard must not change read-verb behavior. `inbox ls | head` must
    // keep exiting cleanly with no EPIPE noise. Large response so the JSON
    // write exercises the closed-pipe path.
    const threads = Array.from({ length: 2000 }, (_, i) => ({
      id: i + 1, subject: `thread subject number ${i} with some padding text`,
      last_message_at: '2026-07-16T10:00:00Z', unread_for_ops: false,
      assignee_email: null, status: 'open',
    }));
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads' && req.method === 'GET'
        ? json({ threads, counts: { open: 2000 }, nextCursor: null }) : undefined,
    ]);
    try {
      const r = await runPipeline(pipelineCmd(`--api ${base} inbox ls sunor.cc`));
      expect(r.cliExit).toBe(0);               // clean exit, no EPIPE crash
      expect(r.stderr).not.toContain('EPIPE'); // no uncaught-error noise
      expect(r.stderr).not.toContain("Unhandled 'error' event");
    } finally {
      await stop();
    }
  });
});
