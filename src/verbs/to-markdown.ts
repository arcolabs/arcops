// src/verbs/to-markdown.ts
//
// C3 / KEH-169 - Registry -> SKILL.md verb reference. A pure function: given
// the `VERBS` array (the same source `arcops verbs --json` serializes via
// src/commands/verbs.ts), emit the markdown for the "Verb reference" section
// of SKILL.md. Pure (no FS) so scripts/gen-skill.ts and the drift test share
// one implementation.
//
// Design doc §6.2 Phase 4: "generate the SKILL.md verb reference from the
// registry so documentation cannot drift." Adding/changing a verb and running
// `bun run gen:skill` refreshes the doc; the drift test
// (skill-drift.test.ts) fails CI if someone forgets.

import type { VerbDef } from './registry';

// Display order for the grouped tables. Mirrors the section order the registry
// itself is authored in. A verb whose id matches none of the prefix rules
// below lands in the trailing "Other" group so a new verb is never silently
// dropped from the doc - it surfaces visibly and the to-markdown test fails
// on `categoryOf` coverage.
const CATEGORY_ORDER = [
  'Auth (local)',
  'Sites & overview',
  'Analytics',
  'Campaigns & funnels',
  'Search (GSC)',
  'Customers & attribution',
  'Inbox lifecycle',
  'Inbox drafts',
  'Templates (local)',
  'Capability discovery (local)',
  'Audit',
] as const;

export function categoryOf(v: VerbDef): string {
  const id = v.id;
  // Order matters: `inbox:draft:` before `inbox:`.
  if (id.startsWith('auth:')) return 'Auth (local)';
  if (id.startsWith('site:') || id === 'overview' || id.startsWith('directory:')) return 'Sites & overview';
  if (id === 'revenue' || id === 'traffic') return 'Analytics';
  if (id.startsWith('campaign:') || id.startsWith('funnel:')) return 'Campaigns & funnels';
  if (id.startsWith('gsc:')) return 'Search (GSC)';
  if (id.startsWith('customer:') || id.startsWith('attribution:')) return 'Customers & attribution';
  if (id.startsWith('inbox:draft:')) return 'Inbox drafts';
  if (id.startsWith('inbox:')) return 'Inbox lifecycle';
  if (id.startsWith('template:')) return 'Templates (local)';
  if (id === 'verbs') return 'Capability discovery (local)';
  if (id.startsWith('audit:')) return 'Audit';
  return 'Other';
}

// The CLI invocation for a verb: `arcops ` + id with `:` -> space.
// `inbox:draft:send` -> `arcops inbox draft send`; `revenue` -> `arcops revenue`.
export function cliPath(v: VerbDef): string {
  return 'arcops ' + v.id.split(':').join(' ');
}

// Escape pipe characters so a summary containing `|` does not break the table.
function escCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function generateVerbReference(verbs: VerbDef[]): string {
  const byCat = new Map<string, VerbDef[]>();
  for (const cat of CATEGORY_ORDER) byCat.set(cat, []);
  for (const v of verbs) {
    const cat = categoryOf(v);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(v);
  }

  const lines: string[] = [];
  const renderGroup = (cat: string) => {
    const group = byCat.get(cat);
    if (!group || group.length === 0) return;
    lines.push(`### ${cat}`);
    lines.push('');
    lines.push('| Command | Scope | Kind | Summary |');
    lines.push('| --- | --- | --- | --- |');
    for (const v of group) {
      const cmd = `\`${cliPath(v)}\``;
      const scope = `\`${v.scope}\``;
      const kind = v.local ? 'local' : 'remote';
      lines.push(`| ${cmd} | ${scope} | ${kind} | ${escCell(v.summary)} |`);
    }
    lines.push('');
  };

  for (const cat of CATEGORY_ORDER) renderGroup(cat);
  renderGroup('Other'); // safety net - surfaces uncategorized verbs visibly

  return lines.join('\n').replace(/\n+$/, '');
}
