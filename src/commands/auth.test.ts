import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Regression test for the agent-first error contract (contract item 2) on the
// auth verbs. `auth login` / `auth status` used to catch ApiError themselves
// and call the text-only `error()` + `process.exit(1)`, so a cold-start auth
// failure under `--output json` came back as a plaintext `✖` line instead of
// the structured `{error:{code,message,...}}` envelope every other verb emits.
// Fixed by letting ApiError propagate to dispatch's `emitError`. These tests
// lock the envelope in for both verbs and guard the text-mode regression.

type Route = (req: Request, url: URL) => Response | undefined;

function mockServer(routes: Route[]): Promise<{ base: string; stop: () => Promise<void> }> {
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
  const base = `http://127.0.0.1:${server.port}`;
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(base + '/api/sites'); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    return { base, stop: () => server.stop(true) };
  })();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Every /api/sites hit in these tests is an auth sanity check that must fail
// with a structured server error (the realistic cold-start rejection path).
function unauthorized(_req: Request, url: URL): Response | undefined {
  if (url.pathname === '/api/sites') {
    return json({ error: { code: 'unauthorized', message: 'Invalid API key' } }, 401);
  }
  return undefined;
}

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env, ARCOPS_TIMEOUT_MS: '5000' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('auth error envelope (contract item 2)', () => {
  test('auth login --output json: 401 -> structured error envelope, exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-auth-'));
    const { base, stop } = await mockServer([unauthorized]);
    try {
      const { code, stderr, stdout } = await runCli(
        ['auth', 'login', '--token', 'not-a-real-key', '--api', base, '--output', 'json'],
        { HOME: home },
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(env.error.code).toBe('unauthorized');
      expect(typeof env.error.message).toBe('string');
      expect(env.error.message).toContain('401');
    } finally {
      await stop();
    }
  });

  test('auth status --output json: 401 -> structured error envelope, exit 1', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-auth-'));
    const { base, stop } = await mockServer([unauthorized]);
    try {
      const { code, stderr, stdout } = await runCli(
        ['auth', 'status', '--token', 'not-a-real-key', '--api', base, '--output', 'json'],
        { HOME: home },
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      const env = JSON.parse(stderr);
      expect(env.error.code).toBe('unauthorized');
      expect(env.error.message).toContain('401');
    } finally {
      await stop();
    }
  });

  test('auth login --output text: 401 -> human ✖ line (text mode unchanged)', async () => {
    const home = mkdtempSync(resolve(tmpdir(), 'arcops-auth-'));
    const { base, stop } = await mockServer([unauthorized]);
    try {
      const { code, stderr } = await runCli(
        ['auth', 'login', '--token', 'not-a-real-key', '--api', base, '--output', 'text'],
        { HOME: home },
      );
      expect(code).toBe(1);
      expect(stderr.startsWith('✖ ')).toBe(true);
      expect(stderr).toContain('401');
      // Must NOT be JSON in text mode.
      expect(() => JSON.parse(stderr)).toThrow();
    } finally {
      await stop();
    }
  });
});
