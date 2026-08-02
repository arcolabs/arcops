import { describe, expect, test } from 'bun:test';
import { COMMANDS } from './index';
import { VERBS } from '../verbs/registry';

type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockServer(routes: Route[]): Promise<{ base: string; stop: () => Promise<void> }> {
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
  return Promise.resolve({ base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) });
}

const MAIN = `${import.meta.dir}/../main.ts`;

async function runCli(args: string[], api: string) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args, '--api', api, '--token', 'ts_test'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, HOME: `/tmp/arcops-integration-test-${Date.now()}`, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const ITEM = {
  provider: 'email',
  grant_uid: 'epc_123',
  capability: 'email_send',
  grant_status: 'active',
  binding_status: 'active',
  effective_route: { source: 'managed', status: 'active' },
  health: { status: 'ok', checked_at: '2026-08-02T00:00:00.000Z' },
  provider_freshness: { status: 'unknown', evidence_at: null },
  sync_freshness: { status: 'unknown', last_sync_at: null },
  coverage: { status: 'unknown', permission_lost: false },
  last_activity_at: null,
  manage_url: '/settings/integrations/email',
};

describe('Integration Control Plane agent surface', () => {
  test('registry and legacy catalog expose exactly the two read verbs', () => {
    expect(VERBS.filter((verb) => verb.id.startsWith('integration:')).map((verb) => verb.id)).toEqual([
      'integration:ls',
      'integration:doctor',
    ]);
    expect(COMMANDS.filter((command) => command.path[0] === 'integration').map((command) => command.path.join(':'))).toEqual([
      'integration:ls',
      'integration:doctor',
    ]);
  });

  test('integration ls keeps the response envelope in JSON mode', async () => {
    const server = await mockServer([
      (req, url) => req.method === 'GET' && url.pathname === '/api/integrations'
        ? json({ items: [ITEM] })
        : undefined,
    ]);
    try {
      const result = await runCli(['integration', 'ls', '--output', 'json'], server.base);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ items: [ITEM] });
      expect(result.stderr).toBe('');
    } finally {
      await server.stop();
    }
  });

  test('integration doctor sends the site path and grant query parameter', async () => {
    let seen: URL | null = null;
    let collectionCalls = 0;
    const doctor = {
      provider: 'google_gsc',
      grant_uid: 'gsc_123',
      site_id: 7,
      aggregate: 'ready',
      checks: [],
      checked_at: '2026-08-02T00:00:00.000Z',
      manage_url: '/sites/7/integrations/search-console',
    };
    const server = await mockServer([
      (req, url) => req.method === 'GET' && url.pathname === '/api/sites'
        ? (collectionCalls++, json({ sites: [{ id: 7, domain: 'acme.com', name: 'Acme' }] }))
        : undefined,
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites/7/integrations/search-console/doctor') {
          seen = url;
          return json(doctor);
        }
        return undefined;
      },
    ]);
    try {
      const result = await runCli(['integration', 'doctor', 'search-console', '--site', '7', '--grant', 'gsc_123', '--output', 'json'], server.base);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(doctor);
      expect(seen).toBeInstanceOf(URL);
      const observed = seen as unknown as URL;
      expect(observed.searchParams.get('grant_uid')).toBe('gsc_123');
      expect(collectionCalls).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
