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
const CREATE_ID = 'site:create';

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

// ── site:create contract (KEH-191) ─────────────────────────────────────
test('site:create is registered in the registry and the legacy catalog', () => {
  expect(VERBS.find((v) => v.id === CREATE_ID), `registry verb ${CREATE_ID}`).toBeDefined();
  expect(COMMANDS.find((c) => c.path.join(':') === CREATE_ID), `legacy command ${CREATE_ID}`).toBeDefined();
});

test('site:create maps to the collection POST endpoint', () => {
  const v = VERBS.find((v) => v.id === CREATE_ID)!;
  expect(v.http).toEqual({ method: 'POST', path: '/api/sites', body: ['domain', 'name'] });
  expect(v.scope).toBe('write');
  expect(v.idempotent).toBe(false);
  // Not a send-class verb -> no idempotency key.
  expect(v.supportsIdempotencyKey ?? false).toBe(false);
});

test('site:create flags + positional bind correctly', () => {
  const cmd = COMMANDS.find((c) => c.path.join(' ') === 'site create')!;
  expect(cmd.positional?.map((p) => (typeof p === 'string' ? p : p.name))).toEqual(['domain']);
  const flagNames = (cmd.flags ?? []).map((f) => (typeof f === 'string' ? f : f.name));
  expect(flagNames).toContain('--name');
  expect(flagNames).toContain('--output');
  // domain is the required positional; name is optional (defaults to domain).
  const v = VERBS.find((v) => v.id === CREATE_ID)!;
  expect(v.args.find((a) => a.name === 'domain')?.required).toBe(true);
  expect(v.args.find((a) => a.name === 'domain')?.positional).toBe(true);
  expect(v.args.find((a) => a.name === 'name')?.required ?? false).toBe(false);
});

test('site create --help surfaces the [write] scope badge + --name + example', () => {
  const gen = DISPATCH_COMMANDS.find((c) => c.path.join(' ') === 'site create')!;
  expect(gen.scope).toBe('write');
  const help = renderVerbHelp(gen);
  expect(help).toContain('[write]');
  expect(help).toContain('--name');
  // First example renders as a runnable line naming the verb.
  expect(help).toContain('$ arcops site create acme.com');
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

// The server's POST /api/sites returns the raw Drizzle sites row - camelCase
// keys plus null secret ciphertext columns (KEH-202). The CLI re-projects this
// to the snake_case shape shared with site ls/show before printing.
const CREATED_SITE_ROW = {
  id: 9,
  userId: 42,
  orgId: 'org-1',
  domain: 'acme.com',
  name: 'Acme',
  createdAt: '2026-07-20T00:00:00Z',
  stripeSecretKey: null,
  stripeWebhookSecret: null,
  archivedAt: null,
};
const CREATED_SITE_JSON = {
  id: 9,
  domain: 'acme.com',
  name: 'Acme',
  org_id: 'org-1',
  created_at: '2026-07-20T00:00:00Z',
};

describe('site create handler (KEH-191)', () => {
  test('--output json: POSTs { domain, name } to /api/sites, pure site object on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-create-'));
    const posts: { body: any }[] = [];
    const { base, stop } = await mockServer([
      async (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/sites') {
          posts.push({ body: await req.json() });
          return json({ site: CREATED_SITE_ROW }, 201);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'create', 'acme.com', '--name', 'Acme', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      // Pure data on stdout: the created site re-projected to snake_case (the
      // shape shared with site ls/show - KEH-202), unwrapped, no success tick -
      // plus the site's tracking embed tag (KEH-201), derived from the --api
      // base. The raw row's camelCase/ciphertext columns must not leak through.
      expect(JSON.parse(stdout)).toEqual({
        ...CREATED_SITE_JSON,
        embed_snippet: `<script src="${base}/t.js" data-site="9" defer></script>`,
      });
      expect(stderr).toBe('');
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({ domain: 'acme.com', name: 'Acme' });
    } finally {
      await stop();
    }
  });

  test('text mode: success tick + embed tag on stderr, nothing on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-create-text-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/sites') return json({ site: CREATED_SITE_ROW }, 201);
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'create', 'acme.com', '--name', 'Acme', '--output', 'text', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain(`embed:  <script src="${base}/t.js" data-site="9" defer></script>`);
    } finally {
      await stop();
    }
  });

  test('--name omitted: name defaults to the domain', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-create-noname-'));
    const posts: { body: any }[] = [];
    const { base, stop } = await mockServer([
      async (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/sites') {
          posts.push({ body: await req.json() });
          return json({ site: { ...CREATED_SITE_ROW, name: 'acme.com' } }, 201);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'create', 'acme.com', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({ domain: 'acme.com', name: 'acme.com' });
      expect(JSON.parse(stdout).name).toBe('acme.com');
    } finally {
      await stop();
    }
  });

  test('missing domain positional exits 2 before any POST', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-create-nodomain-'));
    const posts: number[] = [];
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/sites') posts.push(1);
        return undefined;
      },
    ]);
    try {
      const { code, stderr } = await runCli(
        ['site', 'create', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(2);
      expect(stderr).toContain('domain argument required');
      expect(posts).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  test('surfaces the server structured error (409 duplicate), exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-create-409-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/sites') {
          return json({ error: 'Site with this domain already exists' }, 409);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'create', 'acme.com', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      // Agent-first error contract: structured envelope on stderr, no stdout.
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(String(env.error.message)).toContain('409');
    } finally {
      await stop();
    }
  });
});

// ── site show handler: embed snippet (KEH-201) ─────────────────────────
const SHOW_SITE = { id: 42, domain: 'acme.com', name: 'Acme', org_id: 'org-1', created_at: '2026-07-20T00:00:00Z' };

function showMockRoutes() {
  return [
    (req: Request, url: URL) => {
      if (req.method === 'GET' && url.pathname === '/api/sites') return json(SITES_LIST);
      if (req.method === 'GET' && url.pathname === '/api/sites/42') return json({ site: SHOW_SITE });
      return undefined;
    },
  ];
}

describe('site show handler (KEH-201)', () => {
  test('--output json: site object + embed_snippet derived from the --api base', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-show-'));
    const { base, stop } = await mockServer(showMockRoutes());
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'show', 'acme.com', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        ...SHOW_SITE,
        embed_snippet: `<script src="${base}/t.js" data-site="42" defer></script>`,
      });
    } finally {
      await stop();
    }
  });

  test('text mode: table on stdout, embed tag on stderr', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-show-text-'));
    const { base, stop } = await mockServer(showMockRoutes());
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'show', '42', '--output', 'text', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(stdout).toContain('acme.com');
      expect(stderr).toContain(`embed: <script src="${base}/t.js" data-site="42" defer></script>`);
    } finally {
      await stop();
    }
  });
});

// ── site ls handler: JSON casing (KEH-202 Gate remediation) ──────────
// The ls JSON path passes the server's enriched snake_case projection through
// untouched; pin that contract directly (the Gate FAIL noted ls had no
// behavioral coverage, so the cross-verb casing contract was only pinned for
// create/show).
const LS_SITE_ROW = {
  id: 9,
  name: 'Acme',
  domain: 'acme.com',
  created_by: 42,
  created_at: '2026-07-20T00:00:00Z',
  archived_at: null,
  has_allowlist: false,
  has_stripe: false,
  has_gsc: false,
  visitors_7d: 0,
};

describe('site ls handler (KEH-202)', () => {
  test('--output json: snake_case rows on stdout, pass-through unrenamed', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-ls-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/sites') {
          return json({ sites: [LS_SITE_ROW], totals: {} });
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['site', 'ls', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      const rows = JSON.parse(stdout);
      expect(rows).toEqual([LS_SITE_ROW]);
      expect(rows[0].created_at).toBe('2026-07-20T00:00:00Z');
      expect(rows[0]).not.toHaveProperty('createdAt');
    } finally {
      await stop();
    }
  });
});

// ── Cross-verb casing contract (KEH-202 Gate remediation) ────────────
// One entity, three verbs, one casing: create re-projects the server's raw
// camelCase Drizzle row, ls passes the enriched projection through, show
// passes presentSite through - all three must surface the same snake_case
// field names so a single jq path addresses the same field across verbs.
const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;

function crossVerbMockRoutes() {
  return [
    async (req: Request, url: URL) => {
      if (req.method === 'POST' && url.pathname === '/api/sites') {
        return json({ site: CREATED_SITE_ROW }, 201);
      }
      if (req.method === 'GET' && url.pathname === '/api/sites') {
        // ls list doubles as show's id/domain resolution source.
        return json({ sites: [LS_SITE_ROW], totals: {} });
      }
      if (req.method === 'GET' && url.pathname === '/api/sites/9') {
        return json({
          site: {
            id: 9,
            name: 'Acme',
            domain: 'acme.com',
            org_id: 'org-1',
            created_at: '2026-07-20T00:00:00Z',
            archived_at: null,
          },
        });
      }
      return undefined;
    },
  ];
}

describe('site verbs share one JSON casing (KEH-202)', () => {
  test('create/show/ls --output json: same entity, same snake_case fields', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-casing-'));
    const { base, stop } = await mockServer(crossVerbMockRoutes());
    try {
      const create = await runCli(
        ['site', 'create', 'acme.com', '--name', 'Acme', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      const show = await runCli(
        ['site', 'show', 'acme.com', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      const ls = await runCli(
        ['site', 'ls', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      for (const [verb, r] of [['create', create], ['show', show], ['ls', ls]] as const) {
        expect(r.code, `${verb} stderr: ${r.stderr}`).toBe(0);
      }

      const created = JSON.parse(create.stdout);
      const shown = JSON.parse(show.stdout);
      const listed = JSON.parse(ls.stdout)[0];

      // No camelCase key survives on any verb's output.
      for (const [verb, obj] of [['create', created], ['show', shown], ['ls', listed]] as const) {
        for (const key of Object.keys(obj)) {
          expect(SNAKE_CASE_KEY.test(key), `${verb} emitted non-snake_case key "${key}"`).toBe(true);
        }
      }

      // One jq path addresses the same field on all three verbs.
      for (const obj of [created, shown, listed]) {
        expect(obj.created_at).toBe('2026-07-20T00:00:00Z');
        expect(obj.id).toBe(9);
        expect(obj.domain).toBe('acme.com');
      }

      // embed_snippet where applicable (create + show), snake_case named.
      const tag = `<script src="${base}/t.js" data-site="9" defer></script>`;
      expect(created.embed_snippet).toBe(tag);
      expect(shown.embed_snippet).toBe(tag);
    } finally {
      await stop();
    }
  });
});
