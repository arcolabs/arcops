// src/commands/site.test.ts
//
// KEH-188 - pins the site-move verb contract and handler behavior:
//   1. `site:move` is registered in BOTH the registry and the legacy COMMANDS
//      catalog (registry-consistency.test.ts checks structural parity; this
//      asserts presence + the HTTP contract against the landed server endpoint
//      arcops-server #23);
//   2. the handler resolves a site (id or domain) and POSTs { target_org } to
//      /api/sites/:id/move, printing pure data on stdout under --output json;
//   3. --to-org is required (exit 2 when missing);
//   4. the typed-confirm guardrail refuses under a non-TTY without --yes
//      (exit 1, no move POST sent) - matching the inbox send/reply guard.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { COMMANDS, DISPATCH_COMMANDS } from './index';
import { VERBS } from '../verbs/registry';
import { renderVerbHelp } from '../dispatch';

const MOVE_ID = 'site:move';

// ── Contract: registry + catalog + help ────────────────────────────────
test('site:move is registered in the registry and the legacy catalog', () => {
  expect(VERBS.find((v) => v.id === MOVE_ID), `registry verb ${MOVE_ID}`).toBeDefined();
  expect(COMMANDS.find((c) => c.path.join(':') === MOVE_ID), `legacy command ${MOVE_ID}`).toBeDefined();
});

test('site:move maps to the landed server move endpoint (#23)', () => {
  const v = VERBS.find((v) => v.id === MOVE_ID)!;
  expect(v.http).toEqual({ method: 'POST', path: '/api/sites/:siteId/move', body: ['target_org'] });
  expect(v.scope).toBe('write');
  expect(v.idempotent).toBe(false);
  // Not a send-class verb -> no idempotency key.
  expect(v.supportsIdempotencyKey ?? false).toBe(false);
});

test('site:move flags + positional bind correctly', () => {
  const cmd = COMMANDS.find((c) => c.path.join(' ') === 'site move')!;
  expect(cmd.positional?.map((p) => (typeof p === 'string' ? p : p.name))).toEqual(['site']);
  const flagNames = (cmd.flags ?? []).map((f) => (typeof f === 'string' ? f : f.name));
  expect(flagNames).toContain('--to-org');
  expect(flagNames).toContain('--yes');
  // --to-org is required at the registry level.
  const v = VERBS.find((v) => v.id === MOVE_ID)!;
  expect(v.args.find((a) => a.name === 'to_org')?.required).toBe(true);
  expect(v.args.find((a) => a.name === 'yes')?.cliOnly).toBe(true);
});

test('site move --help surfaces the human-admin requirement + --to-org', () => {
  const gen = DISPATCH_COMMANDS.find((c) => c.path.join(' ') === 'site move')!;
  expect(gen.description).toBeTruthy();
  const help = renderVerbHelp(gen);
  expect(help).toContain('Details:');
  // The server rejects org-scoped BA keys; the verb documents this.
  expect(help).toContain('human');
  expect(help).toContain('move_requires_human_admin');
  expect(help).toContain('--to-org');
  expect(help).toContain('--yes');
  // First example renders as a runnable line naming the verb.
  expect(help).toContain('$ arcops site move acme.com --to-org wodex --yes');
});

// ── Handler behavior: real local server + subprocess CLI ───────────────
type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

function mockServer(routes: Route[]): Promise<{ base: string; stop: () => Promise<void> }> {
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
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/sites'); break; } catch { await new Promise((r) => setTimeout(r, 10)); }
    }
    return { base, stop: () => server.stop(true) };
  })();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, ...env, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const SITES_LIST = { sites: [{ id: 42, domain: 'acme.com', name: 'Acme' }] };
const MOVE_RESPONSE = {
  site: { id: 42, domain: 'acme.com', name: 'Acme', org_id: 'org-dst-1' },
  move: {
    from_org: 'org-src-1',
    to_org: 'org-dst-1',
    to_org_slug: 'dst-org',
    site_integrations_moved: 2,
    retired_site_keys: 1,
  },
};

describe('site move handler (KEH-188)', () => {
  test('--yes --output json: POSTs target_org to /api/sites/:id/move, pure JSON on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-move-'));
    const movePosts: { body: unknown }[] = [];
    const { base, stop } = await mockServer([
      async (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES_LIST);
        if (req.method === 'POST' && url.pathname === '/api/sites/42/move') {
          movePosts.push({ body: await req.json() });
          return json(MOVE_RESPONSE);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'move', 'acme.com', '--to-org', 'dst-org', '--yes', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      // Pure data on stdout, no success tick / info leakage.
      expect(JSON.parse(stdout)).toEqual(MOVE_RESPONSE);
      expect(stderr).toBe('');
      // The server received exactly one move POST with the right body.
      expect(movePosts).toHaveLength(1);
      expect(movePosts[0].body).toEqual({ target_org: 'dst-org' });
    } finally {
      await stop();
    }
  });

  test('accepts a numeric site id directly', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-move-id-'));
    const movePosts: { path: string; body: unknown }[] = [];
    const { base, stop } = await mockServer([
      async (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES_LIST);
        if (req.method === 'POST' && url.pathname === '/api/sites/42/move') {
          movePosts.push({ path: url.pathname, body: await req.json() });
          return json(MOVE_RESPONSE);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout } = await runCli(
        ['site', 'move', '42', '--to-org', 'dst-org', '--yes', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(MOVE_RESPONSE);
      expect(movePosts).toHaveLength(1);
      expect(movePosts[0].path).toBe('/api/sites/42/move');
      expect(movePosts[0].body).toEqual({ target_org: 'dst-org' });
    } finally {
      await stop();
    }
  });

  test('missing --to-org exits 2 before any move POST', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-move-notoorg-'));
    const movePosts: number[] = [];
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname.startsWith('/api/sites/') && url.pathname.endsWith('/move')) {
          movePosts.push(1);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stderr } = await runCli(
        ['site', 'move', 'acme.com', '--yes', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(2);
      expect(stderr).toContain('--to-org');
      // The handler exits at the --to-org guard before resolveSiteOrExit, so no
      // move POST reaches the server (the only traffic is mockServer's own
      // readiness GET, which is not a move POST).
      expect(movePosts).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  test('missing site positional exits 2', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-move-nosite-'));
    const { base, stop } = await mockServer([]);
    try {
      const { code, stderr } = await runCli(
        ['site', 'move', '--to-org', 'dst-org', '--yes', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(2);
      expect(stderr).toContain('site argument required');
    } finally {
      await stop();
    }
  });

  test('without --yes under non-TTY stdin: refuses, exit 1, no move POST', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-move-confirm-'));
    const movePosts: number[] = [];
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES_LIST);
        if (req.method === 'POST' && url.pathname === '/api/sites/42/move') {
          movePosts.push(1);
          return json(MOVE_RESPONSE);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stderr } = await runCli(
        ['site', 'move', 'acme.com', '--to-org', 'dst-org', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      // stdin is 'ignore' (non-TTY) -> confirmByTyping refuses without --yes.
      expect(code).toBe(1);
      expect(stderr).toContain('non-interactive');
      // The site was resolved (GET /api/sites happened), but the move never fired.
      expect(movePosts).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  test('surfaces the server structured error (403 move_requires_human_admin), exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-move-403-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES_LIST);
        if (req.method === 'POST' && url.pathname === '/api/sites/42/move') {
          return json(
            { error: { code: 'move_requires_human_admin', message: 'Site moves require an identified human admin.' } },
            403,
          );
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'move', 'acme.com', '--to-org', 'dst-org', '--yes', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      // Agent-first error contract: structured envelope on stderr, no stdout.
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(env.error.code).toBe('move_requires_human_admin');
      expect(String(env.error.message)).toContain('403');
    } finally {
      await stop();
    }
  });
});
