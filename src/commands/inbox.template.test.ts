import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Integration tests for template variable rendering across the three
// template-consuming inbox verbs: reply, draft create, and send.
// Each verb runs the real CLI against an in-process mock server and asserts
// that {{site_domain}} is resolved from the site context, not left literal.

type Route = (req: Request, url: URL) => Response | undefined;

function mockServer(routes: Route[]): { base: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      for (const r of routes) {
        const res = r(req, url);
        if (res) return res;
      }
      return new Response('not found', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    stop: () => server.stop(true),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

let tempHome: string | undefined;

function setupHome(): string {
  tempHome = mkdtempSync(resolve(tmpdir(), 'arcops-test-'));
  mkdirSync(resolve(tempHome, '.arcops', 'templates'), { recursive: true });
  writeFileSync(
    resolve(tempHome, '.arcops', 'templates', 'site-domain.md'),
    'Hello from {{site_domain}} to {{customer_email}} about {{thread_subject}}.',
  );
  // New-thread send has no thread subject; use a template that only needs the
  // vars send actually supplies so the assertion is precise.
  writeFileSync(
    resolve(tempHome, '.arcops', 'templates', 'site-domain-send.md'),
    'Hello from {{site_domain}} to {{customer_email}}.',
  );
  return tempHome;
}

async function runCli(home: string, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: home,
      ARCOPS_TIMEOUT_MS: '5000',
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
}

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

describe('inbox template variable rendering', () => {
  beforeEach(() => setupHome());
  afterEach(() => {
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  test('inbox reply renders {{site_domain}} from thread site', async () => {
    let capturedBody: string | undefined;
    let threadFetchCount = 0;
    const { base, stop } = mockServer([
      (req, url) =>
        url.pathname === '/api/sites' && req.method === 'GET'
          ? json({ sites: [{ id: 7, domain: 'reply.example.com' }] })
          : undefined,
      (req, url) => {
        if (url.pathname === '/api/sites/7/inbox/threads/11' && req.method === 'GET') {
          // First GET is the thread load; second GET is verify-after-send and
          // must show a new outbound message for reply to exit 0.
          const outbound = threadFetchCount > 0 ? [{ id: 2, from_email: 'ops@reply.example.com', received_at: '2026-07-16T10:05:00Z', direction: 'outbound' }] : [];
          threadFetchCount++;
          return json({
            thread: { subject: 'Refund', participant_emails: ['user@example.com'], status: 'open', assignee_email: null },
            messages: [
              { id: 1, from_email: 'user@example.com', received_at: '2026-07-16T10:00:00Z', direction: 'inbound' },
              ...outbound,
            ],
          });
        }
        return undefined;
      },
      (req, url) => {
        if (url.pathname === '/api/sites/7/inbox/threads/11/reply' && req.method === 'POST') {
          return readJsonBody(req).then((body) => {
            capturedBody = (body as { body: string }).body;
            return json({ ok: true });
          }) as unknown as Response;
        }
        return undefined;
      },
    ]);

    try {
      const res = await runCli(tempHome!, [
        '--api', base, 'inbox', 'reply', 'reply.example.com', '11',
        '--template', 'site-domain', '--yes',
      ]);
      expect(res.code).toBe(0);
      expect(capturedBody).toBe('Hello from reply.example.com to user@example.com about Refund.');
    } finally {
      await stop();
    }
  });

  test('inbox draft create renders {{site_domain}} from thread site', async () => {
    let capturedBodyText: string | undefined;
    const { base, stop } = mockServer([
      (req, url) =>
        url.pathname === '/api/sites' && req.method === 'GET'
          ? json({ sites: [{ id: 8, domain: 'draft.example.com' }] })
          : undefined,
      (req, url) =>
        url.pathname === '/api/sites/8/inbox/threads/22' && req.method === 'GET'
          ? json({
              thread: { subject: 'Invoice', participant_emails: ['acct@example.com'], status: 'open', assignee_email: null },
              messages: [{ id: 1, from_email: 'acct@example.com', received_at: '2026-07-16T11:00:00Z', direction: 'inbound' }],
            })
          : undefined,
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/threads/22/drafts' && req.method === 'POST') {
          return readJsonBody(req).then((body) => {
            capturedBodyText = (body as { body_text: string }).body_text;
            return json({ draft: { id: 5 } });
          }) as unknown as Response;
        }
        return undefined;
      },
    ]);

    try {
      const res = await runCli(tempHome!, [
        '--api', base, 'inbox', 'draft', 'create', 'draft.example.com', '22',
        '--template', 'site-domain',
      ]);
      expect(res.code).toBe(0);
      expect(capturedBodyText).toBe('Hello from draft.example.com to acct@example.com about Invoice.');
    } finally {
      await stop();
    }
  });

  test('inbox send renders {{site_domain}} from thread site', async () => {
    let capturedBody: string | undefined;
    const { base, stop } = mockServer([
      (req, url) =>
        url.pathname === '/api/sites' && req.method === 'GET'
          ? json({ sites: [{ id: 9, domain: 'send.example.com' }] })
          : undefined,
      (req, url) => {
        if (url.pathname === '/api/sites/9/inbox/send' && req.method === 'POST') {
          return readJsonBody(req).then((body) => {
            capturedBody = (body as { body: string }).body;
            return json({ threadId: 33, messageId: 99 });
          }) as unknown as Response;
        }
        return undefined;
      },
      (req, url) =>
        url.pathname === '/api/sites/9/inbox/threads/33' && req.method === 'GET'
          ? json({ thread: { id: 33, subject: 'Welcome' }, messages: [{ id: 99, direction: 'outbound' }] })
          : undefined,
    ]);

    try {
      const res = await runCli(tempHome!, [
        '--api', base, 'inbox', 'send', 'send.example.com',
        '--to', 'new@example.com', '--subject', 'Welcome',
        '--template', 'site-domain-send', '--yes',
      ]);
      expect(res.code).toBe(0);
      expect(capturedBody).toBe('Hello from send.example.com to new@example.com.');
    } finally {
      await stop();
    }
  });
});
