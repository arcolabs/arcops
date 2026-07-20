// src/commands/org.test.ts
//
// KEH-198 - pins the org:list / org:create verb contract and handler behavior:
//   1. `org:ls` + `org:create` are registered in BOTH the registry and the
//      legacy COMMANDS catalog (registry-consistency.test.ts checks structural
//      parity; this asserts presence + the HTTP contract against the landed
//      server endpoint arcops-server #35 / KEH-197);
//   2. `org:ls` GETs /api/orgs and prints pure data on stdout under --output
//      json; `org:create` POSTs { name, slug? } to /api/orgs (201 { org });
//   3. --name is required on create (exit 2 when missing, no POST sent);
//   4. --slug omitted => only { name } is sent (the server derives the slug);
//   5. the server's 403 org_admin_required (org-scoped key) and 409
//      org_already_exists flow through the standard structured error envelope
//      on stderr, exit 1, no stdout - the agent-first error contract.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { COMMANDS, DISPATCH_COMMANDS } from './index';
import { VERBS } from '../verbs/registry';
import { renderVerbHelp } from '../dispatch';

const LS_ID = 'org:ls';
const CREATE_ID = 'org:create';

// ── Contract: registry + catalog + help ────────────────────────────────
test('org:ls is registered in the registry and the legacy catalog', () => {
  expect(VERBS.find((v) => v.id === LS_ID), `registry verb ${LS_ID}`).toBeDefined();
  expect(COMMANDS.find((c) => c.path.join(':') === LS_ID), `legacy command ${LS_ID}`).toBeDefined();
});

test('org:ls maps to the landed server orgs list endpoint (#35)', () => {
  const v = VERBS.find((v) => v.id === LS_ID)!;
  expect(v.http).toEqual({ method: 'GET', path: '/api/orgs' });
  expect(v.scope).toBe('read');
  expect(v.idempotent).toBe(true);
  expect(v.supportsIdempotencyKey ?? false).toBe(false);
});

test('org:ls has only the global --output flag', () => {
  const cmd = COMMANDS.find((c) => c.path.join(' ') === 'org ls')!;
  expect(cmd.positional).toBeUndefined();
  const flagNames = (cmd.flags ?? []).map((f) => (typeof f === 'string' ? f : f.name));
  expect(flagNames).toEqual(['--output']);
});

test('org ls --help surfaces the [read] scope badge + human-admin requirement', () => {
  const gen = DISPATCH_COMMANDS.find((c) => c.path.join(' ') === 'org ls')!;
  expect(gen.scope).toBe('read');
  const help = renderVerbHelp(gen);
  expect(help).toContain('[read]');
  expect(help).toContain('Details:');
  // The server rejects org-scoped BA keys; the verb documents this.
  expect(help).toContain('human');
  expect(help).toContain('org_admin_required');
  expect(help).toContain('$ arcops org ls');
});

test('org:create is registered in the registry and the legacy catalog', () => {
  expect(VERBS.find((v) => v.id === CREATE_ID), `registry verb ${CREATE_ID}`).toBeDefined();
  expect(COMMANDS.find((c) => c.path.join(':') === CREATE_ID), `legacy command ${CREATE_ID}`).toBeDefined();
});

test('org:create maps to the collection POST endpoint', () => {
  const v = VERBS.find((v) => v.id === CREATE_ID)!;
  expect(v.http).toEqual({ method: 'POST', path: '/api/orgs', body: ['name', 'slug'] });
  expect(v.scope).toBe('write');
  expect(v.idempotent).toBe(false);
  expect(v.supportsIdempotencyKey ?? false).toBe(false);
});

test('org:create flags bind correctly; --name is required, --slug optional', () => {
  const cmd = COMMANDS.find((c) => c.path.join(' ') === 'org create')!;
  expect(cmd.positional).toBeUndefined();
  const flagNames = (cmd.flags ?? []).map((f) => (typeof f === 'string' ? f : f.name));
  expect(flagNames).toEqual(['--name', '--slug', '--output']);
  const v = VERBS.find((v) => v.id === CREATE_ID)!;
  expect(v.args.find((a) => a.name === 'name')?.required).toBe(true);
  expect(v.args.find((a) => a.name === 'slug')?.required ?? false).toBe(false);
});

test('org create --help surfaces the [write] scope badge + --name/--slug + example', () => {
  const gen = DISPATCH_COMMANDS.find((c) => c.path.join(' ') === 'org create')!;
  expect(gen.scope).toBe('write');
  const help = renderVerbHelp(gen);
  expect(help).toContain('[write]');
  expect(help).toContain('--name');
  expect(help).toContain('--slug');
  expect(help).toContain('org_admin_required');
  expect(help).toContain('$ arcops org create --name "Acme Inc"');
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
      try { await fetch(base + '/api/orgs'); break; } catch { await new Promise((r) => setTimeout(r, 10)); }
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

const ORGS_LIST = {
  orgs: [
    { id: 'org-aaa-111', name: 'Acme', slug: 'acme', role: 'owner', createdAt: '2026-07-20T00:00:00.000Z' },
    { id: 'org-bbb-222', name: 'Wodex', slug: 'wodex', role: 'admin', createdAt: '2026-07-19T00:00:00.000Z' },
  ],
};
const CREATED_ORG = { id: 'org-ccc-333', name: 'Acme Inc', slug: 'acme-inc', role: 'owner', createdAt: '2026-07-20T12:00:00.000Z' };

describe('org ls handler (KEH-198)', () => {
  test('--output json: GETs /api/orgs, pure orgs array on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgls-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/orgs') return json(ORGS_LIST);
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'ls', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(JSON.parse(stdout)).toEqual(ORGS_LIST.orgs);
      expect(stderr).toBe('');
    } finally {
      await stop();
    }
  });

  test('text mode: table on stdout, nothing leaked to stdout beyond the table', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgls-text-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/orgs') return json(ORGS_LIST);
        return undefined;
      },
    ]);
    try {
      const { code, stdout } = await runCli(
        ['org', 'ls', '--output', 'text', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(0);
      expect(stdout).toContain('acme');
      expect(stdout).toContain('wodex');
      expect(stdout).toContain('owner');
    } finally {
      await stop();
    }
  });

  test('empty list (text mode): info on stderr, empty stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgls-empty-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/orgs') return json({ orgs: [] });
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'ls', '--output', 'text', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('No organizations you administer.');
    } finally {
      await stop();
    }
  });

  test('empty list (json mode): [] on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgls-empty-json-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/orgs') return json({ orgs: [] });
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'ls', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      await stop();
    }
  });

  test('surfaces the server structured error (403 org_admin_required), exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgls-403-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'GET' && url.pathname === '/api/orgs') {
          return json(
            { error: { code: 'org_admin_required', message: 'Org administration requires an identified human admin (browser session or ts_ token), not an org-scoped API key.' } },
            403,
          );
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'ls', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(env.error.code).toBe('org_admin_required');
      expect(String(env.error.message)).toContain('403');
    } finally {
      await stop();
    }
  });
});

describe('org create handler (KEH-198)', () => {
  test('--output json: POSTs { name, slug } to /api/orgs, pure org object on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgcreate-'));
    const posts: { body: any }[] = [];
    const { base, stop } = await mockServer([
      async (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/orgs') {
          posts.push({ body: await req.json() });
          return json({ org: CREATED_ORG }, 201);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'create', '--name', 'Acme Inc', '--slug', 'acme-inc', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(JSON.parse(stdout)).toEqual(CREATED_ORG);
      expect(stderr).toBe('');
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({ name: 'Acme Inc', slug: 'acme-inc' });
    } finally {
      await stop();
    }
  });

  test('--slug omitted: only { name } is sent (server derives the slug)', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgcreate-noslug-'));
    const posts: { body: any }[] = [];
    const { base, stop } = await mockServer([
      async (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/orgs') {
          posts.push({ body: await req.json() });
          return json({ org: { ...CREATED_ORG, slug: 'acme-inc' } }, 201);
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'create', '--name', 'Acme Inc', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({ name: 'Acme Inc' });
      expect(JSON.parse(stdout).slug).toBe('acme-inc');
    } finally {
      await stop();
    }
  });

  test('text mode: success tick + slug/role on stderr, nothing on stdout', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgcreate-text-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/orgs') return json({ org: CREATED_ORG }, 201);
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'create', '--name', 'Acme Inc', '--output', 'text', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('acme-inc');
      expect(stderr).toContain('owner');
    } finally {
      await stop();
    }
  });

  test('missing --name exits 2 before any POST', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgcreate-noname-'));
    const posts: number[] = [];
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/orgs') posts.push(1);
        return undefined;
      },
    ]);
    try {
      const { code, stderr } = await runCli(
        ['org', 'create', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(2);
      expect(stderr).toContain('--name is required');
      expect(posts).toHaveLength(0);
    } finally {
      await stop();
    }
  });

  test('surfaces the server structured error (409 org_already_exists), exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgcreate-409-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/orgs') {
          return json(
            { error: { code: 'org_already_exists', message: 'An organization with that slug already exists.' } },
            409,
          );
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'create', '--name', 'Acme Inc', '--slug', 'acme', '--output', 'json', '--api', base, '--token', 'ts_test'],
        { HOME: home },
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(env.error.code).toBe('org_already_exists');
      expect(String(env.error.message)).toContain('409');
    } finally {
      await stop();
    }
  });

  test('surfaces the server structured error (403 org_admin_required for an org-scoped key), exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-orgcreate-403-'));
    const { base, stop } = await mockServer([
      (req, url) => {
        if (req.method === 'POST' && url.pathname === '/api/orgs') {
          return json(
            { error: { code: 'org_admin_required', message: 'Org administration requires an identified human admin (browser session or ts_ token), not an org-scoped API key.' } },
            403,
          );
        }
        return undefined;
      },
    ]);
    try {
      const { code, stdout, stderr } = await runCli(
        ['org', 'create', '--name', 'Acme Inc', '--output', 'json', '--api', base, '--token', 'ba_test'],
        { HOME: home },
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(env.error.code).toBe('org_admin_required');
      expect(String(env.error.message)).toContain('403');
    } finally {
      await stop();
    }
  });
});
