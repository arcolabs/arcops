// src/verbs/to-cli.ts
//
// C2 / KEH-150 - Registry -> CLI command-tree generator. Transforms the verb
// registry (`VERBS`) into the `CommandDef[]` shape consumed by the trie router
// in src/dispatch.ts. The registry owns the verb contract; this module is the
// mechanical bridge from that contract to the existing CLI dispatch surface.
//
// Mapping (design §5.1):
//   - path       <- id split on ':'
//   - summary    <- summary
//   - positional <- args with positional:true, in declared order
//   - flags      <- args without positional:true, in declared order (cliOnly
//                   args are INCLUDED on the CLI side; they are filtered out
//                   only for the MCP input schema, design §5.2)
//   - examples   <- examples
//   - handler    <- handlers[verb.id]
//
// Type mapping: registry `boolean` -> CLI `bool` (the CLI's FlagType uses
// `bool` for switches); `enum` is rendered as a plain string flag on the CLI
// (the CLI does not validate enums today; preserving that is a behavior
// no-op). `string[]` maps to the CLI repeatable-flag type.

import type {
  CommandDef, CommandHandler, FlagSpec, FlagType, PositionalSpec,
} from '../commands';
import type { VerbDef, VerbArg } from './registry';

// The CLI flag convention is kebab-case with a `--` prefix (e.g. `--body-file`).
// The registry canonical name is snake_case; `cliName` overrides it when the
// two differ (multi-word args). The generator always emits the `--` prefix.
function cliFlagName(arg: VerbArg): string {
  return '--' + (arg.cliName ?? arg.name);
}

function positionalName(arg: VerbArg): string {
  return arg.cliName ?? arg.name;
}

// Registry ArgType -> CLI FlagType. `boolean` becomes `bool`; `enum` collapses
// to `string` (no CLI-side enum validation - behavior no-op vs legacy).
function flagTypeOf(arg: VerbArg): FlagType {
  switch (arg.type) {
    case 'number': return 'number';
    case 'boolean': return 'bool';
    case 'string[]': return 'string[]';
    case 'enum':
    case 'string':
    default:
      return 'string';
  }
}

function toFlagSpec(arg: VerbArg): FlagSpec {
  const type = flagTypeOf(arg);
  // Bare-string flags (type `string`) render as the kebab name without a type
  // wrapper, matching the legacy catalog exactly.
  return type === 'string' ? cliFlagName(arg) : { name: cliFlagName(arg), type };
}

function toPositionalSpec(arg: VerbArg): PositionalSpec {
  return arg.type === 'number'
    ? { name: positionalName(arg), type: 'number' }
    : positionalName(arg);
}

export function generateCommandDefs(
  verbs: VerbDef[],
  handlers: Record<string, CommandHandler>,
): CommandDef[] {
  return verbs.map((verb) => {
    const positional = verb.args.filter((a) => a.positional).map(toPositionalSpec);
    const flags = verb.args.filter((a) => !a.positional).map(toFlagSpec);
    const handler = handlers[verb.id];
    if (!handler) {
      throw new Error(`to-cli: no handler registered for verb '${verb.id}'`);
    }
    const cmd: CommandDef = {
      path: verb.id.split(':'),
      summary: verb.summary,
      flags,
      handler,
      // Carried through so --help can render the [read]/[write]/[send] scope
      // badge (design §7.2). Legacy hand-written entries have no scope; only
      // generated entries carry it.
      scope: verb.scope,
    };
    if (positional.length > 0) cmd.positional = positional;
    if (verb.examples.length > 0) cmd.examples = verb.examples;
    return cmd;
  });
}
