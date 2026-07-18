// src/commands/index.ts
//
// Catalog-as-data: each command is a row. Adding a new command = appending
// to this array. Dispatch reads `path` and routes; never switch on name.
//
// Agent-readable help (C4 / KEH-118): every command carries `examples`
// (>=1 - enforced by help.test.ts) and its flags/positionals carry a type
// (`string` | `number` | `bool` | `string[]`) so `arcops <verb> --help` can
// show an agent what each argument takes without reading source. A bare
// string entry (e.g. `'output'`) defaults to type `string`.

import * as attribution from './attribution';
import * as auth from './auth';
import * as campaign from './campaign';
import * as customer from './customer';
import * as directory from './directory';
import * as events from './events';
import * as funnel from './funnel';
import * as gsc from './gsc';
import * as inbox from './inbox';
import * as overview from './overview';
import * as profile from './profile';
import * as revenue from './revenue';
import * as site from './site';
import * as template from './template';
import * as traffic from './traffic';
import * as verbsCmd from './verbs';
import * as webhook from './webhook';
import type { VerbScope } from '../verbs/registry';
import { VERBS } from '../verbs/registry';
import { generateCommandDefs } from '../verbs/to-cli';

export type CommandHandler = (args: Record<string, string>) => Promise<void> | void;

export type FlagType = 'string' | 'number' | 'bool' | 'string[]';

// A flag is either a bare name (defaults to `string`) or `{ name, type }` for
// non-string flags. `bool` = a switch that takes no value; `string[]` = a
// repeatable flag (`--attach`); `number` = numeric value (`--days`, `--limit`).
export type FlagSpec = string | { name: string; type?: FlagType };

export type PositionalSpec = string | { name: string; type?: 'string' | 'number' };

export type CommandDef = {
  path: string[];           // e.g. ['auth', 'login']
  summary: string;
  flags?: FlagSpec[];         // documented option names (with optional type)
  positional?: PositionalSpec[];  // documented positional names (with optional type)
  examples?: string[];        // >=1 example invocation, without the `arcops ` prefix
  handler: CommandHandler;
  // C2/KEH-150: scope badge source for --help (design §7.2). Present on
  // generated commands (from the registry); legacy hand-written entries leave
  // it unset. Non-enforced for local verbs (design §5.1).
  scope?: VerbScope;
};

// Accessors that normalize bare-string specs to `{ name, type }` for renderers.
export function flagName(f: FlagSpec): string {
  return typeof f === 'string' ? f : f.name;
}
export function flagType(f: FlagSpec): FlagType {
  return typeof f === 'string' ? 'string' : f.type ?? 'string';
}
export function positionalName(p: PositionalSpec): string {
  return typeof p === 'string' ? p : p.name;
}
export function positionalType(p: PositionalSpec): 'string' | 'number' {
  return typeof p === 'string' ? 'string' : p.type ?? 'string';
}

export const COMMANDS: CommandDef[] = [
  { path: ['auth', 'login'],  summary: 'Save API token to ~/.arcops/credentials.json',
    flags: ['--token', '--api'],
    examples: ['auth login --token ts_abc123'],
    handler: (a) => auth.login({ token: a.token, api: a.api }) },
  { path: ['auth', 'status'], summary: 'Show current auth state',
    flags: ['--output'],
    examples: ['auth status --output json'],
    handler: (a) => auth.status({ token: a.token, api: a.api, output: a.output }) },
  { path: ['auth', 'logout'], summary: 'Clear stored credentials',
    examples: ['auth logout'],
    handler: () => auth.logout() },
  { path: ['site', 'ls'], summary: 'List all sites',
    flags: ['--output'],
    examples: ['site ls'],
    handler: (a) => site.ls(a) },
  { path: ['overview'], summary: 'Show overview analytics',
    flags: ['--output', { name: '--days', type: 'number' }],
    examples: ['overview --days 30'],
    handler: (a) => overview.overview({ token: a.token, api: a.api, output: a.output, days: a.days }) },
  { path: ['site', 'show'], summary: 'Show a single site',
    positional: ['site'],
    flags: ['--output'],
    examples: ['site show acme.com'],
    handler: (a) => site.show(a) },
  { path: ['site', 'profile'], summary: 'Show the site marketing profile',
    positional: ['site'],
    flags: ['--output'],
    examples: ['site profile acme.com'],
    handler: (a) => profile.show({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['site', 'submissions'], summary: 'Show directory submission status (with tracked UTM URLs)',
    positional: ['site'],
    flags: ['--output'],
    examples: ['site submissions acme.com'],
    handler: (a) => directory.submissions({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['directory', 'ls'], summary: 'List the global directory catalog',
    flags: ['--output'],
    examples: ['directory ls'],
    handler: (a) => directory.ls({ token: a.token, api: a.api, output: a.output }) },
  { path: ['revenue'], summary: 'Show revenue analytics',
    positional: ['site'],
    flags: ['--output', { name: '--days', type: 'number' }, '--group-by'],
    examples: ['revenue acme.com --days 30'],
    handler: (a) => revenue.revenue({ site: a.site, days: a.days, group_by: a.group_by, token: a.token, api: a.api, output: a.output }) },
  { path: ['traffic'], summary: 'Show traffic analytics',
    positional: ['site'],
    flags: ['--output', { name: '--days', type: 'number' }, '--group-by'],
    examples: ['traffic acme.com --days 7 --group-by day'],
    handler: (a) => traffic.traffic({ site: a.site, days: a.days, group_by: a.group_by, token: a.token, api: a.api, output: a.output }) },
  { path: ['campaign', 'ls'], summary: 'List campaigns for a site',
    positional: ['site'],
    flags: ['--output'],
    examples: ['campaign ls acme.com'],
    handler: (a) => campaign.ls({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['campaign', 'show'], summary: 'Show a campaign',
    positional: ['site', { name: 'id', type: 'number' }],
    flags: ['--output'],
    examples: ['campaign show acme.com 42'],
    handler: (a) => campaign.show({ site: a.site, id: a.id, token: a.token, api: a.api, output: a.output }) },
  { path: ['campaign', 'create'], summary: 'Create tracked campaign URL',
    positional: ['site'],
    flags: ['--source', '--medium', '--campaign', '--term', '--content', '--dest', '--name', '--output'],
    examples: ['campaign create acme.com --source newsletter --campaign july --dest https://acme.com/july'],
    handler: (a) => campaign.create({ site: a.site, source: a.source, medium: a.medium, campaign: a.campaign, term: a.term, content: a.content, dest: a.dest, name: a.name, token: a.token, api: a.api, output: a.output }) },
  { path: ['funnel', 'ls'], summary: 'List funnels for a site',
    positional: ['site'],
    flags: ['--output'],
    examples: ['funnel ls acme.com'],
    handler: (a) => funnel.ls({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['funnel', 'show'], summary: 'Show a funnel',
    positional: ['site', { name: 'id', type: 'number' }],
    flags: ['--output'],
    examples: ['funnel show acme.com 3'],
    handler: (a) => funnel.show({ site: a.site, id: a.id, token: a.token, api: a.api, output: a.output }) },
  { path: ['gsc', 'query'], summary: 'GSC top queries (use --page to verify cannibalization)',
    positional: ['site'], flags: [{ name: '--days', type: 'number' }, { name: '--limit', type: 'number' }, '--page', '--output'],
    examples: ['gsc query acme.com --days 28 --limit 50'],
    handler: (a) => gsc.query({ site: a.site, days: a.days, limit: a.limit, page: a.page, token: a.token, api: a.api, output: a.output }) },
  { path: ['gsc', 'page'], summary: 'GSC top pages',
    positional: ['site'], flags: [{ name: '--days', type: 'number' }, { name: '--limit', type: 'number' }, '--output'],
    examples: ['gsc page acme.com --limit 20'],
    handler: (a) => gsc.page({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
  { path: ['gsc', 'country'], summary: 'GSC top countries',
    positional: ['site'], flags: [{ name: '--days', type: 'number' }, { name: '--limit', type: 'number' }, '--output'],
    examples: ['gsc country acme.com --days 28'],
    handler: (a) => gsc.country({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
  { path: ['customer', 'ls'], summary: 'List customers',
    positional: ['site'], flags: ['--output'],
    examples: ['customer ls acme.com'],
    handler: (a) => customer.ls({ site: a.site, 'min-ltv': a['min-ltv'], token: a.token, api: a.api, output: a.output }) },
  { path: ['attribution', 'diag'], summary: 'Attribution coverage health for a site',
    positional: ['site'], flags: ['--output'],
    examples: ['attribution diag acme.com'],
    handler: (a) => attribution.diag({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['attribution', 'backfill'], summary: 'Retroactive first-touch UTM for unattributed customers',
    positional: ['site'], flags: [{ name: '--limit', type: 'number' }, { name: '--all', type: 'bool' }, '--output'],
    examples: ['attribution backfill acme.com --all'],
    handler: (a) => attribution.backfill({ site: a.site, limit: a.limit, all: a.all, token: a.token, api: a.api, output: a.output }) },

  // ── Inbox lifecycle (read / snooze / assign / archive / draft / reply) ──
  { path: ['inbox', 'ls'], summary: 'List inbox threads (cursor-paginated via --cursor)',
    positional: ['site'],
    flags: [{ name: '--unread', type: 'bool' }, '--status', '--assignee', { name: '--unassigned', type: 'bool' }, '--from', '--search', { name: '--limit', type: 'number' }, '--cursor', '--output'],
    examples: ['inbox ls acme.com --unread --limit 50', 'inbox ls acme.com --cursor <next_cursor>'],
    handler: (a) => inbox.ls(a) },
  { path: ['inbox', 'show'], summary: 'Show thread + messages (does not mark read; use `inbox read`)',
    positional: ['site', { name: 'thread-id', type: 'number' }], flags: ['--output'],
    examples: ['inbox show acme.com 123'],
    handler: (a) => inbox.show(a) },
  { path: ['inbox', 'read'], summary: 'Mark thread as read (clears unread_for_ops)',
    positional: ['site', { name: 'thread-id', type: 'number' }],
    examples: ['inbox read acme.com 123'],
    handler: (a) => inbox.read(a) },
  { path: ['inbox', 'snooze'], summary: 'Snooze thread until --until (3d / tomorrow / ISO)',
    positional: ['site', { name: 'thread-id', type: 'number' }], flags: ['--until'],
    examples: ['inbox snooze acme.com 123 --until 3d'],
    handler: (a) => inbox.snooze(a) },
  { path: ['inbox', 'assign'], summary: 'Assign thread to operator email',
    positional: ['site', { name: 'thread-id', type: 'number' }], flags: ['--to'],
    examples: ['inbox assign acme.com 123 --to ops@acme.com'],
    handler: (a) => inbox.assign(a) },
  { path: ['inbox', 'unassign'], summary: 'Clear thread assignee',
    positional: ['site', { name: 'thread-id', type: 'number' }],
    examples: ['inbox unassign acme.com 123'],
    handler: (a) => inbox.unassign(a) },
  { path: ['inbox', 'archive'], summary: 'Archive (close) an inbox thread',
    positional: ['site', { name: 'thread-id', type: 'number' }],
    examples: ['inbox archive acme.com 123'],
    handler: (a) => inbox.archive(a) },
  { path: ['inbox', 'unarchive'], summary: 'Reopen a closed thread',
    positional: ['site', { name: 'thread-id', type: 'number' }],
    examples: ['inbox unarchive acme.com 123'],
    handler: (a) => inbox.unarchive(a) },
  { path: ['inbox', 'reply'], summary: 'Send reply (send scope; preview + typed-confirm unless --yes)',
    positional: ['site', { name: 'thread-id', type: 'number' }],
    flags: ['--body', '--body-file', '--template', { name: '--attach', type: 'string[]' }, { name: '--quote', type: 'bool' }, { name: '--yes', type: 'bool' }, '--idempotency-key'],
    examples: ['inbox reply acme.com 123 --body "Thanks for reaching out." --yes'],
    handler: (a) => inbox.reply(a) },
  { path: ['inbox', 'send'], summary: 'Send a new email - creates a fresh thread (send scope)',
    positional: ['site'],
    flags: ['--to', '--cc', '--subject', '--from', '--body', '--body-file', '--template', { name: '--attach', type: 'string[]' }, { name: '--yes', type: 'bool' }, '--output', '--idempotency-key'],
    examples: ['inbox send acme.com --to jane@example.com --subject "Hello" --body "Hi Jane" --yes'],
    handler: (a) => inbox.send(a) },
  { path: ['inbox', 'draft', 'create'], summary: 'Save a draft reply',
    positional: ['site', { name: 'thread-id', type: 'number' }],
    flags: ['--body', '--body-file', '--template', { name: '--quote', type: 'bool' }],
    examples: ['inbox draft create acme.com 123 --body "Drafting a reply."'],
    handler: (a) => inbox.draft.create(a) },
  { path: ['inbox', 'draft', 'ls'], summary: 'List pending drafts on a thread',
    positional: ['site', { name: 'thread-id', type: 'number' }], flags: ['--output'],
    examples: ['inbox draft ls acme.com 123'],
    handler: (a) => inbox.draft.ls(a) },
  { path: ['inbox', 'draft', 'show'], summary: 'Print a draft body',
    positional: ['site', { name: 'thread-id', type: 'number' }, { name: 'draft-id', type: 'number' }], flags: ['--output'],
    examples: ['inbox draft show acme.com 123 5'],
    handler: (a) => inbox.draft.show(a) },
  { path: ['inbox', 'draft', 'send'], summary: 'Promote a draft to an outbound reply (send scope)',
    positional: ['site', { name: 'thread-id', type: 'number' }, { name: 'draft-id', type: 'number' }], flags: [{ name: '--yes', type: 'bool' }, '--idempotency-key'],
    examples: ['inbox draft send acme.com 123 5 --yes'],
    handler: (a) => inbox.draft.send(a) },
  { path: ['inbox', 'draft', 'rm'], summary: 'Discard a draft',
    positional: ['site', { name: 'thread-id', type: 'number' }, { name: 'draft-id', type: 'number' }],
    examples: ['inbox draft rm acme.com 123 5'],
    handler: (a) => inbox.draft.rm(a) },

  // ── Events & webhooks (S8d-2 product surface) ──
  { path: ['webhook', 'ls'], summary: 'List webhook endpoints',
    flags: ['--output'],
    examples: ['webhook ls'],
    handler: (a) => webhook.ls(a) },
  { path: ['webhook', 'create'], summary: 'Create a webhook endpoint (signing secret shown once)',
    flags: ['--name', '--url', { name: '--event', type: 'string[]' }, '--site-filter', '--output'],
    examples: ['webhook create --name my-agent --url https://agent.example.com/arcops --event "inbox.*"'],
    handler: (a) => webhook.create(a) },
  { path: ['webhook', 'update'], summary: 'Update a webhook endpoint (name/url/events/status/secret rotation)',
    positional: ['endpoint'],
    flags: ['--name', '--url', { name: '--event', type: 'string[]' }, '--site-filter', '--status', { name: '--rotate-secret', type: 'bool' }, '--output'],
    examples: ['webhook update we_abc --status active', 'webhook update we_abc --rotate-secret'],
    handler: (a) => webhook.update(a) },
  { path: ['webhook', 'rm'], summary: 'Delete a webhook endpoint',
    positional: ['endpoint'],
    flags: ['--output'],
    examples: ['webhook rm we_abc'],
    handler: (a) => webhook.rm(a) },
  { path: ['webhook', 'test'], summary: 'Fire a real ping event at an endpoint (exits non-zero on failure)',
    positional: ['endpoint'],
    flags: ['--output'],
    examples: ['webhook test we_abc'],
    handler: (a) => webhook.test(a) },
  { path: ['webhook', 'deliveries'], summary: 'Per-endpoint delivery log (cursor-paginated via --cursor)',
    positional: ['endpoint'],
    flags: ['--status', { name: '--limit', type: 'number' }, '--cursor', '--output'],
    examples: ['webhook deliveries we_abc --status dead'],
    handler: (a) => webhook.deliveries(a) },
  { path: ['events', 'ls'], summary: 'List outbound events (cursor-paginated via --cursor)',
    flags: ['--type', { name: '--site', type: 'number' }, '--since', { name: '--limit', type: 'number' }, '--cursor', '--output'],
    examples: ['events ls --type inbox.message.received --limit 20'],
    handler: (a) => events.ls(a) },
  { path: ['events', 'show'], summary: 'Show one event with its deliveries',
    positional: ['event'],
    flags: ['--output'],
    examples: ['events show evt_abc'],
    handler: (a) => events.show(a) },
  { path: ['events', 'replay'], summary: 'Re-arm a failed/dead delivery (runner picks it up next tick)',
    positional: [{ name: 'delivery-id', type: 'number' }],
    flags: ['--output'],
    examples: ['events replay 1234'],
    handler: (a) => events.replay(a) },

  // ── Templates (~/.arcops/templates/<name>.md) ──
  { path: ['template', 'ls'], summary: 'List reply templates in ~/.arcops/templates',
    flags: ['--output'],
    examples: ['template ls'],
    handler: (a) => template.ls({ output: a.output }) },
  { path: ['template', 'show'], summary: 'Print a template body',
    positional: ['name'], flags: ['--output'],
    examples: ['template show welcome'],
    handler: (a) => template.show({ name: a.name, output: a.output }) },
  { path: ['template', 'edit'], summary: 'Open template in $EDITOR (creates if missing)',
    positional: ['name'],
    examples: ['template edit welcome'],
    handler: (a) => template.edit({ name: a.name }) },

  // ── Capability discovery (C2/KEH-150, design §5.3) ──
  { path: ['verbs'], summary: 'Print the verb registry (use --json for machine-readable catalog)',
    flags: [{ name: '--json', type: 'bool' }, '--output'],
    examples: ['verbs --json'],
    handler: (a) => verbsCmd.verbs({ json: a.json, output: a.output }) },
];

// ── C2/KEH-150 Phase 2 coexistence (design §6.2) ──────────────────────
// The registry (`VERBS`) is the authoritative verb contract; the generator
// turns it into a `CommandDef[]` that must be structurally equivalent to the
// legacy hand-written `COMMANDS` above. registry-consistency.test.ts asserts
// that equivalence. Both catalogs are mounted in dispatch with generated
// entries taking precedence on path collisions; legacy display order is
// preserved so root help is unchanged apart from the new scope badge.

// Phase 2 handler bridge: generated commands reuse the exact legacy handler
// closures (design §5.1 - handlers stay hand-written). This keeps runtime
// behavior identical while the registry owns command structure. Phase 3 will
// extract handlers into a dedicated module and drop legacy `COMMANDS`.
export const HANDLERS: Record<string, CommandHandler> = {};
for (const c of COMMANDS) HANDLERS[c.path.join(':')] = c.handler;

export const GENERATED_COMMANDS: CommandDef[] = generateCommandDefs(VERBS, HANDLERS);

// Merge generated + legacy. Generated wins on path collision; legacy order is
// kept (so `arcops --help` reads in the same order); generated-only entries
// (none today - `verbs` is in both) append at the end.
export const DISPATCH_COMMANDS: CommandDef[] = mergeByPath(GENERATED_COMMANDS, COMMANDS);

function mergeByPath(generated: CommandDef[], legacy: CommandDef[]): CommandDef[] {
  const genByPath = new Map<string, CommandDef>();
  for (const c of generated) genByPath.set(c.path.join('\0'), c);
  const out: CommandDef[] = [];
  const seen = new Set<string>();
  for (const c of legacy) {
    const key = c.path.join('\0');
    out.push(genByPath.get(key) ?? c);   // generated takes precedence
    seen.add(key);
  }
  for (const c of generated) {
    const key = c.path.join('\0');
    if (!seen.has(key)) { out.push(c); seen.add(key); }
  }
  return out;
}
