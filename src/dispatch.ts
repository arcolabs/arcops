// src/dispatch.ts
import pc from 'picocolors';
import {
  DISPATCH_COMMANDS, type CommandDef,
  flagName, flagType, positionalName, positionalType,
} from './commands';
import { error, info, emitError, colorOn } from './output';
import { VERSION } from './version';

// Trie router. Walk argv tokens, longest-prefix match against COMMANDS[].path.
// Intermediate nodes (e.g. `arcops auth` with no verb) print sub-command list.

type ParsedArgv = { tokens: string[]; flags: Record<string, string> };

// CLI flag convention is kebab (--group-by, --body-file). Expose the value
// under both the original kebab key and a snake alias so handlers can read
// either form - server query params are snake (group_by, body_file).
//
// Flags listed in REPEATABLE accumulate across occurrences; values get joined
// by NUL (\0). NUL is forbidden in POSIX paths so it round-trips unambiguously
// for filename-bearing flags like --attach (which can carry spaces).
const REPEATABLE = new Set(['attach', 'event']);
const REPEATABLE_SEP = '\0';

function setFlag(flags: Record<string, string>, key: string, value: string) {
  if (REPEATABLE.has(key) && flags[key] !== undefined) {
    flags[key] = flags[key] + REPEATABLE_SEP + value;
  } else {
    flags[key] = value;
  }
  if (key.includes('-')) flags[key.replace(/-/g, '_')] = flags[key];
}

// Helper for handlers reading a repeatable flag back as an array.
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(REPEATABLE_SEP);
}

export function parseArgv(argv: string[]): ParsedArgv {
  const tokens: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        setFlag(flags, a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) setFlag(flags, a.slice(2), 'true');
        else { setFlag(flags, a.slice(2), next); i++; }
      }
    } else {
      tokens.push(a);
    }
  }
  return { tokens, flags };
}

function findCommand(tokens: string[]): { cmd?: CommandDef; depth: number } {
  let best: CommandDef | undefined;
  let depth = 0;
  for (const c of DISPATCH_COMMANDS) {
    const n = c.path.length;
    if (tokens.length < n) continue;
    let match = true;
    for (let i = 0; i < n; i++) if (tokens[i] !== c.path[i]) { match = false; break; }
    if (match && n > depth) { best = c; depth = n; }
  }
  return { cmd: best, depth };
}

function listChildren(prefix: string[]): CommandDef[] {
  return DISPATCH_COMMANDS.filter(c =>
    c.path.length > prefix.length &&
    prefix.every((t, i) => c.path[i] === t)
  );
}

// Flags that work on every command (parsed by resolveAuth / detectOutputFormat,
// not bound per-handler). Hidden from the per-command flag list so verb help
// doesn't duplicate them under "Flags" - they're summarized in the Global line.
const GLOBAL_FLAG_NAMES = new Set(['--output', '--token', '--api']);

export async function dispatch(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.flags.version || (argv.length === 1 && argv[0] === '--version')) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }

  // --help is explicit reference output -> stdout (capturable by agents / pipes,
  // consistent with --version). Matched verb -> verb help; intermediate node ->
  // its subcommands; otherwise -> root help.
  if (parsed.flags.help) {
    const { cmd } = findCommand(parsed.tokens);
    if (cmd) {
      process.stdout.write(renderVerbHelp(cmd));
      return 0;
    }
    const children = listChildren(parsed.tokens);
    if (parsed.tokens.length > 0 && children.length > 0) {
      process.stdout.write(renderSubcommands(parsed.tokens, children));
      return 0;
    }
    process.stdout.write(renderRoot(false));
    return 0;
  }

  if (parsed.tokens.length === 0) {
    printRoot();
    return 0;
  }

  const { cmd, depth } = findCommand(parsed.tokens);
  if (!cmd) {
    // Maybe an intermediate node like `arcops auth`
    const children = listChildren(parsed.tokens);
    if (children.length > 0) {
      info(`Subcommands of \`arcops ${parsed.tokens.join(' ')}\`:`);
      for (const c of children) info(`  ${c.path.slice(parsed.tokens.length).join(' ').padEnd(20)} ${c.summary}`);
      return 0;
    }
    error(`Unknown command: ${parsed.tokens.join(' ')}`);
    info('Run `arcops --help` for the full command list.');
    return 2;
  }

  const positional = parsed.tokens.slice(depth);
  const args: Record<string, string> = { ...parsed.flags };
  // Bind positionals by name from cmd.positional (if any)
  if (cmd.positional) {
    for (let i = 0; i < cmd.positional.length && i < positional.length; i++) {
      args[positionalName(cmd.positional[i])] = positional[i];
    }
  }

  try {
    await cmd.handler(args);
    return 0;
  } catch (e) {
    // Agent-first error rendering (contract item 2): JSON envelope on stderr
    // in pipe/--output json mode, human `✖ <msg>` line in TTY. Never a bare
    // status / undefined. Non-zero exit is the contract item 1 guarantee.
    emitError(e, parsed.flags.output);
    return 1;
  }
}

// Agent-readable per-verb help (C4 / KEH-118). Returns the full text so it can
// be written to stdout (dispatch) or asserted on (tests). Layout:
//   arcops <path> - <summary>
//   Usage: arcops <path> [positionals] [flags]
//   Positionals: <name>  <type>
//   Flags:       --<name> <type>     (command-specific; globals omitted)
//   Examples:    $ arcops <example>
//   Global flags: ...
export function renderVerbHelp(cmd: CommandDef): string {
  const out: string[] = [];
  const title = `arcops ${cmd.path.join(' ')}`;
  // C2/KEH-150 (design §7.2): annotate the required scope as a [read]/[write]/
  // [send] badge. Generated commands carry scope; legacy entries do not.
  const scopeTag = cmd.scope ? `  [${cmd.scope}]` : '';
  out.push(`${title} - ${cmd.summary}${scopeTag}`);
  out.push('');

  const posPart = (cmd.positional ?? []).map((p) => `<${positionalName(p)}>`).join(' ');
  out.push(`Usage: ${title}${posPart ? ' ' + posPart : ''} [flags]`);
  out.push('');

  if (cmd.positional && cmd.positional.length) {
    out.push('Positionals:');
    const rows = cmd.positional.map((p) => [`  ${positionalName(p)}`, positionalType(p)]);
    const w = Math.max(...rows.map((r) => r[0].length));
    for (const [n, t] of rows) out.push(`${n.padEnd(w)}  ${t}`);
    out.push('');
  }

  const flags = (cmd.flags ?? []).filter((f) => !GLOBAL_FLAG_NAMES.has(flagName(f)));
  if (flags.length) {
    out.push('Flags:');
    const rows = flags.map((f) => [`  ${flagName(f)}`, flagType(f)]);
    const w = Math.max(...rows.map((r) => r[0].length));
    for (const [n, t] of rows) out.push(`${n.padEnd(w)}  ${t}`);
    out.push('');
  }

  if (cmd.examples && cmd.examples.length) {
    out.push('Examples:');
    for (const ex of cmd.examples) out.push(`  $ arcops ${ex}`);
    out.push('');
  }

  out.push('Global flags: --token, --api, --output text|json, --help, --version');
  out.push('');
  return out.join('\n');
}

function renderSubcommands(prefix: string[], children: CommandDef[]): string {
  const out: string[] = [];
  out.push(`Subcommands of \`arcops ${prefix.join(' ')}\`:`);
  for (const c of children) {
    out.push(`  ${c.path.slice(prefix.length).join(' ').padEnd(20)} ${c.summary}`);
  }
  out.push('');
  out.push('Global flags: --token, --api, --output text|json, --help, --version');
  out.push('');
  return out.join('\n');
}

// Render root help as a string (single source of truth for both the no-args
// stderr prompt and `arcops --help` stdout). `colored` is true only for the
// stderr no-args path - stdout is never colored (output discipline).
function renderRoot(colored: boolean): string {
  const dim = (s: string) => (colored ? pc.dim(s) : s);
  const out: string[] = [];
  const line = '─'.repeat(50);
  out.push('');
  if (colored) {
    out.push(`${pc.cyan('arcops')} ${pc.dim('- indie SaaS ops cockpit')} ${pc.dim(`v${VERSION}`)}`);
  } else {
    out.push(`arcops - indie SaaS ops cockpit v${VERSION}`);
  }
  out.push(line);
  out.push(`${dim('Usage:')} arcops <command> [args] [--flags]`);
  out.push('');
  // Render from catalog (single source of truth).
  out.push(dim('Commands:'));
  for (const c of DISPATCH_COMMANDS) {
    const badge = c.scope ? ` ${dim(`[${c.scope}]`)}` : '';
    out.push(`  ${c.path.join(' ').padEnd(28)} ${dim(c.summary)}${badge}`);
  }
  out.push('');
  out.push(`Global flags: ${dim('--token, --api, --output text|json, --help, --version')}`);
  return out.join('\n') + '\n';
}

function printRoot() {
  process.stderr.write(renderRoot(colorOn));
}
