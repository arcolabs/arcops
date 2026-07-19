// src/commands/invite.test.ts
//
// KEH-179 (INV-2) - pins the invite-verb contract that the brief calls out:
//   1. the four invite verbs are registered in BOTH the registry and the
//      legacy COMMANDS catalog (registry-consistency.test.ts checks structural
//      parity; this asserts presence + the HTTP contract);
//   2. `arcops invite create --help` surfaces the two v1 form limitations
//      (max-uses>1 ⇄ email binding; OAuth skips email binding) - the brief
//      requires these into --help, so a future change that drops them fails
//      here;
//   3. the plaintext code is documented as create-only.

import { test, expect } from 'bun:test';
import { COMMANDS, DISPATCH_COMMANDS } from './index';
import { VERBS } from '../verbs/registry';
import { renderVerbHelp } from '../dispatch';

const INVITE_IDS = ['invite:create', 'invite:ls', 'invite:revoke', 'invite:stats'] as const;

test('invite verbs are registered in the registry and the legacy catalog', () => {
  for (const id of INVITE_IDS) {
    expect(VERBS.find((v) => v.id === id), `registry verb ${id}`).toBeDefined();
    expect(COMMANDS.find((c) => c.path.join(':') === id), `legacy command ${id}`).toBeDefined();
  }
});

test('invite verbs map to the server wrap routes', () => {
  const byId = (id: string) => VERBS.find((v) => v.id === id)!;
  expect(byId('invite:create').http).toEqual({ method: 'POST', path: '/api/invites', body: ['email', 'org_name', 'max_uses', 'expires', 'note'] });
  expect(byId('invite:ls').http).toEqual({ method: 'GET', path: '/api/invites', query: ['status'] });
  expect(byId('invite:revoke').http).toEqual({ method: 'DELETE', path: '/api/invites/:id' });
  expect(byId('invite:stats').http).toEqual({ method: 'GET', path: '/api/invites/stats' });
});

test('invite create is write-scope; ls/stats read; revoke write', () => {
  const byId = (id: string) => VERBS.find((v) => v.id === id)!;
  expect(byId('invite:create').scope).toBe('write');
  expect(byId('invite:revoke').scope).toBe('write');
  expect(byId('invite:ls').scope).toBe('read');
  expect(byId('invite:stats').scope).toBe('read');
});

test('invite create --help surfaces the two form-limitation notes + the create-only code', () => {
  // Use the dispatch (generated) entry, which carries the registry `description`
  // that the legacy hand-written entry does not.
  const gen = DISPATCH_COMMANDS.find((c) => c.path.join(' ') === 'invite create')!;
  expect(gen.description).toBeTruthy();
  const help = renderVerbHelp(gen);

  expect(help).toContain('Details:');
  // Form limit (1): max-uses>1 is email-bound on the email path.
  expect(help).toContain('EMAIL_MISMATCH');
  // Form limit (2): OAuth path skips email binding.
  expect(help).toContain('OAuth');
  expect(help).toContain('email binding');
  // The create-only plaintext code contract.
  expect(help.toLowerCase()).toContain('once');
  // Documented flags.
  expect(help).toContain('--email');
  expect(help).toContain('--org-name');
  expect(help).toContain('--max-uses');
});

test('invite revoke binds the id positional; ls takes --status', () => {
  const revoke = COMMANDS.find((c) => c.path.join(' ') === 'invite revoke')!;
  expect(revoke.positional?.map((p) => (typeof p === 'string' ? p : p.name))).toEqual(['id']);

  const ls = COMMANDS.find((c) => c.path.join(' ') === 'invite ls')!;
  expect((ls.flags ?? []).map((f) => (typeof f === 'string' ? f : f.name))).toContain('--status');
});
