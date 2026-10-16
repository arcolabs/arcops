import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { COMMANDS } from './index';
import { VERBS } from '../verbs/registry';
import type { HttpMapping } from '../verbs/registry';

type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

function mockServer(routes: Route[]): { base: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      for (const route of routes) {
        const response = await route(req, url);
        if (response) return response;
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

async function runCli(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const home = mkdtempSync(resolve(tmpdir(), 'arcops-events-webhooks-'));
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, HOME: home, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const HTTP_CONTRACTS: Record<string, HttpMapping> = {
  'webhook:ls': { method: 'GET', path: '/api/webhook-endpoints' },
  'webhook:create': { method: 'POST', path: '/api/webhook-endpoints', body: ['name', 'url', 'enabled_events', 'site_filter'] },
  'webhook:update': { method: 'PATCH', path: '/api/webhook-endpoints/:endpoint', body: ['name', 'url', 'enabled_events', 'site_filter', 'status', 'rotate_secret'] },
  'webhook:rm': { method: 'DELETE', path: '/api/webhook-endpoints/:endpoint' },
  'webhook:test': { method: 'POST', path: '/api/webhook-endpoints/:endpoint/test' },
  'webhook:deliveries': { method: 'GET', path: '/api/webhook-endpoints/:endpoint/deliveries', query: ['status', 'limit', 'cursor'] },
  'events:ls': { method: 'GET', path: '/api/events', query: ['type', 'site', 'since', 'limit', 'cursor'] },
  'events:show': { method: 'GET', path: '/api/events/:event' },
  'events:replay': { method: 'POST', path: '/api/event-deliveries/:delivery_id/replay' },
};

test('all migrated event and webhook verbs preserve their server contracts', () => {
  for (const [id, http] of Object.entries(HTTP_CONTRACTS)) {
    expect(VERBS.find((verb) => verb.id === id)?.http, id).toEqual(http);
    expect(COMMANDS.find((command) => command.path.join(':') === id), id).toBeDefined();
  }
  expect(VERBS.find((verb) => verb.id === 'webhook:create')?.args.find((arg) => arg.name === 'event'))
    .toMatchObject({ type: 'string[]', repeatable: true, required: true });
});

describe('migrated event and webhook handlers', () => {
  test('webhook create preserves repeated events and site filters', async () => {
    const requests: unknown[] = [];
    const endpoint = {
      id: 'we_test',
      transport: 'generic_webhook',
      name: 'agent',
      enabled_events: ['inbox.*', 'site.*'],
      site_filter: [1, 2],
      status: 'active',
      consecutive_failures: 0,
      url_host: 'agent.example.com',
      created_at: '2026-08-21T00:00:00Z',
      updated_at: '2026-08-21T00:00:00Z',
    };
    const { base, stop } = mockServer([
      async (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/webhook-endpoints') {
          requests.push(await req.json());
          return json({ endpoint, secret: 'whsec_test' });
        }
        return undefined;
      },
    ]);
    try {
      const result = await runCli([
        'webhook', 'create',
        '--name', 'agent',
        '--url', 'https://agent.example.com/arcops',
        '--event', 'inbox.*',
        '--event', 'site.*',
        '--site-filter', '1,2',
        '--output', 'json',
        '--api', base,
        '--token', 'ts_test',
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ endpoint, secret: 'whsec_test' });
      expect(result.stderr).toBe('');
      expect(requests).toEqual([{
        name: 'agent',
        url: 'https://agent.example.com/arcops',
        enabled_events: ['inbox.*', 'site.*'],
        site_filter: [1, 2],
      }]);
    } finally {
      await stop();
    }
  });

  test('webhook update maps bool and repeated options into one PATCH body', async () => {
    const requests: unknown[] = [];
    const endpoint = {
      id: 'we_test',
      transport: 'generic_webhook',
      name: 'agent',
      enabled_events: ['inbox.*', 'site.*'],
      site_filter: null,
      status: 'active',
      consecutive_failures: 0,
      url_host: 'agent.example.com',
      created_at: '2026-08-21T00:00:00Z',
      updated_at: '2026-08-21T00:00:00Z',
    };
    const { base, stop } = mockServer([
      async (req, url) => {
        if (req.method === 'PATCH' && url.pathname === '/api/webhook-endpoints/we_test') {
          requests.push(await req.json());
          return json({ endpoint, secret: 'whsec_rotated' });
        }
        return undefined;
      },
    ]);
    try {
      const result = await runCli([
        'webhook', 'update', 'we_test',
        '--event', 'inbox.*',
        '--event', 'site.*',
        '--site-filter', 'all',
        '--status', 'active',
        '--rotate-secret',
        '--output', 'json',
        '--api', base,
        '--token', 'ts_test',
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ endpoint, secret: 'whsec_rotated' });
      expect(requests).toEqual([{
        enabled_events: ['inbox.*', 'site.*'],
        site_filter: null,
        status: 'active',
        rotate_secret: true,
      }]);
    } finally {
      await stop();
    }
  });

  test('events ls forwards all filters and returns pure JSON', async () => {
    const queries: string[] = [];
    const payload = { events: [], next_cursor: 'next_1' };
    const { base, stop } = mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/events') {
          queries.push(url.searchParams.toString());
          return json(payload);
        }
        return undefined;
      },
    ]);
    try {
      const result = await runCli([
        'events', 'ls',
        '--type', 'inbox.message.received',
        '--site', '42',
        '--since', '2026-08-01T00:00:00Z',
        '--limit', '20',
        '--cursor', 'cursor_1',
        '--output', 'json',
        '--api', base,
        '--token', 'ts_test',
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(payload);
      expect(result.stderr).toBe('');
      expect(queries).toEqual(['type=inbox.message.received&site=42&since=2026-08-01T00%3A00%3A00Z&limit=20&cursor=cursor_1']);
    } finally {
      await stop();
    }
  });

  test('events replay rejects a non-positive delivery id before the network', async () => {
    const result = await runCli([
      'events', 'replay', '0',
      '--output', 'json',
      '--api', 'http://127.0.0.1:1',
      '--token', 'ts_test',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.message).toContain('positive integer');
  });
});
