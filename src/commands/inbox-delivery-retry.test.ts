import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { COMMANDS } from './index';
import { VERBS } from '../verbs/registry';

test('delivery retry exposes explicit duplicate-risk confirmation', () => {
  const verb = VERBS.find((candidate) => candidate.id === 'inbox:delivery:retry')!;
  const confirmation = verb.args.find((arg) => arg.name === 'confirm_duplicate_risk')!;
  expect(confirmation.type).toBe('boolean');
  expect(confirmation.cliName).toBe('confirm-duplicate-risk');
  expect(confirmation.cliOnly).toBeUndefined();
  expect(verb.http?.body).toEqual(['confirmDuplicateRisk']);

  const command = COMMANDS.find((candidate) => candidate.path.join(' ') === 'inbox delivery retry')!;
  const flags = (command.flags ?? []).map((flag) => typeof flag === 'string' ? flag : flag.name);
  expect(flags).toContain('--confirm-duplicate-risk');
});

const MAIN = resolve(import.meta.dir, '..', 'main.ts');

async function runRetry(confirmDuplicateRisk: boolean) {
  let postedBody: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/api/sites') {
        return Response.json({ sites: [{ id: 42, domain: 'acme.com' }] });
      }
      if (req.method === 'POST' && url.pathname === '/api/sites/42/inbox/deliveries/idl_123/retry') {
        postedBody = await req.json();
        return Response.json({ delivery: { delivery_uid: 'idl_123', status: 'queued' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const args = [
      'inbox', 'delivery', 'retry', 'acme.com', 'idl_123', '--yes', '--output', 'json',
      '--api', `http://127.0.0.1:${server.port}`, '--token', 'ts_test',
    ];
    if (confirmDuplicateRisk) args.push('--confirm-duplicate-risk');
    const proc = Bun.spawn([process.execPath, MAIN, ...args], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ARCOPS_TIMEOUT_MS: '5000' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { postedBody, stdout, stderr, code };
  } finally {
    await server.stop(true);
  }
}

test('delivery retry sends duplicate-risk confirmation only when explicitly selected', async () => {
  const ordinary = await runRetry(false);
  expect(ordinary.code).toBe(0);
  expect(ordinary.postedBody).toEqual({ confirmDuplicateRisk: false });

  const confirmed = await runRetry(true);
  expect(confirmed.code).toBe(0);
  expect(confirmed.postedBody).toEqual({ confirmDuplicateRisk: true });
}, 15_000);
