// `inbox search <term>` - cross-site subject search. Pins:
//   1. fans the search out across every readable site and annotates each hit
//      with site_domain (the routing answer an agent needs when it does not
//      know which product's mailbox a customer wrote to);
//   2. a site that errors is skipped with a warn, not fatal to the scan;
//   3. json output shape: { search, sites_scanned, threads };
//   4. missing term exits 2 (arg validation).

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

type Route = (req: Request, url: URL) => Response | undefined;

function mockServer(routes: Route[]): { base: string; stop: () => Promise<void> } {
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
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

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

function sitesRoute(): Route {
  return (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
    ? json({ sites: [
      { id: 1, domain: 'alpha.com', name: 'Alpha' },
      { id: 2, domain: 'beta.com', name: 'Beta' },
    ] }) : undefined;
}

const THREAD_A = {
  id: 10, subject: 'Legnext pricing question', status: 'open',
  last_message_at: '2026-08-01T00:00:00Z', unread_for_ops: true,
  participant_emails: ['cust@x.com', 'support@alpha.com'],
};

describe('inbox search (cross-site)', () => {
  test('fans out across sites and annotates hits with site_domain (json)', async () => {
    const calls: string[] = [];
    const { base, stop } = await mockServer([
      sitesRoute(),
      (req, url) => {
        if (url.pathname !== '/api/sites/1/inbox/threads' && url.pathname !== '/api/sites/2/inbox/threads') return undefined;
        calls.push(url.pathname);
        expect(url.searchParams.get('search')).toBe('legnext');
        return json({
          threads: url.pathname === '/api/sites/1/inbox/threads' ? [THREAD_A] : [],
          counts: { open: 1, waiting: 0, snoozed: 0, closed: 0 },
          nextCursor: null,
        });
      },
    ]);
    const res = await runCli(['inbox', 'search', 'legnext', '--api', base, '--token', 'dummy', '--output', 'json']);
    await stop();

    expect(res.code).toBe(0);
    expect(calls.sort()).toEqual(['/api/sites/1/inbox/threads', '/api/sites/2/inbox/threads']);
    const out = JSON.parse(res.stdout) as { search: string; sites_scanned: number; threads: Array<Record<string, unknown>> };
    expect(out.search).toBe('legnext');
    expect(out.sites_scanned).toBe(2);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].site_domain).toBe('alpha.com');
    expect(out.threads[0].id).toBe(10);
  });

  test('a failing site is skipped with a warn, other sites still report', async () => {
    const { base, stop } = await mockServer([
      sitesRoute(),
      (req, url) => {
        if (url.pathname === '/api/sites/1/inbox/threads') return json({ threads: [THREAD_A], counts: {}, nextCursor: null });
        if (url.pathname === '/api/sites/2/inbox/threads') return new Response('boom', { status: 500 });
        return undefined;
      },
    ]);
    const res = await runCli(['inbox', 'search', 'legnext', '--api', base, '--token', 'dummy', '--output', 'json']);
    await stop();

    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { sites_scanned: number; threads: Array<Record<string, unknown>> };
    expect(out.sites_scanned).toBe(2);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].site_domain).toBe('alpha.com');
    expect(res.stderr).toContain('skipped beta.com');
  });

  test('missing term exits 2 with a usage error', async () => {
    const res = await runCli(['inbox', 'search']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('search term required');
  });
});
