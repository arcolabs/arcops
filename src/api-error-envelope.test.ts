import { describe, expect, test } from 'bun:test';
import { ApiError, apiGet } from './api';

// KEH-177: the error envelope keeps one fact per field. The human-readable
// message must not re-prefix the HTTP status or the server error code (both
// already have their own envelope fields), and the request-id lives in
// detail.request_id, not in the message.

type Route = (req: Request, url: URL) => Response;

async function mockServer(route: Route): Promise<{ base: string; stop: () => Promise<void> }> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return route(req, new URL(req.url));
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected apiGet to throw');
}

describe('apiCall error envelope (KEH-177)', () => {
  test('structured 401: clean message, code/status/request-id in their own fields', async () => {
    const { base, stop } = await mockServer(() =>
      new Response(JSON.stringify({ error: { code: 'invalid_token', message: 'Invalid or revoked API key.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-abc-123' },
      }));
    try {
      const e = await expectApiError(apiGet('/api/sites', { api: base, token: 'ts_bogus' }));
      expect(e.status).toBe(401);
      expect(e.code).toBe('invalid_token');
      expect(e.message).toBe('Invalid or revoked API key.');
      expect(e.message).not.toContain('HTTP');
      expect(e.message).not.toContain('invalid_token');
      expect(e.message).not.toContain('req-abc-123');
      expect(e.detail).toEqual({ request_id: 'req-abc-123' });
    } finally {
      await stop();
    }
  });

  test('structured 502 with detail.upstream: upstream folded into message, prefixes stripped, server detail preserved + request_id merged', async () => {
    const { base, stop } = await mockServer(() =>
      new Response(JSON.stringify({
        error: {
          code: 'cf_send_failed',
          message: 'Cloudflare rejected the outbound email.',
          detail: { upstream: 'email.sending.error.email.invalid' },
        },
      }), {
        status: 502,
        headers: { 'content-type': 'application/json', 'cf-ray': 'ray-xyz-789' },
      }));
    try {
      const e = await expectApiError(apiGet('/api/send', { api: base, token: 'ts_x' }));
      expect(e.status).toBe(502);
      expect(e.code).toBe('cf_send_failed');
      expect(e.message).toBe('Cloudflare rejected the outbound email. (upstream: email.sending.error.email.invalid)');
      expect(e.message).not.toMatch(/^HTTP \d+:/);
      expect(e.message).not.toMatch(/^cf_send_failed:/);
      expect(e.detail).toEqual({ upstream: 'email.sending.error.email.invalid', request_id: 'ray-xyz-789' });
    } finally {
      await stop();
    }
  });

  test('non-JSON 500 body: stripped snippet, no HTTP prefix, request-id in detail', async () => {
    const { base, stop } = await mockServer(() =>
      new Response('<html><body><h1>Internal Server Error</h1></body></html>', {
        status: 500,
        headers: { 'content-type': 'text/html', 'x-request-id': 'req-html-1' },
      }));
    try {
      const e = await expectApiError(apiGet('/api/sites', { api: base, token: 'ts_x' }));
      expect(e.status).toBe(500);
      expect(e.message).toBe('Internal Server Error');
      expect(e.message).not.toContain('HTTP');
      expect(e.message).not.toContain('req-html-1');
      expect(e.detail).toEqual({ request_id: 'req-html-1' });
    } finally {
      await stop();
    }
  });

  test('structured error without message falls back to code; no request-id header -> no detail', async () => {
    const { base, stop } = await mockServer(() =>
      new Response(JSON.stringify({ error: { code: 'site_not_found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }));
    try {
      const e = await expectApiError(apiGet('/api/sites/999', { api: base, token: 'ts_x' }));
      expect(e.status).toBe(404);
      expect(e.code).toBe('site_not_found');
      expect(e.message).toBe('site_not_found');
      expect(e.detail).toBeUndefined();
    } finally {
      await stop();
    }
  });
});
