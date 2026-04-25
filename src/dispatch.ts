// src/dispatch.ts
import { COMMANDS, type CommandDef } from './commands';
import { error, info } from './output';
import { VERSION } from './version';

// Trie router. Walk argv tokens, longest-prefix match against COMMANDS[].path.
// Intermediate nodes (e.g. `ts auth` with no verb) print sub-command list.

type ParsedArgv = { tokens: string[]; flags: Record<string, string> };

export function parseArgv(argv: string[]): ParsedArgv {
  const tokens: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) flags[a.slice(2)] = 'true';
        else { flags[a.slice(2)] = next; i++; }
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
  for (const c of COMMANDS) {
    const n = c.path.length;
    if (tokens.length < n) continue;
    let match = true;
    for (let i = 0; i < n; i++) if (tokens[i] !== c.path[i]) { match = false; break; }
    if (match && n > depth) { best = c; depth = n; }
  }
  return { cmd: best, depth };
}

function listChildren(prefix: string[]): CommandDef[] {
  return COMMANDS.filter(c =>
    c.path.length > prefix.length &&
    prefix.every((t, i) => c.path[i] === t)
  );
}

export async function dispatch(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.flags.version || (argv.length === 1 && argv[0] === '--version')) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (parsed.tokens.length === 0 || parsed.flags.help) {
    printRoot();
    return 0;
  }

  const { cmd, depth } = findCommand(parsed.tokens);
  if (!cmd) {
    // Maybe an intermediate node like `ts auth`
    const children = listChildren(parsed.tokens);
    if (children.length > 0) {
      info(`Subcommands of \`ts ${parsed.tokens.join(' ')}\`:`);
      for (const c of children) info(`  ${c.path.slice(parsed.tokens.length).join(' ').padEnd(20)} ${c.summary}`);
      return 0;
    }
    error(`Unknown command: ${parsed.tokens.join(' ')}`);
    info('Run `ts --help` for the full command list.');
    return 2;
  }

  const positional = parsed.tokens.slice(depth);
  const args: Record<string, string> = { ...parsed.flags };
  // Bind positionals by name from cmd.positional (if any)
  if (cmd.positional) {
    for (let i = 0; i < cmd.positional.length && i < positional.length; i++) {
      args[cmd.positional[i]] = positional[i];
    }
  }

  try {
    await cmd.handler(args);
    return 0;
  } catch (e) {
    error((e as Error).message);
    return 1;
  }
}

function printRoot() {
  process.stderr.write(`ts — traffic-source CLI v${VERSION}\n\n`);
  process.stderr.write(`Usage: ts <command> [args] [--flags]\n\nCommands:\n`);
  // Render from catalog (single source of truth).
  for (const c of COMMANDS) {
    process.stderr.write(`  ${c.path.join(' ').padEnd(28)} ${c.summary}\n`);
  }
  process.stderr.write(`\nGlobal flags: --token, --api, --output text|json, --help, --version\n`);
}
