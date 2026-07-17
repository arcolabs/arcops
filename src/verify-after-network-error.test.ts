import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import net from 'node:net';

// KEH-164: when a send-class request (inbox reply / send / draft send) fails
// with a NETWORK error (fetch failed - the response was lost in transit), the
// server may already have processed the send. The CLI must run a
// verify-after-send probe before reporting:
//   - probe finds a fresh outbound  -> report success, exit 0
//   - probe finds nothing           -> failure + "safe to retry" hint
//   - probe itself fails (network)  -> "status unknown" + manual check, exit 1
//
// A plain mock server can't make fetch throw on demand, so each test puts a
// raw TCP proxy in front of the mock HTTP server. The proxy pipes bytes
// verbatim until it sees the send request line, then destroys both sockets -
// exactly the production failure mode (request processed, response lost).

type Route = (req: Request, url: URL) => Response;

function mockServer(routes: Route[]): Promise<{ base: string; port: number; stop: () => Promise<void> }> {
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
  const port = server.port!; // bound synchronously with port: 0
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/sites'); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    return { base, port, stop: () => server.stop(true) };
  })();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// TCP proxy that kills the connection when the kill request line appears in
// the client->server stream. onKill flips mock state to reflect whatever the
// server would have done before the response was lost.
function startKillingProxy(upstreamPort: number, cfg: {
  killRequestLine: string; // e.g. 'POST /api/sites/8/inbox/threads/1/reply'
  onKill: () => void;
  killSubsequent?: boolean; // also destroy every later connection (verify fails too)
}): Promise<{ base: string; close: () => Promise<void> }> {
  let killed = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    if (killed && cfg.killSubsequent) { client.destroy(); return; }
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    let scanBuf = '';
    client.on('data', (chunk) => {
      if (killed) return;
      scanBuf += chunk.toString('latin1');
      if (scanBuf.includes(cfg.killRequestLine)) {
        killed = true;
        cfg.onKill();
        client.destroy();
        upstream.destroy();
      }
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolvePromise({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => {
          for (const s of sockets) s.destroy();
          server.close(() => res());
        }),
      });
    });
  });
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

const SITES_ROUTE = (req: Request, url: URL) =>
  url.pathname === '/api/sites' && req.method === 'GET'
    ? json({ sites: [{ id: 8, domain: 'sunor.cc' }] })
    : undefined as unknown as Response;

describe('network-failure verify-after-send (KEH-164): reply', () => {
  const replyThread = (outboundCreated: boolean) => json({
    thread: { id: 1, subject: 'hello', participant_emails: ['cust@x.com', 'support@sunor.cc'] },
    messages: [
      { id: 50, direction: 'inbound', from_email: 'cust@x.com', received_at: '2026-07-17T15:00:00Z' },
      ...(outboundCreated
        ? [{ id: 88, direction: 'outbound', received_at: new Date().toISOString() }]
        : []),
    ],
  });

  test('network error but reply landed -> report success, exit 0', async () => {
    const state = { outboundCreated: false };
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? replyThread(state.outboundCreated) : undefined as unknown as Response,
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/threads/1/reply' && req.method === 'POST') {
          state.outboundCreated = true; // server processed it; response may still be lost
          return json({ messageId: 88 });
        }
        return undefined as unknown as Response;
      },
    ]);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/threads/1/reply',
      onKill: () => { state.outboundCreated = true; },
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'reply', 'sunor.cc', '1',
        '--body', 'hi', '--yes',
      ]);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('verify confirms it landed as message #88');
      expect(res.stderr).toContain('Reply sent');
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('network error and reply NOT landed -> failure + safe-to-retry hint', async () => {
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? replyThread(false) : undefined as unknown as Response,
      // reply POST route intentionally absent: the request dies in the proxy,
      // the server never processed anything.
    ]);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/threads/1/reply',
      onKill: () => {},
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'reply', 'sunor.cc', '1',
        '--body', 'hi', '--yes',
      ]);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain('NOT sent');
      expect(res.stderr).toContain('Safe to retry');
      expect(res.stderr).toContain('idempotency key will replay');
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('network error and verify query also fails -> status unknown + manual check', async () => {
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? replyThread(false) : undefined as unknown as Response,
    ]);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/threads/1/reply',
      onKill: () => {},
      killSubsequent: true, // verify GET dies too
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'reply', 'sunor.cc', '1',
        '--body', 'hi', '--yes',
      ]);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain('Send status unknown');
      expect(res.stderr).toContain('arcops inbox show sunor.cc 1');
    } finally {
      await proxy.close();
      await stop();
    }
  });
});

describe('network-failure verify-after-send (KEH-164): cold send', () => {
  test('network error but the new thread + outbound landed -> report success, exit 0', async () => {
    const state = { created: false };
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      // threads list (probe step 1): the just-created thread sits at the top
      (req, url) => url.pathname === '/api/sites/8/inbox/threads' && req.method === 'GET'
        ? json({
            threads: state.created
              ? [{ id: 42, subject: 't', last_message_at: new Date().toISOString() }]
              : [],
            counts: {},
            nextCursor: null,
          })
        : undefined as unknown as Response,
      // thread detail (probe step 2)
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/42' && req.method === 'GET'
        ? json({
            thread: { id: 42, subject: 't', participant_emails: ['a@b.com'] },
            messages: [{ id: 99, direction: 'outbound', received_at: new Date().toISOString() }],
          })
        : undefined as unknown as Response,
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/send' && req.method === 'POST') {
          state.created = true;
          return json({ threadId: 42, messageId: 99 });
        }
        return undefined as unknown as Response;
      },
    ]);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/send',
      onKill: () => { state.created = true; },
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes',
      ]);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('verify confirms it landed on thread #42 as message #99');
      expect(res.stderr).toContain('Email sent');
    } finally {
      await proxy.close();
      await stop();
    }
  });
});

describe('network-failure verify-after-send (KEH-164): draft send', () => {
  test('network error but the promoted draft landed -> report success, exit 0 (json out)', async () => {
    const state = { sent: false };
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? json({
            thread: { id: 1, subject: 'hello' },
            messages: state.sent
              ? [{ id: 676, direction: 'outbound', received_at: new Date().toISOString() }]
              : [],
          })
        : undefined as unknown as Response,
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/threads/1/drafts/45/send' && req.method === 'POST') {
          state.sent = true;
          return json({ messageId: 676 });
        }
        return undefined as unknown as Response;
      },
    ]);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/threads/1/drafts/45/send',
      onKill: () => { state.sent = true; },
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'draft', 'send', 'sunor.cc', '1', '45',
        '--yes', '--output', 'json',
      ]);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('verify confirms it landed as message #676');
      expect(res.stdout).toContain('"messageId": 676');
    } finally {
      await proxy.close();
      await stop();
    }
  });
});
