// Integration tests for the api.ts Idempotency-Key plumbing (C1/KEH-116).
//
// Exercises apiCall directly against an in-process mock server (no real CLI
// spawn, no real email): (1) the `idempotencyKey` opt becomes an
// `Idempotency-Key` request header, and (2) a server 409 with the
// idempotency_conflict envelope is surfaced as an ApiError carrying code +
// status for agent consumption.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { apiCall, ApiError } from './api';

type Captured = { headers: Record<string, string>; body: unknown };

function mockServer(handler: (captured: Captured) => Response): Promise<{ base: string; stop: () => void; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text().catch(() => undefined);
      const c: Captured = {
        headers: Object.fromEntries(req.headers.entries()),
        body: body ? safeJson(body) : body,
      };
      captured.push(c);
      return handler(c);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return Promise.resolve({ base, stop: () => server.stop(true), captured });
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('apiCall idempotency', () => {
  let server: { base: string; stop: () => void; captured: Captured[] };
  beforeAll(async () => {
    server = await mockServer(() => json({ ok: true }));
  });
  afterAll(() => server.stop());

  test('sends the Idempotency-Key header when idempotencyKey is set', async () => {
    await apiCall('/api/sites/1/inbox/send', {
      api: server.base, token: 'ts_x', method: 'POST',
      body: { to: ['a@b.com'], subject: 's', body: 'b' },
      idempotencyKey: 'arcops-send-1-abc',
    });
    const last = server.captured.at(-1)!;
    expect(last.headers['idempotency-key']).toBe('arcops-send-1-abc');
  });

  test('omits the header when idempotencyKey is unset (read verbs)', async () => {
    await apiCall('/api/sites/1/inbox/threads/2', { api: server.base, token: 'ts_x' });
    const last = server.captured.at(-1)!;
    expect(last.headers['idempotency-key']).toBeUndefined();
  });
});

describe('apiCall idempotency_conflict passthrough', () => {
  let server: { base: string; stop: () => void };
  beforeAll(async () => {
    server = await mockServer(() => json({
      error: { code: 'idempotency_conflict', message: 'Idempotency-Key was reused with a different request body.', detail: { key: 'k1' } },
    }, 409));
  });
  afterAll(() => server.stop());

  test('surfaces the 409 as an ApiError with code + status preserved', async () => {
    try {
      await apiCall('/api/sites/1/inbox/send', {
        api: server.base, token: 'ts_x', method: 'POST',
        body: { to: ['a@b.com'], subject: 's', body: 'b' },
        idempotencyKey: 'k1',
      });
      throw new Error('expected apiCall to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(409);
      expect(err.code).toBe('idempotency_conflict');
      expect(err.detail).toEqual({ key: 'k1' });
    }
  });
});
