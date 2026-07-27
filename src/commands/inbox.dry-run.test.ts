import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { renderMarkdownEmail, hasMarkdown } from '../lib/markdown-email';

// KEH-278 C: dry-run preview for inbox send / reply. Asserts the four
// acceptances:
//   C1 - does not send; outputs the would-be-delivered content (HTML + text)
//   C2 - bodyHtml is produced by the EXACT same render path as a real send
//        (compare against renderMarkdownEmail directly - if dry-run used a
//        second renderer this fails)
//   C3 - no write ops, no idempotency key consumed, no draft created
//   C4 - --output json stdout is parseable data

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
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

async function runCli(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const MD_BODY = '# Quote\n\nHi **bold** and `code`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
const PLAIN_BODY = 'Just a plain text email with no markdown at all.';

describe('inbox dry-run (KEH-278 C)', () => {
  test('send --dry-run does not send and outputs the same HTML the real send would (C1+C2+C4)', async () => {
    const postHits: string[] = [];
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined,
      (req, url) => {
        // ANY POST is a write - dry-run must do none of them.
        if (req.method === 'POST') { postHits.push(url.pathname); return json({}); }
        return undefined;
      },
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--cc', 'c@d.com', '--subject', 'Q',
        '--body', MD_BODY, '--dry-run', '--output', 'json',
      ]);
      expect(res.code).toBe(0);
      expect(postHits).toEqual([]); // C3: no writes at all (no send, no draft)
      const j = JSON.parse(res.stdout); // C4: parseable
      expect(j.dryRun).toBe(true);
      expect(j.action).toBe('send');
      expect(j.to).toEqual(['a@b.com']);
      expect(j.cc).toEqual(['c@d.com']);
      expect(j.from).toBe('support@sunor.cc');
      expect(j.subject).toBe('Q');
      expect(j.bodyText).toBe(MD_BODY);
      // C2: the dry-run HTML is byte-identical to the real render path.
      expect(j.bodyHtml).toBe(renderMarkdownEmail(MD_BODY));
      expect(j.bodyHtml).toContain('<h1');
      expect(j.bodyHtml).toContain('<strong>bold</strong>');
      expect(j.bodyHtml).toContain('<table');
    } finally {
      await stop();
    }
  });

  test('send --dry-run on a plain-text body sends no bodyHtml (matches text-only real send)', async () => {
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined,
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 'Q', '--body', PLAIN_BODY, '--dry-run', '--output', 'json',
      ]);
      expect(res.code).toBe(0);
      const j = JSON.parse(res.stdout);
      expect(j.bodyText).toBe(PLAIN_BODY);
      expect(j.bodyHtml).toBeUndefined(); // no markdown -> text-only, same as real send
      expect(hasMarkdown(PLAIN_BODY)).toBe(false);
    } finally {
      await stop();
    }
  });

  test('reply --dry-run renders the post-quote body via the same path and writes nothing (C2+C3)', async () => {
    const postHits: string[] = [];
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 7, domain: 'sunor.cc' }] }) : undefined,
      (req, url) => {
        if (url.pathname === '/api/sites/7/inbox/threads/11' && req.method === 'GET') {
          // The thread GET is a READ - dry-run may fetch it to resolve
          // recipients/subject. That is not a write.
          return json({
            thread: { subject: 'Refund', participant_emails: ['cust@x.com'], status: 'open' },
            messages: [{ id: 1, from_email: 'cust@x.com', received_at: '2026-07-16T10:00:00Z', direction: 'inbound' }],
          });
        }
        return undefined;
      },
      (req, url) => {
        if (req.method === 'POST') { postHits.push(url.pathname); return json({}); }
        return undefined;
      },
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'reply', 'sunor.cc', '11',
        '--body', MD_BODY, '--dry-run', '--output', 'json',
      ]);
      expect(res.code).toBe(0);
      expect(postHits).toEqual([]); // no reply POST, no draft
      const j = JSON.parse(res.stdout);
      expect(j.action).toBe('reply');
      expect(j.to).toEqual(['cust@x.com']);
      expect(j.subject).toBe('Refund');
      expect(j.bodyHtml).toBe(renderMarkdownEmail(MD_BODY)); // same render path
    } finally {
      await stop();
    }
  });

  test('send --dry-run text mode prints rendered HTML + plain text on stdout', async () => {
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined,
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 'Q', '--body', MD_BODY, '--dry-run', '--output', 'text',
      ]);
      expect(res.code).toBe(0);
      // The rendered HTML and the plain-text body both appear on stdout.
      expect(res.stdout).toContain('Rendered HTML');
      expect(res.stdout).toContain('<table');
      expect(res.stdout).toContain('Plain-text body');
      expect(res.stdout).toContain(MD_BODY);
      // Status line (noise) is on stderr, not stdout.
      expect(res.stderr).toContain('Dry run: nothing sent');
    } finally {
      await stop();
    }
  });

  test('send --dry-run does not require --yes and skips the typed-confirm gate', async () => {
    // dry-run is safe by construction - it must not prompt even without --yes
    // (stdin here is a pipe, not a TTY, so confirmByTyping would refuse).
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined,
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 'Q', '--body', MD_BODY, '--dry-run', '--output', 'json',
        // note: no --yes
      ]);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout).dryRun).toBe(true);
    } finally {
      await stop();
    }
  });
});
