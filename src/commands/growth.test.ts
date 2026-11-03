import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { COMMANDS } from './index';
import { VERBS } from '../verbs/registry';

type SeenRequest = {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
};

const MAIN = resolve(import.meta.dir, '..', 'main.ts');
const SITES = { sites: [{ id: 42, domain: 'acme.com', name: 'Acme' }] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mockServer(
  handle: (request: SeenRequest) => Response | undefined,
): Promise<{ base: string; stop: () => Promise<void> }> {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES);
      const seen: SeenRequest = {
        method: req.method,
        path: url.pathname + url.search,
        body: req.method === 'GET' ? undefined : await req.json(),
        idempotencyKey: req.headers.get('idempotency-key'),
      };
      return handle(seen) ?? json({ error: { code: 'not_found', message: 'not found' } }, 404);
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

async function runCli(
  args: string[],
  base: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([
    process.execPath,
    MAIN,
    ...args,
    '--api',
    base,
    '--token',
    'ts_test',
    '--output',
    'json',
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('growth identity command', () => {
  test('only the identity verb remains registered in both catalogs', () => {
    // arcops-server #435 removed every other growth route; see growth.ts.
    const expected = ['growth:identity:upsert'];
    expect(VERBS.filter((verb) => verb.id.startsWith('growth:')).map((verb) => verb.id))
      .toEqual(expected);
    expect(COMMANDS.filter((command) => command.path[0] === 'growth')
      .map((command) => command.path.join(':')))
      .toEqual(expected);
  });

  test('identity upsert sends nested identity and caller idempotency key', async () => {
    const seen: SeenRequest[] = [];
    const { base, stop } = await mockServer((request) => {
      seen.push(request);
      return json({ identity: { user: { id: 'usr_123' }, account: { id: 'acct_456' } } });
    });
    try {
      const result = await runCli([
        'growth', 'identity', 'upsert', 'acme.com',
        '--user-id', 'usr_123',
        '--email', 'founder@example.com',
        '--user-traits', '{"role":"owner"}',
        '--account-id', 'acct_456',
        '--account-name', 'Acme',
        '--plan', 'pro',
        '--role', 'owner',
        '--visitor-id', 'vis_123',
        '--stripe-customer-id', 'cus_123',
        '--idempotency-key', 'growth-test-identity',
      ], base);
      expect(result.code, result.stderr).toBe(0);
      expect(seen).toEqual([{
        method: 'POST',
        path: '/api/sites/42/growth/identity',
        body: {
          user: {
            id: 'usr_123',
            email: 'founder@example.com',
            traits: { role: 'owner' },
          },
          account: {
            id: 'acct_456',
            name: 'Acme',
            plan: 'pro',
            role: 'owner',
          },
          visitor_id: 'vis_123',
          stripe_customer_id: 'cus_123',
        },
        idempotencyKey: 'growth-test-identity',
      }]);
      expect(JSON.parse(result.stdout)).toEqual({
        identity: { user: { id: 'usr_123' }, account: { id: 'acct_456' } },
      });
    } finally {
      await stop();
    }
  });
});
