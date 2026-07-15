import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Integration test for verify-after-send (contract item 3): after a send-class
// action returns success, the CLI re-fetches the thread and confirms an
// outbound message landed. We run the real CLI (via `bun src/main.ts`) against
// an in-process mock server so no real email is sent. Two cases:
//   - server claims success but the thread has no outbound -> non-zero exit
//   - server claims success and the outbound is present -> exit 0

type Route = (req: Request, url: URL) => Response;

function mockServer(routes: Route[]): Promise<{ base: string; stop: () => Promise<void> }> {
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
  // Bun.serve returns synchronously but the ephemeral socket needs a tick to
  // accept; probe until /api/sites responds so the spawned CLI never races.
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/sites'); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    return { base, stop: () => server.stop(true) };
  })();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, 'main.ts');

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

describe('verify-after-send (contract item 3)', () => {
  test('send claims success but outbound missing -> non-zero exit, clear error', async () => {
    const sendCalled: string[] = [];
    const { base, stop } = await mockServer([
      (req, url) => {
        if (url.pathname === '/api/sites' && req.method === 'GET') {
          return json({ sites: [{ id: 8, domain: 'sunor.cc' }] });
        }
        return undefined as unknown as Response;
      },
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/send' && req.method === 'POST') {
          sendCalled.push('send');
          // Server claims success and reports a messageId...
          return json({ threadId: 1, messageId: 99 });
        }
        return undefined as unknown as Response;
      },
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET') {
          // ...but the thread has NO outbound message 99 -> verify must fail.
          return json({ thread: { id: 1, subject: 'x' }, messages: [] });
        }
        return undefined as unknown as Response;
      },
    ]);

    try {
      const res = await runCli([
        '--api', base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes',
      ]);
      expect(sendCalled).toEqual(['send']); // send actually fired
      expect(res.code).not.toBe(0); // non-zero: the failure mode "exit 0 but nothing sent" is killed
      expect(res.stderr).toContain('no outbound message landed on thread 1');
    } finally {
      await stop();
    }
  });

  test('send succeeds and outbound present -> exit 0', async () => {
    const { base, stop } = await mockServer([
      (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
        ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] }) : undefined as unknown as Response,
      (req, url) => url.pathname === '/api/sites/8/inbox/send' && req.method === 'POST'
        ? json({ threadId: 1, messageId: 99 }) : undefined as unknown as Response,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? json({ thread: { id: 1 }, messages: [{ id: 99, direction: 'outbound' }] })
        : undefined as unknown as Response,
    ]);

    try {
      const res = await runCli([
        '--api', base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes', '--output', 'json',
      ]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('"messageId"');
    } finally {
      await stop();
    }
  });
});
