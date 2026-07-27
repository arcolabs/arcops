import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import { ApiError, apiGet, apiPost } from './api';

// KEH-270: transient network failures get a bounded retry (<=3 attempts,
// exponential backoff) so a blip stops masquerading as a service failure.
// The retry whitelist is GET-only plus an explicit `retryable` opt-in for
// idempotent writes; HTTP 4xx/5xx are server semantics and never retried.

type Route = (req: Request, url: URL) => Response;

function mockServer(route: Route): { base: string; port: number; hits: () => number; stop: () => Promise<void> } {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      hits++;
      return route(req, new URL(req.url));
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    port: server.port!,
    hits: () => hits,
    stop: () => server.stop(true),
  };
}

// TCP proxy that destroys the first `killCount` client connections (socket-
// level failure, exactly the production "fetch failed" mode), then pipes
// verbatim to the upstream mock server.
function startFlakyProxy(upstreamPort: number, killCount: number): Promise<{ base: string; close: () => Promise<void> }> {
  let seen = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    seen++;
    if (seen <= killCount) { client.destroy(); return; }
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
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

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected the call to throw');
}

const JSON_OK = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('apiCall transient-network retry (KEH-270)', () => {
  test('GET: two socket failures then success -> call succeeds, server hit once', async () => {
    const mock = mockServer(JSON_OK);
    const proxy = await startFlakyProxy(mock.port, 2);
    try {
      const data = await apiGet<{ ok: boolean }>('/api/sites', { api: proxy.base, token: 'ts_x' });
      expect(data.ok).toBe(true);
      expect(mock.hits()).toBe(1); // only the surviving attempt reached the server
    } finally {
      await proxy.close();
      await mock.stop();
    }
  });

  test('GET: persistent failure -> error names attempt count + last underlying error', async () => {
    const mock = mockServer(JSON_OK);
    const proxy = await startFlakyProxy(mock.port, Number.MAX_SAFE_INTEGER); // every connection dies
    try {
      const e = await expectApiError(apiGet('/api/sites', { api: proxy.base, token: 'ts_x' }));
      expect(e.kind).toBe('network');
      expect(e.status).toBe(0);
      expect(e.message).toContain('after 3 attempts');
      expect(e.message).toContain('failed'); // last underlying fetch error still present
      expect(mock.hits()).toBe(0); // nothing ever reached the server
    } finally {
      await proxy.close();
      await mock.stop();
    }
  });

  test('POST without retryable opt-in is NOT retried (single attempt)', async () => {
    const mock = mockServer(JSON_OK);
    const proxy = await startFlakyProxy(mock.port, Number.MAX_SAFE_INTEGER);
    try {
      const e = await expectApiError(
        apiPost('/api/sites/8/inbox/threads/1/reply', { api: proxy.base, token: 'ts_x', body: { body: 'hi' } }),
      );
      expect(e.kind).toBe('network');
      expect(e.message).not.toContain('after'); // historical single-attempt message shape
    } finally {
      await proxy.close();
      await mock.stop();
    }
  });

  test('POST with retryable opt-in (idempotent write, e.g. mark-read) IS retried and succeeds', async () => {
    const mock = mockServer(JSON_OK);
    const proxy = await startFlakyProxy(mock.port, 2);
    try {
      const data = await apiPost<{ ok: boolean }>('/api/sites/8/inbox/threads/1/mark-read', {
        api: proxy.base, token: 'ts_x', retryable: true,
      });
      expect(data.ok).toBe(true);
      expect(mock.hits()).toBe(1);
    } finally {
      await proxy.close();
      await mock.stop();
    }
  });

  test('HTTP 5xx is server semantics, not a blip: no retry, structured ApiError', async () => {
    const mock = mockServer(() =>
      new Response(JSON.stringify({ error: { code: 'boom', message: 'server exploded' } }), {
        status: 500, headers: { 'content-type': 'application/json' },
      }));
    try {
      const e = await expectApiError(apiGet('/api/sites', { api: mock.base, token: 'ts_x' }));
      expect(e.kind).toBe('api');
      expect(e.status).toBe(500);
      expect(e.code).toBe('boom');
      expect(mock.hits()).toBe(1); // exactly one request, no retry
    } finally {
      await mock.stop();
    }
  });
});
