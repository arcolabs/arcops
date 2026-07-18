// src/verbs/to-markdown.test.ts
//
// C3 / KEH-169 - Unit tests for the SKILL.md verb-reference generator. The
// drift test (skill-drift.test.ts) guards the committed SKILL.md against the
// registry; these tests guard the generator itself: every verb resolves to a
// known category, the table shape is stable, and the send-class verbs (the
// ones the Idempotency section names) are present.

import { test, expect, describe } from 'bun:test';
import { VERBS, type VerbDef } from './registry';
import { generateVerbReference, categoryOf, cliPath } from './to-markdown';

describe('to-markdown verb reference', () => {
  test('every verb resolves to a known category (no "Other")', () => {
    const orphans = VERBS.filter((v) => categoryOf(v) === 'Other');
    expect(orphans.map((v) => v.id)).toEqual([]);
  });

  test('every verb appears in the generated reference', () => {
    const md = generateVerbReference(VERBS);
    for (const v of VERBS) {
      expect(md).toContain(`\`${cliPath(v)}\``);
      expect(md).toContain(`\`${v.scope}\``);
    }
  });

  test('groups render as markdown tables with the canonical header', () => {
    const md = generateVerbReference(VERBS);
    expect(md).toContain('| Command | Scope | Kind | Summary |');
    expect(md).toContain('### Auth (local)');
    expect(md).toContain('### Inbox lifecycle');
    expect(md).toContain('### Capability discovery (local)');
  });

  test('local verbs are marked local, remote verbs remote', () => {
    const md = generateVerbReference(VERBS);
    const login = VERBS.find((v) => v.id === 'auth:login')!;
    const revenue = VERBS.find((v) => v.id === 'revenue')!;
    expect(login.local).toBe(true);
    expect(revenue.local).toBeUndefined();
    // The row for auth:login carries `local`; revenue's row carries `remote`.
    expect(md).toMatch(/\| `arcops auth login` \| `write` \| local \|/);
    expect(md).toMatch(/\| `arcops revenue` \| `read` \| remote \|/);
  });

  test('the three send-class verbs are present (named by the Idempotency section)', () => {
    const md = generateVerbReference(VERBS);
    for (const id of ['inbox:send', 'inbox:reply', 'inbox:draft:send']) {
      const v = VERBS.find((x) => x.id === id) as VerbDef;
      expect(md).toContain(`\`${cliPath(v)}\``);
      expect(v.scope).toBe('send');
    }
  });

  test('pipes in summaries are escaped so they do not break the table', () => {
    const tricky: VerbDef = { ...VERBS[0], id: 'test:pipe', summary: 'a | b | c', args: [], examples: [], scope: 'read', idempotent: true, local: true, outputShape: 'void' };
    const md = generateVerbReference([tricky]);
    expect(md).toContain('a \\| b \\| c');
    expect(md).not.toMatch(/\| a \| b \| c \|/); // unescaped would add columns
  });
});
