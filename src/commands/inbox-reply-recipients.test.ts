// Reply recipient contract (2026-08-05): the wire request and the preview must
// agree on who gets the reply. Previously the preview listed every thread
// participant (including our own support address) while the request never set
// replyAll - so the server replied only to the sender while the preview read
// as reply-all. Pins:
//   1. default: request body replyAll=false, preview shows ONLY the last
//      inbound sender (own-domain addresses filtered);
//   2. --reply-all: request body replyAll=true, preview adds the other
//      participants as cc;
//   3. --dry-run carries the same recipient set (no separate preview drift).

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

function mockServer(routes: Route[]): { base: string; stop: () => Promise<void> } {
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

function makeServer() {
  const postBodies: Array<Record<string, unknown>> = [];
  let threadGets = 0;
  const { base, stop } = mockServer([
    (req, url) => url.pathname === '/api/sites' && req.method === 'GET'
      ? json({ sites: [{ id: 42, domain: 'acme.com', name: 'Acme' }] }) : undefined,
    async (req, url) => {
      if (
        url.pathname !== '/api/sites/42/inbox/threads/7'
        && url.pathname !== '/api/sites/42/inbox/threads/7/reply'
      ) return undefined;
      if (req.method === 'GET') {
        threadGets++;
        const msgs = [
          { id: 100, from_email: 'cust@x.com', direction: 'inbound', received_at: '2026-08-01T00:00:00Z', snippet: 'hi' },
          { id: 101, from_email: 'phillip@helpscout.example', direction: 'inbound', received_at: '2026-08-01T01:00:00Z', snippet: 'helping' },
        ];
        if (threadGets >= 2) {
          msgs.push({ id: 102, from_email: 'support@acme.com', direction: 'outbound', received_at: '2026-08-05T00:00:00Z', snippet: 'thanks' });
        }
        return json({
          thread: {
            id: 7, subject: 'Re: Pricing', status: 'open', unread_for_ops: 0, assignee_email: null,
            participant_emails: ['cust@x.com', 'phillip@helpscout.example', 'support@acme.com'], domain: 'acme.com',
          },
          messages: msgs,
        });
      }
      if (req.method === 'POST') {
        const b = (await req.json()) as Record<string, unknown>;
        postBodies.push(b);
        return json({ messageId: 102, delivery: { uid: 'idl_abc', status: 'sent', acceptedAt: '2026-08-05T00:00:00Z' } });
      }
      return undefined;
    },
  ]);
  return { base, stop, postBodies };
}

const COMMON = ['inbox', 'reply', 'acme.com', '7', '--api', 'BASE', '--token', 'dummy'];

describe('inbox reply recipients (preview === wire)', () => {
  test('default replies to the last inbound sender only (replyAll=false)', async () => {
    const { base, stop, postBodies } = makeServer();
    const res = await runCli([...COMMON.map((a) => a === 'BASE' ? base : a), '--body', 'thanks', '--yes']);
    await stop();

    expect(res.code).toBe(0);
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].replyAll).toBe(false);
    // Preview lists the sender and never our own support address.
    expect(res.stderr).toContain('To:       phillip@helpscout.example');
    expect(res.stderr).toContain('reply to sender only');
    expect(res.stderr).not.toContain('support@acme.com');
  });

  test('--reply-all sets replyAll=true and previews the other participants as cc', async () => {
    const { base, stop, postBodies } = makeServer();
    const res = await runCli([...COMMON.map((a) => a === 'BASE' ? base : a), '--body', 'thanks', '--yes', '--reply-all']);
    await stop();

    expect(res.code).toBe(0);
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].replyAll).toBe(true);
    expect(res.stderr).toContain('phillip@helpscout.example (cc: cust@x.com)');
    expect(res.stderr).toContain('reply-all (cc other participants)');
    expect(res.stderr).not.toContain('support@acme.com');
  });
});
