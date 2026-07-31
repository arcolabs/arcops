import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import net from 'node:net';

// KEH-164: when a send-class request (inbox reply / send / draft send) fails
// with a NETWORK error (fetch failed - the response was lost in transit), the
// server may already have processed the send. The CLI must establish the real
// outcome before reporting:
//   - all three verbs re-issue the IDENTICAL
//     request with the SAME Idempotency-Key: a processed original replays its
//     stored result (no duplicate), an unreceived one is completed exactly
//     once; persistent 409 in_progress / repeated network failure -> "status
//     unknown", never a guessed success.
//
// A plain mock server can't make fetch throw on demand, so each test puts a
// raw TCP proxy in front of the mock HTTP server. The proxy pipes bytes
// verbatim until it sees the send request line, then destroys both sockets -
// exactly the production failure mode (request processed, response lost).

type Route = (req: Request, url: URL) => Response | Promise<Response>;

function mockServer(routes: Route[]): Promise<{ base: string; port: number; stop: () => Promise<void> }> {
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
// the client->server stream. onKill receives the accumulated request bytes
// (so tests can read headers, e.g. the Idempotency-Key) and flips mock state
// to reflect whatever the server would have done before the response was lost.
function startKillingProxy(upstreamPort: number, cfg: {
  killRequestLine: string; // e.g. 'POST /api/sites/8/inbox/threads/1/reply'
  onKill: (requestHead: string) => void;
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
      scanBuf += chunk.toString('latin1');
      if (!killed && scanBuf.includes(cfg.killRequestLine)) {
        killed = true;
        cfg.onKill(scanBuf);
        upstream.destroy();
        // Bun's fetch transport can replay a request when the socket closes
        // before any response bytes arrive. Send valid headers and truncate
        // the JSON body instead: the response is now committed, so the
        // transport cannot invisibly resend the POST, while res.text() still
        // reports the lost response to the CLI recovery layer.
        client.end(
          'HTTP/1.1 200 OK\r\n'
          + 'Content-Type: application/json\r\n'
          + 'Content-Length: 100\r\n'
          + 'Connection: close\r\n\r\n'
          + '{',
        );
        return;
      }
      upstream.write(chunk);
    });
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

async function runCli(args: string[], timeoutMs = '5000'): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ARCOPS_TIMEOUT_MS: timeoutMs },
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

describe('network-failure same-key recovery (KEH-164): reply', () => {
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
      expect(res.stderr).toContain('Retrying with the same Idempotency-Key');
      expect(res.stderr).toContain('Reply sent');
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('original did not land -> same-key retry completes it exactly once', async () => {
    const state = { outboundCreated: false, processed: 0, requests: 0 };
    const acceptedKeys = new Set<string>();
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? replyThread(state.outboundCreated) : undefined as unknown as Response,
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/threads/1/reply' && req.method === 'POST') {
          state.requests += 1;
          const key = req.headers.get('idempotency-key') ?? '';
          if (!acceptedKeys.has(key)) {
            acceptedKeys.add(key);
            state.processed += 1;
          }
          state.outboundCreated = true;
          return json({ messageId: 88 });
        }
        return undefined as unknown as Response;
      },
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
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('Reply sent');
      expect(state.processed).toBe(1);
      expect(state.requests).toBeGreaterThanOrEqual(1);
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('network error and same-key retries also fail -> status unknown + manual check', async () => {
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

  test('response timeout after acceptance recovers with the same key and preserves queued truth', async () => {
    const state = { outboundCreated: false, posts: 0 };
    const accepted = {
      messageId: 88,
      delivery: { uid: 'idl_timeout_reply', status: 'queued', acceptedAt: '2026-07-31T12:00:00Z' },
    };
    const { base, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? replyThread(state.outboundCreated) : undefined as unknown as Response,
      async (req, url) => {
        if (url.pathname !== '/api/sites/8/inbox/threads/1/reply' || req.method !== 'POST') {
          return undefined as unknown as Response;
        }
        state.posts += 1;
        state.outboundCreated = true;
        if (state.posts === 1) await new Promise((resolve) => setTimeout(resolve, 100));
        return json(accepted, 202);
      },
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'reply', 'sunor.cc', '1',
        '--body', 'hi', '--yes', '--output', 'json',
      ], '20');
      expect(res.code).toBe(0);
      expect(state.posts).toBeGreaterThanOrEqual(2);
      expect(res.stderr).toContain('timeout');
      expect(res.stderr).toContain('Reply queued');
      expect(JSON.parse(res.stdout).delivery.uid).toBe('idl_timeout_reply');
    } finally {
      await stop();
    }
  });

  test('repeated response timeouts exhaust the bounded same-key recovery before reporting unknown', async () => {
    const state = { posts: 0 };
    const { base, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/1' && req.method === 'GET'
        ? replyThread(false) : undefined as unknown as Response,
      async (req, url) => {
        if (url.pathname !== '/api/sites/8/inbox/threads/1/reply' || req.method !== 'POST') {
          return undefined as unknown as Response;
        }
        state.posts += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return json({ messageId: 88 }, 200);
      },
    ]);
    try {
      const res = await runCli([
        '--api', base, 'inbox', 'reply', 'sunor.cc', '1',
        '--body', 'hi', '--yes',
      ], '20');
      expect(res.code).not.toBe(0);
      expect(state.posts).toBe(4);
      expect(res.stderr).toContain('Send status unknown');
      expect(res.stderr).toContain('arcops inbox show sunor.cc 1');
    } finally {
      await stop();
    }
  });
});

describe('network-failure recovery (KEH-164 r3): cold send via same-key retry', () => {
  // Round 3 replaced the racy recency-window probe with an idempotent
  // same-key retry: the Idempotency-Key header is the client-unique marker,
  // and the server's reserve/replay store positively identifies (or safely
  // completes) the original send. The mock below emulates that store: the
  // first request with a key runs the side effect and records the result; a
  // repeat of the same key replays the recorded result WITHOUT re-running.
  // False positives are structurally impossible - there is no candidate
  // matching at all - so the r1/r2 collision regression tests are gone with
  // the probe they tested.

  type SendResult = { threadId: number; messageId: number };
  function idempotentSendMock() {
    const store = new Map<string, SendResult>();
    const state = { processedCount: 0, replayCount: 0, landed: false };
    const routes: Route[] = [
      SITES_ROUTE,
      // thread detail for verifyOutboundLanded after the retry succeeds
      (req, url) => url.pathname === '/api/sites/8/inbox/threads/42' && req.method === 'GET'
        ? json({
            thread: { id: 42, subject: 't', participant_emails: ['support@sunor.cc', 'a@b.com'] },
            messages: state.landed
              ? [{ id: 99, direction: 'outbound', received_at: new Date().toISOString() }]
              : [],
          })
        : undefined as unknown as Response,
      (req, url) => {
        if (url.pathname !== '/api/sites/8/inbox/send' || req.method !== 'POST') {
          return undefined as unknown as Response;
        }
        const key = req.headers.get('idempotency-key') ?? '';
        const existing = store.get(key);
        if (existing) {
          state.replayCount++;
          return json(existing);
        }
        state.processedCount++;
        state.landed = true;
        const result = { threadId: 42, messageId: 99 };
        store.set(key, result);
        return json(result);
      },
    ];
    return { store, state, routes };
  }

  function keyFromHead(head: string): string {
    const m = head.toLowerCase().match(/idempotency-key:\s*(\S+)/);
    if (!m) throw new Error('no idempotency-key header in killed request');
    return m[1];
  }

  test('original processed (response lost) -> same-key retry REPLAYS, no second side effect, exit 0', async () => {
    const { store, state, routes } = idempotentSendMock();
    const { port, stop } = await mockServer(routes);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/send',
      // The server processed the original before the response was lost:
      // record the result under the request's idempotency key (what the
      // reserve/commit store would hold).
      onKill: (head) => {
        store.set(keyFromHead(head), { threadId: 42, messageId: 99 });
        state.landed = true;
      },
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes',
      ]);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('same-key retry confirms exactly one outbound on thread #42 as message #99');
      expect(res.stderr).toContain('Email sent');
      // The retry MUST be a replay: no second side effect. (processedCount is
      // 0 or 1 depending on whether the killed original reached the mock
      // handler before the socket died; the retry itself never re-runs.)
      // The runtime may repeat a replay read on a stale keep-alive socket.
      // Replay count is not the side-effect count; one stored result and no
      // additional processing are the exactly-once invariants.
      expect(state.replayCount).toBeGreaterThanOrEqual(1);
      expect(state.processedCount).toBeLessThanOrEqual(1);
      expect(store.size).toBe(1);
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('original never arrived -> same-key retry completes the send exactly once, exit 0 (json out)', async () => {
    const { store, state, routes } = idempotentSendMock();
    const { port, stop } = await mockServer(routes);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/send',
      onKill: () => {}, // the request died before the server processed anything
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes', '--output', 'json',
      ]);
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('same-key retry confirms exactly one outbound on thread #42 as message #99');
      expect(res.stdout).toContain('"threadId": 42');
      expect(res.stdout).toContain('"messageId": 99');
      // Exactly one side effect across both attempts (either the killed
      // original squeaked through or the retry ran - never both).
      expect(state.processedCount).toBe(1);
      expect(store.size).toBe(1);
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('retry keeps hitting 409 idempotency_in_progress -> budget exhausts, status unknown, no guessed success', async () => {
    const { port, stop } = await mockServer([
      SITES_ROUTE,
      (req, url) => {
        if (url.pathname === '/api/sites/8/inbox/send' && req.method === 'POST') {
          return json(
            { error: { code: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is still in flight.', detail: { retry_after_sec: 1 } } },
            409,
          );
        }
        return undefined as unknown as Response;
      },
    ]);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/send',
      onKill: () => {},
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes',
      ]);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain('Send status unknown');
      expect(res.stderr).toContain('in flight');
      expect(res.stderr).toContain('arcops inbox ls sunor.cc');
      expect(res.stderr).not.toContain('Email sent');
    } finally {
      await proxy.close();
      await stop();
    }
  });

  test('retry also network-fails -> status unknown + safe-to-rerun guidance, no guessed success', async () => {
    const { routes } = idempotentSendMock();
    const { port, stop } = await mockServer(routes);
    const proxy = await startKillingProxy(port, {
      killRequestLine: 'POST /api/sites/8/inbox/send',
      onKill: () => {},
      killSubsequent: true, // every retry connection dies too
    });
    try {
      const res = await runCli([
        '--api', proxy.base, 'inbox', 'send', 'sunor.cc',
        '--to', 'a@b.com', '--subject', 't', '--body', 'hi', '--yes',
      ]);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain('Send status unknown');
      expect(res.stderr).toContain('Re-running the same command is safe');
      expect(res.stderr).toContain('arcops inbox ls sunor.cc');
      expect(res.stderr).not.toContain('Email sent');
    } finally {
      await proxy.close();
      await stop();
    }
  });
});

describe('network-failure same-key recovery (KEH-164): draft send', () => {
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
      expect(res.stderr).toContain('Retrying with the same Idempotency-Key');
      expect(res.stdout).toContain('"messageId": 676');
    } finally {
      await proxy.close();
      await stop();
    }
  });
});
