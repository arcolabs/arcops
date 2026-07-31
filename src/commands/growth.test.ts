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

describe('growth command surface', () => {
  test('all P0 verbs are registered in both catalogs', () => {
    const expected = [
      'growth:identity:upsert',
      'growth:lifecycle:show',
      'growth:lifecycle:set',
      'growth:outcomes',
      'growth:experiment:ls',
      'growth:experiment:show',
      'growth:experiment:create',
      'growth:experiment:update',
      'growth:experiment:readback',
      'growth:release:ls',
      'growth:release:create',
      'growth:signal:ls',
      'growth:signal:refresh',
      'growth:signal:ack',
      'growth:signal:resolve',
      'growth:doctor',
    ];
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

  test('lifecycle set sends the config as the top-level API body', async () => {
    const seen: SeenRequest[] = [];
    const config = {
      schemaVersion: 1,
      scope: 'account',
      activation: { event: 'workspace_created' },
      retention: { event: 'project_exported', minCount: 2, windowDays: 14 },
      atRisk: { inactivityDays: 14 },
      conversionWindowDays: 30,
      acquisitionSignal: {
        minimumVisitors: 100,
        maximumActivationRate: 0.2,
        windowDays: 14,
      },
    };
    const { base, stop } = await mockServer((request) => {
      seen.push(request);
      return json({ lifecycle: { version: 1, config } });
    });
    try {
      const result = await runCli([
        'growth', 'lifecycle', 'set', 'acme.com',
        '--config', JSON.stringify(config),
        '--idempotency-key', 'growth-test-lifecycle',
      ], base);
      expect(result.code, result.stderr).toBe(0);
      expect(seen[0]).toEqual({
        method: 'PUT',
        path: '/api/sites/42/growth/lifecycle',
        body: config,
        idempotencyKey: 'growth-test-lifecycle',
      });
    } finally {
      await stop();
    }
  });

  test('readback adapts from/to into the frozen measurement fields', async () => {
    const seen: SeenRequest[] = [];
    const { base, stop } = await mockServer((request) => {
      seen.push(request);
      return json({ readback: { uid: 'gr_123', decision: 'keep' } }, 201);
    });
    try {
      const result = await runCli([
        'growth', 'experiment', 'readback', 'acme.com', 'gx_123',
        '--from', '2026-07-01T00:00:00Z',
        '--to', '2026-07-15T00:00:00Z',
        '--decision', 'keep',
        '--notes', 'Activation improved',
        '--idempotency-key', 'growth-test-readback',
      ], base);
      expect(result.code, result.stderr).toBe(0);
      expect(seen[0]).toEqual({
        method: 'POST',
        path: '/api/sites/42/growth/experiments/gx_123/readbacks',
        body: {
          measured_from: '2026-07-01T00:00:00.000Z',
          measured_to: '2026-07-15T00:00:00.000Z',
          decision: 'keep',
          notes: 'Activation improved',
        },
        idempotencyKey: 'growth-test-readback',
      });
    } finally {
      await stop();
    }
  });

  test('outcomes rejects invalid convenience windows before calling the outcome API', async () => {
    const seen: SeenRequest[] = [];
    const { base, stop } = await mockServer((request) => {
      seen.push(request);
      return json({ totals: {} });
    });
    try {
      const invalidDays = await runCli([
        'growth', 'outcomes', 'acme.com',
        '--days', '0',
      ], base);
      const tooLarge = await runCli([
        'growth', 'outcomes', 'acme.com',
        '--days', '367',
      ], base);
      const future = await runCli([
        'growth', 'outcomes', 'acme.com',
        '--from', '2099-01-01T00:00:00Z',
        '--to', '2099-01-02T00:00:00Z',
      ], base);

      expect(invalidDays.code).toBe(1);
      expect(invalidDays.stderr).toContain('--days must be a number greater than 0');
      expect(tooLarge.code).toBe(1);
      expect(tooLarge.stderr).toContain('no greater than 366');
      expect(future.code).toBe(1);
      expect(future.stderr).toContain('--to cannot be in the future');
      expect(seen).toEqual([]);
    } finally {
      await stop();
    }
  });

  test('signal actions send explicit state instead of CLI shorthand fields', async () => {
    const seen: SeenRequest[] = [];
    const { base, stop } = await mockServer((request) => {
      seen.push(request);
      return json({ signal: { uid: 'gs_123', status: request.body && (request.body as any).status } });
    });
    try {
      const acknowledged = await runCli([
        'growth', 'signal', 'ack', 'acme.com', 'gs_123',
        '--idempotency-key', 'growth-test-ack',
      ], base);
      const resolved = await runCli([
        'growth', 'signal', 'resolve', 'acme.com', 'gs_123',
        '--note', 'Condition cleared',
        '--idempotency-key', 'growth-test-resolve',
      ], base);
      expect(acknowledged.code, acknowledged.stderr).toBe(0);
      expect(resolved.code, resolved.stderr).toBe(0);
      expect(seen).toEqual([
        {
          method: 'PATCH',
          path: '/api/sites/42/growth/signals/gs_123',
          body: { status: 'acknowledged' },
          idempotencyKey: 'growth-test-ack',
        },
        {
          method: 'PATCH',
          path: '/api/sites/42/growth/signals/gs_123',
          body: { status: 'resolved', resolution_note: 'Condition cleared' },
          idempotencyKey: 'growth-test-resolve',
        },
      ]);
    } finally {
      await stop();
    }
  });
});
