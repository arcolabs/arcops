// src/commands/inbox-full.test.ts
//
// KEH-277 - pins `inbox show --full`:
//   1. default output is UNCHANGED - no body fetches, no body_* keys (the
//      500-char snippet stays the only body material in list-style output);
//   2. --full fans out to /api/sites/:id/inbox/messages/:mid/body per message
//      and merges body_text / body_html / attachments / body_text_source /
//      body_truncated into each message (json mode);
//   3. text mode renders full bodies on stdout with EXPLICIT markers for the
//      truncated (legacy snippet-fallback) and html-only cases - never
//      silence that looks like a complete body;
//   4. a failing body fetch aborts non-zero (no partial thread presented as
//      complete);
//   5. the verb contract carries --full in both catalogs.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { COMMANDS } from './index';
import { VERBS } from '../verbs/registry';

// ── Contract: registry + catalog ───────────────────────────────────────
test('inbox:show carries --full as a cliOnly boolean in both catalogs', () => {
  const v = VERBS.find((v) => v.id === 'inbox:show')!;
  const full = v.args.find((a) => a.name === 'full')!;
  expect(full.type).toBe('boolean');
  expect(full.cliOnly).toBe(true);

  const cmd = COMMANDS.find((c) => c.path.join(' ') === 'inbox show')!;
  const flagNames = (cmd.flags ?? []).map((f) => (typeof f === 'string' ? f : f.name));
  expect(flagNames).toContain('--full');
});

// ── Handler behavior: real local server + subprocess CLI ───────────────
type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

function mockServer(routes: Route[]): Promise<{ base: string; stop: () => Promise<void> }> {
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
  const base = `http://127.0.0.1:${server.port}`;
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/sites'); break; } catch { await new Promise((r) => setTimeout(r, 10)); }
    }
    return { base, stop: () => server.stop(true) };
  })();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, ...env, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const SITES_LIST = { sites: [{ id: 42, domain: 'acme.com', name: 'Acme' }] };

const FULL_TEXT = 'x'.repeat(1200) + ' FULL-BODY-MARKER pricing terms follow.';

const THREAD = {
  thread: { id: 123, subject: 'Negotiation', status: 'open', unread_for_ops: false, assignee_email: null },
  messages: [
    { id: 10, from_email: 'customer@example.com', subject: 'Negotiation', direction: 'inbound', received_at: '2026-07-20T00:00:00Z', snippet: FULL_TEXT.slice(0, 500) },
    { id: 11, from_email: 'support@acme.com', subject: 'Re: Negotiation', direction: 'outbound', received_at: '2026-07-20T01:00:00Z', snippet: 'our reply snippet' },
    { id: 12, from_email: 'customer@example.com', subject: 'Re: Negotiation', direction: 'inbound', received_at: '2026-07-20T02:00:00Z', snippet: 'html-only snippet' },
  ],
};

const BODIES: Record<number, unknown> = {
  10: { text: FULL_TEXT, html: null, attachments: [{ filename: 'quote.pdf', content_type: 'application/pdf', size: 12345 }], text_source: 'body', truncated: false },
  // Legacy row: body columns never backfilled - server says so explicitly.
  11: { text: 'our reply snippet', html: null, attachments: [], text_source: 'snippet_fallback', truncated: true },
  // HTML-only message.
  12: { text: null, html: '<p>html body</p>', attachments: [], text_source: 'body', truncated: false },
};

function inboxServer(opts: { failOnMessage?: number } = {}) {
  const bodyFetches: number[] = [];
  return {
    bodyFetches,
    start: () => mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES_LIST);
        if (req.method === 'GET' && url.pathname === '/api/sites/42/inbox/threads/123') return json(THREAD);
        const m = /^\/api\/sites\/42\/inbox\/messages\/(\d+)\/body$/.exec(url.pathname);
        if (req.method === 'GET' && m) {
          const id = Number(m[1]);
          bodyFetches.push(id);
          if (opts.failOnMessage === id) {
            return json({ error: { code: 'message_body_failed', message: 'Failed to read message body.' } }, 500);
          }
          return json(BODIES[id] ?? { error: { code: 'message_not_found', message: 'nope' } }, BODIES[id] ? 200 : 404);
        }
        return undefined;
      },
    ]),
  };
}

async function showThread(base: string, extra: string[]) {
  const home = mkdtempSync(resolve(tmpdir(), 'arcops-full-'));
  return runCli(
    ['inbox', 'show', 'acme.com', '123', ...extra, '--api', base, '--token', 'ts_test'],
    { HOME: home },
  );
}

describe('inbox show --full (KEH-277)', () => {
  test('default show: NO body fetches, NO body_* keys (byte-compatible default)', async () => {
    const srv = inboxServer();
    const { base, stop } = await srv.start();
    try {
      const r = await showThread(base, ['--output', 'json']);
      expect(r.code).toBe(0);
      expect(srv.bodyFetches).toEqual([]);
      const out = JSON.parse(r.stdout) as { messages: Record<string, unknown>[] };
      for (const m of out.messages) {
        expect('body_text' in m).toBe(false);
        expect('body_html' in m).toBe(false);
        expect(typeof m.snippet).toBe('string');
      }
    } finally { await stop(); }
  });

  test('--full --output json: every message gains full body + truncation metadata', async () => {
    const srv = inboxServer();
    const { base, stop } = await srv.start();
    try {
      const r = await showThread(base, ['--full', '--output', 'json']);
      expect(r.code).toBe(0);
      expect(srv.bodyFetches).toEqual([10, 11, 12]);
      const out = JSON.parse(r.stdout) as { messages: Record<string, unknown>[] };
      const [m10, m11, m12] = out.messages;
      expect(m10.body_text).toBe(FULL_TEXT);
      expect((m10.body_text as string).length).toBeGreaterThan(500);
      expect(m10.body_truncated).toBe(false);
      expect((m10.attachments as unknown[]).length).toBe(1);
      expect(m11.body_truncated).toBe(true);
      expect(m11.body_text_source).toBe('snippet_fallback');
      expect(m12.body_text).toBeNull();
      expect(m12.body_html).toBe('<p>html body</p>');
    } finally { await stop(); }
  });

  test('--full text mode: full body + explicit TRUNCATED / HTML-only / attachment markers on stdout', async () => {
    const srv = inboxServer();
    const { base, stop } = await srv.start();
    try {
      const r = await showThread(base, ['--full', '--output', 'text']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('FULL-BODY-MARKER pricing terms follow.');
      expect(r.stdout).toContain('[TRUNCATED:');
      expect(r.stdout).toContain('[HTML-only body');
      expect(r.stdout).toContain('[attachment: quote.pdf (application/pdf, 12345 bytes)]');
      // Thread metadata stays on stderr (stdout = data).
      expect(r.stderr).toContain('Thread: Negotiation');
    } finally { await stop(); }
  });

  test('body fetch failure aborts non-zero (no partial thread as complete)', async () => {
    const srv = inboxServer({ failOnMessage: 11 });
    const { base, stop } = await srv.start();
    try {
      const r = await showThread(base, ['--full', '--output', 'json']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('message_body_failed');
    } finally { await stop(); }
  });
});
