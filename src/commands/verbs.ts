// src/commands/verbs.ts
//
// C2 / KEH-150 - `arcops verbs` capability discovery (design §5.3). Prints the
// verb registry so agents can discover operations at runtime instead of
// relying on static SKILL.md text. Local verbs are included (they are part of
// the CLI command surface even though they have no server counterpart).
//
// `arcops verbs --json` prints the full registry as `{ verbs: VerbDef[] }`.
// In a non-TTY pipe the same JSON shape is emitted via the standard
// `--output json` convention; in a TTY a compact table is printed to stderr.

import { VERBS } from '../verbs/registry';
import { detectOutputFormat, info, printJson, printTable } from '../output';

export async function verbs(args: { json?: string; output?: string }) {
  const asJson = args.json === 'true' || detectOutputFormat(args.output) === 'json';
  if (asJson) return printJson({ verbs: VERBS });

  info(`${VERBS.length} verbs registered:`);
  printTable(
    VERBS.map((v) => ({
      id: v.id,
      scope: v.scope,
      kind: v.local ? 'local' : 'remote',
      idempotent: v.idempotent ? 'yes' : 'no',
      summary: v.summary,
    })) as unknown as Record<string, unknown>[],
    ['id', 'scope', 'kind', 'idempotent', 'summary'],
  );
}
