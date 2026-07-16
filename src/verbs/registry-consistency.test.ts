// src/verbs/registry-consistency.test.ts
//
// C2 / KEH-150 - Phase 2 drift gate (design §6.3). While the legacy
// hand-written `COMMANDS` catalog and the generated registry-backed catalog
// coexist, this test enforces that they describe the same verb surface. Once
// Phase 3 removes legacy `COMMANDS`, this shrinks to a smaller schema test.
//
// The seven assertions below mirror design §6.3 (1-6 implemented in full on
// the CLI side; #7 is the CLI-side half of the server-side scope gate - every
// remote verb's scope is declared and in {read, write, send}).

import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import {
  COMMANDS, GENERATED_COMMANDS, DISPATCH_COMMANDS,
  flagName, flagType, positionalName, positionalType,
  type FlagSpec, type PositionalSpec,
} from '../commands';
import { VERBS, isCliOnlyArg, type VerbDef } from './registry';

const MAIN = resolve(import.meta.dir, '..', 'main.ts');
const SCOPES = ['read', 'write', 'send'] as const;

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function normFlag(f: FlagSpec): { name: string; type: string } {
  return { name: flagName(f), type: flagType(f) };
}
function normPos(p: PositionalSpec): { name: string; type: string } {
  return { name: positionalName(p), type: positionalType(p) };
}
function legacyFor(id: string) {
  return COMMANDS.find((c) => arraysEqual(c.path, id.split(':')))!;
}
function generatedFor(id: string) {
  return GENERATED_COMMANDS.find((c) => arraysEqual(c.path, id.split(':')))!;
}

describe('verb registry consistency (design §6.3)', () => {
  // 1. Every VerbDef.id resolves to exactly one legacy CommandDef.path.
  test('1. every verb id maps to exactly one legacy command path', () => {
    for (const v of VERBS) {
      const matches = COMMANDS.filter((c) => arraysEqual(c.path, v.id.split(':')));
      expect(matches.length, `verb '${v.id}'`).toBe(1);
    }
  });

  // 2. Every legacy CommandDef.path resolves to exactly one VerbDef.id.
  test('2. every legacy command path maps to exactly one verb id', () => {
    for (const c of COMMANDS) {
      const matches = VERBS.filter((v) => v.id === c.path.join(':'));
      expect(matches.length, `command '${c.path.join(' ')}'`).toBe(1);
    }
  });

  // 3. Flag names + types consistent (kebab CLI name <-> snake registry name),
  //    including order, so per-verb --help is byte-identical to legacy.
  test('3. generated flags match legacy flags (name + type + order)', () => {
    for (const v of VERBS) {
      const lf = (legacyFor(v.id).flags ?? []).map(normFlag);
      const gf = (generatedFor(v.id).flags ?? []).map(normFlag);
      expect(gf, `flags for '${v.id}'`).toEqual(lf);
    }
  });

  // 4. Positional binding order matches (name + type).
  test('4. generated positionals match legacy positionals (name + type + order)', () => {
    for (const v of VERBS) {
      const lp = (legacyFor(v.id).positional ?? []).map(normPos);
      const gp = (generatedFor(v.id).positional ?? []).map(normPos);
      expect(gp, `positionals for '${v.id}'`).toEqual(lp);
    }
  });

  // 5. Every verb satisfies the local/remote invariant (design §4):
  //    local === true  <=>  http === undefined.
  test('5. local/remote invariant: local <=> no http', () => {
    for (const v of VERBS) {
      const isLocal = v.local === true;
      const hasHttp = v.http !== undefined;
      expect(isLocal === !hasHttp, `verb '${v.id}' must be local XOR remote (local=${isLocal}, http=${hasHttp})`).toBe(true);
    }
  });

  // 6. No cliOnly arg leaks into the MCP-facing arg list (design §5.2): every
  //    known cliOnly-named arg is marked cliOnly, and the non-cliOnly,
  //    non-positional list contains no cliOnly-named arg.
  test('6. cliOnly args are marked and excluded from the MCP arg list', () => {
    for (const v of VERBS) {
      for (const a of v.args) {
        if (isCliOnlyArg(a.name)) {
          expect(a.cliOnly, `arg '${a.name}' on '${v.id}' must be cliOnly`).toBe(true);
        }
      }
      const mcpFacing = v.args.filter((a) => !a.cliOnly && !a.positional);
      for (const a of mcpFacing) {
        expect(isCliOnlyArg(a.name), `arg '${a.name}' on '${v.id}' leaked into MCP list`).toBe(false);
      }
    }
  });

  // 7. (CLI-side of the server scope gate) Every remote verb's scope is
  //    declared and in {read, write, send}. Local verbs are exempt from
  //    enforcement (design §5.1) but still carry a documentary scope, which
  //    we also validate is in the ladder.
  test('7. every verb scope is declared and in read/write/send', () => {
    for (const v of VERBS) {
      expect(SCOPES.includes(v.scope), `verb '${v.id}' scope '${v.scope}'`).toBe(true);
    }
  });

  // Summary + examples parity so `arcops <verb> --help` text is unchanged.
  test('generated summaries + examples match legacy (help text parity)', () => {
    for (const v of VERBS) {
      const legacy = legacyFor(v.id);
      const gen = generatedFor(v.id);
      expect(gen.summary, `summary for '${v.id}'`).toBe(legacy.summary);
      expect(gen.examples ?? [], `examples for '${v.id}'`).toEqual(legacy.examples ?? []);
    }
  });

  // C1/KEH-116: supportsIdempotencyKey is set only on the three send-class
  // verbs (inbox:send / inbox:reply / inbox:draft:send).
  test('supportsIdempotencyKey is set only on the send-class verbs', () => {
    const sendClass = new Set(['inbox:send', 'inbox:reply', 'inbox:draft:send']);
    for (const v of VERBS) {
      expect(!!v.supportsIdempotencyKey, `verb '${v.id}'`).toBe(sendClass.has(v.id));
    }
  });

  // Dispatch mounts both catalogs with generated precedence (design §6.2): no
  // duplicate paths, every legacy command still routable.
  test('dispatch catalog mounts every command exactly once', () => {
    const paths = DISPATCH_COMMANDS.map((c) => c.path.join('\0'));
    expect(new Set(paths).size, 'no duplicate paths in DISPATCH_COMMANDS').toBe(paths.length);
    expect(paths.length, 'dispatch covers all legacy commands').toBeGreaterThanOrEqual(COMMANDS.length);
    for (const c of COMMANDS) {
      expect(paths.includes(c.path.join('\0')), `dispatch missing '${c.path.join(' ')}'`).toBe(true);
    }
  });

  // Design §5.3: `arcops verbs --json` prints the full registry, local verbs
  // included. End-to-end through the real dispatch path.
  test('arcops verbs --json prints the registry including local verbs', async () => {
    const proc = Bun.spawn([process.execPath, MAIN, 'verbs', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    const j = JSON.parse(stdout) as { verbs: VerbDef[] };
    expect(j.verbs.length).toBe(VERBS.length);
    const ids = j.verbs.map((v) => v.id);
    expect(ids).toContain('template:edit');   // local verb included
    expect(ids).toContain('verbs');           // self-listed
    expect(ids).toContain('inbox:send');      // remote verb
  });
});
