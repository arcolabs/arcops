// src/commands/help.test.ts
//
// C4 / KEH-118 - --help agent-readability audit (the machine-checkable gate).
//
// Every verb must:
//   1. carry >=1 `examples` entry (so an agent can self-bootstrap from help),
//   2. have each example start with its own command path (consistency - an
//      example that names a different verb misleads),
//   3. render help containing Usage / Flags-or-Positionals / Examples sections.
//
// This is the "全动词过脚本检查（含示例行）" acceptance: it runs in `bun test`
// (CI), so a verb missing an example fails the build.

import { test, expect } from 'bun:test';
import { COMMANDS, flagName } from './index';
import { renderVerbHelp } from '../dispatch';

// Mirrors dispatch.ts - flags treated as global (hidden from per-verb Flags).
const GLOBAL_FLAG_NAMES = new Set(['--output', '--token', '--api']);

test('every command has at least one example', () => {
  const missing = COMMANDS.filter((c) => !c.examples || c.examples.length === 0);
  expect(missing.map((c) => c.path.join(' '))).toEqual([]);
});

test('every example starts with its own command path', () => {
  for (const c of COMMANDS) {
    const prefix = c.path.join(' ');
    for (const ex of c.examples ?? []) {
      // Allow the example to continue past the path (flags/positionals) but it
      // must name THIS verb first.
      expect(ex === prefix || ex.startsWith(prefix + ' ')).toBe(true);
    }
  }
});

test('every verb help contains Usage and Examples; verbs with args render them', () => {
  for (const c of COMMANDS) {
    const help = renderVerbHelp(c);
    expect(help).toContain('Usage:');
    expect(help).toContain('Examples:');
    // A verb that documents positionals/flags must render the corresponding
    // section. (A few verbs like `auth logout` take no args; a verb whose only
    // flags are global - e.g. `auth login` - has no per-verb Flags section.)
    if (c.positional && c.positional.length) expect(help).toContain('Positionals:');
    const nonGlobalFlags = (c.flags ?? []).filter((f) => !GLOBAL_FLAG_NAMES.has(flagName(f)));
    if (nonGlobalFlags.length) expect(help).toContain('Flags:');
    // The first example renders as a runnable `$ arcops ...` line.
    expect(help).toContain(`$ arcops ${c.examples![0]}`);
  }
});

test('inbox ls help surfaces the cursor flag and a cursor example', () => {
  const ls = COMMANDS.find((c) => c.path.join(' ') === 'inbox ls')!;
  const help = renderVerbHelp(ls);
  expect(help).toContain('--cursor');
  expect(help).toContain('number');   // --limit is typed number
  expect(help).toContain('bool');      // --unread/--unassigned are bool
  expect(help).toMatch(/--cursor <next_cursor>/);
});

test('flag types render (bool / number / string[])', () => {
  const reply = COMMANDS.find((c) => c.path.join(' ') === 'inbox reply')!;
  const help = renderVerbHelp(reply);
  expect(help).toContain('--yes');      // bool
  expect(help).toContain('--attach');   // string[]
  expect(help).toContain('string[]');
});
