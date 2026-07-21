// src/verbs/registry.ts
//
// C2 / KEH-150 - Verb Registry: the authoritative description of every arcops
// operation. Authored as data, read as code. Three consumers assemble from it:
//   1. CLI command tree + --help (src/verbs/to-cli.ts -> src/dispatch.ts)
//   2. MCP tools/list + tools/call (server repo, build-time)
//   3. `arcops verbs --json` capability discovery (src/commands/verbs.ts)
//
// Design: docs/design/verb-registry.md. Phase 2 (this issue): the registry
// coexists with the legacy hand-written `COMMANDS` catalog in
// src/commands/index.ts. registry-consistency.test.ts asserts the two are
// structurally equivalent so Phase 3 (legacy removal) is a behavior-no-op.
//
// The registry owns names, parameters, scope, idempotency and output-shape
// pointers. It does NOT own presentation (CLI tables / human copy), interactive
// guardrails, or server-side business logic (design §2).

export type ArgType = 'string' | 'number' | 'boolean' | 'enum' | 'string[]';

export type VerbArg = {
  name: string;                 // canonical identifier, snake_case
  cliName?: string;             // kebab-case override, e.g. 'body-file'
  type: ArgType;
  required?: boolean;
  positional?: boolean;         // true => bound by order, not --flag
  repeatable?: boolean;         // true => flag may appear multiple times
  enum?: string[];              // required when type === 'enum'
  cliOnly?: boolean;            // true => CLI-only flag (e.g. --yes); never exposed to MCP
  description: string;          // used in --help and MCP tool description
};

export type HttpMapping = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                 // /api/sites/:siteId/analytics/revenue
  query?: string[];             // arg names serialized to query string
  body?: string[];              // arg names sent as JSON body
};

export type VerbScope = 'read' | 'write' | 'send';

export type VerbDef = {
  id: string;                   // stable, namespaced, e.g. 'revenue', 'inbox:reply'
  name: string;                 // human title
  summary: string;              // one-line for CLI help (mirrors legacy CommandDef.summary)
  description?: string;         // longer prose for MCP / SKILL.md
  scope: VerbScope;
  idempotent: boolean;          // C1: drives Idempotency-Key behavior (design §4.3)
  // C1/KEH-116: verb plumbs an `Idempotency-Key` so the server dedupes retries
  // of the same logical write instead of dispatching a second side effect. Only
  // the send-class verbs (inbox:send / inbox:reply / inbox:draft:send) accept a
  // key; `--idempotency-key` is the CLI override, the client auto-derives one.
  supportsIdempotencyKey?: boolean;
  args: VerbArg[];
  examples: string[];           // >=1 example invocation (without the `arcops ` prefix); mirrors legacy
  local?: boolean;              // true => no HTTP call; handled entirely in CLI
  http?: HttpMapping;           // required unless local === true
  outputShape: string;          // pointer to a TypeScript type name (design §4.2); 'unknown' / 'void' allowed
};

// Invariant enforced by registry-consistency.test.ts (design §4):
//   (local === true && http === undefined) XOR (local !== true && http !== undefined)
// A verb is either remote (has an HTTP mapping) or local (handled by the CLI).

// Flags that are CLI control-plane only: they configure the client (--token /
// --api / --output), gate interactive confirms (--yes), override the derived
// idempotency key (--idempotency-key), or select verbs-output (--json). They
// never become API body/query params and never appear in the MCP input schema.
const CLI_ONLY_ARGS = new Set(['token', 'api', 'output', 'yes', 'idempotency_key', 'json']);
export function isCliOnlyArg(name: string): boolean {
  return CLI_ONLY_ARGS.has(name);
}

export const VERBS: VerbDef[] = [
  // ── Auth (local: read/write ~/.arcops/credentials.json) ───────────────
  {
    id: 'auth:login',
    name: 'Log in',
    summary: 'Save API token to ~/.arcops/credentials.json',
    scope: 'write',
    idempotent: true,
    local: true,
    args: [
      { name: 'token', type: 'string', required: true, cliOnly: true, description: 'API token (ts_…).' },
      { name: 'api', type: 'string', cliOnly: true, description: 'API base URL override.' },
    ],
    examples: ['auth login --token ts_abc123'],
    outputShape: 'void',
  },
  {
    id: 'auth:status',
    name: 'Auth status',
    summary: 'Show current auth state',
    scope: 'read',
    idempotent: true,
    local: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['auth status --output json'],
    outputShape: 'void',
  },
  {
    id: 'auth:logout',
    name: 'Log out',
    summary: 'Clear stored credentials',
    scope: 'write',
    idempotent: true,
    local: true,
    args: [],
    examples: ['auth logout'],
    outputShape: 'void',
  },

  // ── Sites / overview ─────────────────────────────────────────────────
  {
    id: 'site:ls',
    name: 'List sites',
    summary: 'List all sites',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['site ls'],
    http: { method: 'GET', path: '/api/sites' },
    outputShape: 'SitesResponse',
  },
  {
    id: 'overview',
    name: 'Overview analytics',
    summary: 'Show overview analytics',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
      { name: 'days', type: 'number', description: 'Trailing window in days.' },
    ],
    examples: ['overview --days 30'],
    http: { method: 'GET', path: '/api/overview', query: ['days'] },
    outputShape: 'OverviewResponse',
  },
  {
    id: 'site:show',
    name: 'Show site',
    summary: 'Show a single site',
    description:
      'Shows a single site (id, domain, integration fields) plus `embed_snippet`: the ' +
      'copy-pasteable first-party tracking tag `<script src="<api>/t.js" data-site="<id>" ' +
      'defer></script>` for the site\'s <head> (KEH-201). The collector script reads ' +
      '`data-site` and POSTs pageviews/events to /api/collect; the snippet src follows the ' +
      'resolved API base (`--api` / ARCOPS_API).',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['site show acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId' },
    outputShape: 'unknown',
  },
  {
    id: 'site:profile',
    name: 'Site marketing profile',
    summary: 'Show the site marketing profile',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['site profile acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId/profile' },
    outputShape: 'unknown',
  },
  {
    id: 'site:submissions',
    name: 'Directory submissions',
    summary: 'Show directory submission status (with tracked UTM URLs)',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['site submissions acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId/submissions' },
    outputShape: 'unknown',
  },
  {
    id: 'site:create',
    name: 'Create site',
    summary: 'Create a site in your org',
    description:
      'Creates a site in the caller\'s organization via the public collection endpoint ' +
      '(POST /api/sites). The server stamps org_id from the request\'s tenant context (never ' +
      'from input), normalizes the domain (strips scheme + trailing slash), and returns the ' +
      'created site (id, domain, name, org_id). A duplicate domain in the same org is refused ' +
      'with 409. --name is an optional display label; when omitted it defaults to the domain, ' +
      'so `arcops site create acme.com` works as a one-arg command. This is step 1 of the ' +
      'product value path ("connect your first site"). The success output includes the ' +
      'site\'s tracking embed tag (`embed_snippet` in JSON, an `embed:` line in text; KEH-201) - ' +
      'paste it into the site\'s <head> to start first-party collection. Note: this only ' +
      'creates the site row; wiring a data source (Stripe key / GSC) is a separate step.',
    scope: 'write',
    idempotent: false,
    args: [
      { name: 'domain', type: 'string', required: true, positional: true, description: 'New site domain (e.g. acme.com).' },
      { name: 'name', type: 'string', description: 'Display name for the site (defaults to the domain).' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['site create acme.com', 'site create acme.com --name Acme'],
    http: { method: 'POST', path: '/api/sites', body: ['domain', 'name'] },
    outputShape: 'unknown',
  },
  {
    id: 'site:move',
    name: 'Move site between orgs',
    summary: 'Move a site to another organization (human-admin only)',
    description:
      'Re-homes a site (and its site-level integrations) to another organization via the ' +
      'public site-move endpoint (arcops-server #23 / KEH-161). The server requires an ' +
      'IDENTIFIED HUMAN admin: a ts_ token bridged to a Better Auth user who is owner/admin ' +
      'of BOTH the source and target orgs. Org-scoped BA api-keys are refused with 403 ' +
      'move_requires_human_admin (no personal identity to prove dual-admin) - so this verb ' +
      'uses the normal `arcops auth login` human token, not an org-scoped key. Everything ' +
      'keyed by site_id alone (analytics, Stripe, GSC) follows the site automatically; ' +
      'outbound_events history stays attributed to the emitting org. The response reports ' +
      'retired_site_keys: source-org BA keys constrained to this site that are now inert ' +
      '(org mismatch fails closed) - re-issue them under the target org. Not idempotent: a ' +
      'retry after a successful move 422s (already_in_org) or 404s (cross-org from the ' +
      'source token). Gated by a typed confirm (site domain) unless --yes is passed.',
    scope: 'write',
    idempotent: false,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain (must be in your org).' },
      { name: 'to_org', cliName: 'to-org', type: 'string', required: true, description: 'Target organization slug or id (you must be owner/admin).' },
      { name: 'yes', type: 'boolean', cliOnly: true, description: 'Skip the typed confirmation.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['site move acme.com --to-org wodex --yes'],
    http: { method: 'POST', path: '/api/sites/:siteId/move', body: ['target_org'] },
    outputShape: 'unknown',
  },
  {
    id: 'directory:ls',
    name: 'List directory catalog',
    summary: 'List the global directory catalog',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['directory ls'],
    http: { method: 'GET', path: '/api/directories' },
    outputShape: 'unknown',
  },

  // ── Analytics ────────────────────────────────────────────────────────
  {
    id: 'revenue',
    name: 'Revenue analytics',
    summary: 'Show revenue analytics',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
      { name: 'days', type: 'number', description: 'Trailing window in days.' },
      { name: 'group_by', cliName: 'group-by', type: 'string', description: 'Aggregation bucket (day/week/month).' },
    ],
    examples: ['revenue acme.com --days 30'],
    http: { method: 'GET', path: '/api/sites/:siteId/analytics/revenue', query: ['days', 'group_by'] },
    outputShape: 'RevenueResponse',
  },
  {
    id: 'traffic',
    name: 'Traffic analytics',
    summary: 'Show traffic analytics',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
      { name: 'days', type: 'number', description: 'Trailing window in days.' },
      { name: 'group_by', cliName: 'group-by', type: 'string', description: 'Aggregation bucket (day/week/month).' },
    ],
    examples: ['traffic acme.com --days 7 --group-by day'],
    http: { method: 'GET', path: '/api/sites/:siteId/analytics/traffic', query: ['days', 'group_by'] },
    outputShape: 'unknown',
  },

  // ── Campaigns (UTM tracking) ─────────────────────────────────────────
  {
    id: 'campaign:ls',
    name: 'List campaigns',
    summary: 'List campaigns for a site',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['campaign ls acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId/campaigns' },
    outputShape: 'unknown',
  },
  {
    id: 'campaign:show',
    name: 'Show campaign',
    summary: 'Show a campaign',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'id', type: 'number', required: true, positional: true, description: 'Campaign id.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['campaign show acme.com 42'],
    http: { method: 'GET', path: '/api/sites/:siteId/campaigns/:campaignId' },
    outputShape: 'unknown',
  },
  {
    id: 'campaign:create',
    name: 'Create campaign',
    summary: 'Create tracked campaign URL',
    scope: 'write',
    idempotent: false,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'source', type: 'string', description: 'UTM source.' },
      { name: 'medium', type: 'string', description: 'UTM medium (defaults to referral).' },
      { name: 'campaign', type: 'string', description: 'UTM campaign name.' },
      { name: 'term', type: 'string', description: 'UTM term.' },
      { name: 'content', type: 'string', description: 'UTM content.' },
      { name: 'dest', type: 'string', description: 'Destination URL.' },
      { name: 'name', type: 'string', description: 'Campaign label (defaults to source/campaign).' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['campaign create acme.com --source newsletter --campaign july --dest https://acme.com/july'],
    http: { method: 'POST', path: '/api/sites/:siteId/campaigns', body: ['label', 'destination', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] },
    outputShape: 'unknown',
  },

  // ── Funnels ──────────────────────────────────────────────────────────
  {
    id: 'funnel:ls',
    name: 'List funnels',
    summary: 'List funnels for a site',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['funnel ls acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId/funnels' },
    outputShape: 'unknown',
  },
  {
    id: 'funnel:show',
    name: 'Show funnel',
    summary: 'Show a funnel',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'id', type: 'number', required: true, positional: true, description: 'Funnel id.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['funnel show acme.com 3'],
    http: { method: 'GET', path: '/api/sites/:siteId/funnels/:funnelId' },
    outputShape: 'unknown',
  },

  // ── GSC (Google Search Console) ──────────────────────────────────────
  {
    id: 'gsc:query',
    name: 'GSC top queries',
    summary: 'GSC top queries (use --page to verify cannibalization)',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'days', type: 'number', description: 'Trailing window in days.' },
      { name: 'limit', type: 'number', description: 'Max rows to return.' },
      { name: 'page', type: 'string', description: 'Restrict to a single page URL (cannibalization check).' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['gsc query acme.com --days 28 --limit 50'],
    http: { method: 'GET', path: '/api/sites/:siteId/gsc', query: ['dim', 'days', 'limit', 'page'] },
    outputShape: 'unknown',
  },
  {
    id: 'gsc:page',
    name: 'GSC top pages',
    summary: 'GSC top pages',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'days', type: 'number', description: 'Trailing window in days.' },
      { name: 'limit', type: 'number', description: 'Max rows to return.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['gsc page acme.com --limit 20'],
    http: { method: 'GET', path: '/api/sites/:siteId/gsc', query: ['dim', 'days', 'limit'] },
    outputShape: 'unknown',
  },
  {
    id: 'gsc:country',
    name: 'GSC top countries',
    summary: 'GSC top countries',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'days', type: 'number', description: 'Trailing window in days.' },
      { name: 'limit', type: 'number', description: 'Max rows to return.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['gsc country acme.com --days 28'],
    http: { method: 'GET', path: '/api/sites/:siteId/gsc', query: ['dim', 'days', 'limit'] },
    outputShape: 'unknown',
  },

  // ── Customers / attribution ──────────────────────────────────────────
  {
    id: 'customer:ls',
    name: 'List customers',
    summary: 'List customers',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['customer ls acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId/customers' },
    outputShape: 'unknown',
  },
  {
    id: 'attribution:diag',
    name: 'Attribution diagnostics',
    summary: 'Attribution coverage health for a site',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['attribution diag acme.com'],
    http: { method: 'GET', path: '/api/sites/:siteId/attribution-diag' },
    outputShape: 'unknown',
  },
  {
    id: 'attribution:backfill',
    name: 'Attribution backfill',
    summary: 'Retroactive first-touch UTM for unattributed customers',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'limit', type: 'number', description: 'Customers per pass (default 100).' },
      { name: 'all', type: 'boolean', description: 'Loop until the backlog drains.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['attribution backfill acme.com --all'],
    http: { method: 'POST', path: '/api/sites/:siteId/attribution-backfill', query: ['limit'] },
    outputShape: 'unknown',
  },

  // ── Inbox lifecycle (read / snooze / assign / archive / draft / reply) ─
  {
    id: 'inbox:ls',
    name: 'List inbox threads',
    summary: 'List inbox threads (cursor-paginated via --cursor)',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'unread', type: 'boolean', description: 'Only unread threads.' },
      { name: 'status', type: 'string', description: 'Filter by status (open/snoozed/closed).' },
      { name: 'assignee', type: 'string', description: 'Filter by assignee email.' },
      { name: 'unassigned', type: 'boolean', description: 'Only unassigned threads.' },
      { name: 'from', type: 'string', description: 'Filter by participant email.' },
      { name: 'search', type: 'string', description: 'Full-text search.' },
      { name: 'limit', type: 'number', description: 'Page size.' },
      { name: 'cursor', type: 'string', description: 'Opaque next-page cursor from a prior listing.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['inbox ls acme.com --unread --limit 50', 'inbox ls acme.com --cursor <next_cursor>'],
    http: { method: 'GET', path: '/api/sites/:siteId/inbox/threads', query: ['unread', 'status', 'assignee', 'from', 'search', 'limit', 'cursor'] },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:show',
    name: 'Show inbox thread',
    summary: 'Show thread + messages (does not mark read; use `inbox read`)',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['inbox show acme.com 123'],
    http: { method: 'GET', path: '/api/sites/:siteId/inbox/threads/:threadId' },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:read',
    name: 'Mark thread read',
    summary: 'Mark thread as read (clears unread_for_ops)',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
    ],
    examples: ['inbox read acme.com 123'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/mark-read' },
    outputShape: 'void',
  },
  {
    id: 'inbox:snooze',
    name: 'Snooze thread',
    summary: 'Snooze thread until --until (3d / tomorrow / ISO)',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'until', type: 'string', required: true, description: 'Snooze until (3d / tomorrow / ISO 8601).' },
    ],
    examples: ['inbox snooze acme.com 123 --until 3d'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/snooze', body: ['until'] },
    outputShape: 'void',
  },
  {
    id: 'inbox:assign',
    name: 'Assign thread',
    summary: 'Assign thread to operator email',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'to', type: 'string', required: true, description: 'Operator email to assign.' },
    ],
    examples: ['inbox assign acme.com 123 --to ops@acme.com'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/assign', body: ['email'] },
    outputShape: 'void',
  },
  {
    id: 'inbox:unassign',
    name: 'Unassign thread',
    summary: 'Clear thread assignee',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
    ],
    examples: ['inbox unassign acme.com 123'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/assign', body: ['email'] },
    outputShape: 'void',
  },
  {
    id: 'inbox:archive',
    name: 'Archive thread',
    summary: 'Archive (close) an inbox thread',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
    ],
    examples: ['inbox archive acme.com 123'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/close' },
    outputShape: 'void',
  },
  {
    id: 'inbox:unarchive',
    name: 'Reopen thread',
    summary: 'Reopen a closed thread',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
    ],
    examples: ['inbox unarchive acme.com 123'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/open' },
    outputShape: 'void',
  },
  {
    id: 'inbox:reply',
    name: 'Reply to thread',
    summary: 'Send reply (send scope; preview + typed-confirm unless --yes)',
    scope: 'send',
    idempotent: false,
    supportsIdempotencyKey: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'body', type: 'string', description: 'Plain-text reply body.' },
      { name: 'body_file', cliName: 'body-file', type: 'string', description: 'Path to a file containing the body (- for stdin).' },
      { name: 'template', type: 'string', description: 'Name of a local template.' },
      { name: 'attach', type: 'string[]', repeatable: true, description: 'Attachment path; repeat for multiple files.' },
      { name: 'quote', type: 'boolean', description: 'Quote the most recent inbound message inline.' },
      { name: 'yes', type: 'boolean', cliOnly: true, description: 'Skip interactive confirmation.' },
      { name: 'idempotency_key', cliName: 'idempotency-key', type: 'string', cliOnly: true, description: 'Override the derived Idempotency-Key.' },
    ],
    examples: ['inbox reply acme.com 123 --body "Thanks for reaching out." --yes'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/reply', body: ['body'] },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:send',
    name: 'Send new email',
    summary: 'Send a new email - creates a fresh thread (send scope)',
    scope: 'send',
    idempotent: false,
    supportsIdempotencyKey: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'to', type: 'string', required: true, description: 'Comma-separated recipient emails.' },
      { name: 'cc', type: 'string', description: 'Comma-separated CC emails.' },
      { name: 'subject', type: 'string', required: true, description: 'Email subject.' },
      { name: 'from', type: 'string', description: 'Local part of the From address (default support).' },
      { name: 'body', type: 'string', description: 'Plain-text body.' },
      { name: 'body_file', cliName: 'body-file', type: 'string', description: 'Path to a file containing the body (- for stdin).' },
      { name: 'template', type: 'string', description: 'Name of a local template.' },
      { name: 'attach', type: 'string[]', repeatable: true, description: 'Attachment path; repeat for multiple files.' },
      { name: 'yes', type: 'boolean', cliOnly: true, description: 'Skip interactive confirmation.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
      { name: 'idempotency_key', cliName: 'idempotency-key', type: 'string', cliOnly: true, description: 'Override the derived Idempotency-Key.' },
    ],
    examples: ['inbox send acme.com --to jane@example.com --subject "Hello" --body "Hi Jane" --yes'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/send', body: ['to', 'cc', 'subject', 'body', 'from'] },
    outputShape: 'unknown',
  },

  // ── Inbox drafts ─────────────────────────────────────────────────────
  {
    id: 'inbox:draft:create',
    name: 'Create draft',
    summary: 'Save a draft reply',
    scope: 'write',
    idempotent: false,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'body', type: 'string', description: 'Plain-text draft body.' },
      { name: 'body_file', cliName: 'body-file', type: 'string', description: 'Path to a file containing the body (- for stdin).' },
      { name: 'template', type: 'string', description: 'Name of a local template.' },
      { name: 'quote', type: 'boolean', description: 'Quote the most recent inbound message inline.' },
    ],
    examples: ['inbox draft create acme.com 123 --body "Drafting a reply."'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/drafts', body: ['body_text'] },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:draft:ls',
    name: 'List drafts',
    summary: 'List pending drafts on a thread',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['inbox draft ls acme.com 123'],
    http: { method: 'GET', path: '/api/sites/:siteId/inbox/threads/:threadId/drafts' },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:draft:show',
    name: 'Show draft',
    summary: 'Print a draft body',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'draft_id', cliName: 'draft-id', type: 'number', required: true, positional: true, description: 'Draft id.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['inbox draft show acme.com 123 5'],
    http: { method: 'GET', path: '/api/sites/:siteId/inbox/threads/:threadId/drafts/:draftId' },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:draft:send',
    name: 'Send draft',
    summary: 'Promote a draft to an outbound reply (send scope)',
    scope: 'send',
    idempotent: false,
    supportsIdempotencyKey: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'draft_id', cliName: 'draft-id', type: 'number', required: true, positional: true, description: 'Draft id.' },
      { name: 'yes', type: 'boolean', cliOnly: true, description: 'Skip interactive confirmation.' },
      { name: 'idempotency_key', cliName: 'idempotency-key', type: 'string', cliOnly: true, description: 'Override the derived Idempotency-Key.' },
    ],
    examples: ['inbox draft send acme.com 123 5 --yes'],
    http: { method: 'POST', path: '/api/sites/:siteId/inbox/threads/:threadId/drafts/:draftId/send' },
    outputShape: 'unknown',
  },
  {
    id: 'inbox:draft:rm',
    name: 'Discard draft',
    summary: 'Discard a draft',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'thread_id', cliName: 'thread-id', type: 'number', required: true, positional: true, description: 'Thread id.' },
      { name: 'draft_id', cliName: 'draft-id', type: 'number', required: true, positional: true, description: 'Draft id.' },
    ],
    examples: ['inbox draft rm acme.com 123 5'],
    http: { method: 'DELETE', path: '/api/sites/:siteId/inbox/threads/:threadId/drafts/:draftId' },
    outputShape: 'void',
  },

  // ── Templates (~/.arcops/templates/<name>.md) - local ────────────────
  {
    id: 'template:ls',
    name: 'List templates',
    summary: 'List reply templates in ~/.arcops/templates',
    scope: 'read',
    idempotent: true,
    local: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['template ls'],
    outputShape: 'void',
  },
  {
    id: 'template:show',
    name: 'Show template',
    summary: 'Print a template body',
    scope: 'read',
    idempotent: true,
    local: true,
    args: [
      { name: 'name', type: 'string', required: true, positional: true, description: 'Template name.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['template show welcome'],
    outputShape: 'void',
  },
  {
    id: 'template:edit',
    name: 'Edit template',
    summary: 'Open template in $EDITOR (creates if missing)',
    scope: 'read',
    idempotent: true,
    local: true,
    args: [
      { name: 'name', type: 'string', required: true, positional: true, description: 'Template name.' },
    ],
    examples: ['template edit welcome'],
    outputShape: 'void',
  },

  // ── Audit (§8.3.2 ③: what did my agent do for this site) ──────────────
  {
    id: 'audit:ls',
    name: 'List site audit log',
    summary: 'Show send/write scope operations for a site (what agents did)',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
      { name: 'limit', type: 'number', description: 'Max entries (server caps at 1000).' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['audit ls acme.com', 'audit ls acme.com --limit 50 --output json'],
    http: { method: 'GET', path: '/api/sites/:siteId/audit', query: ['limit'] },
    outputShape: 'unknown',
  },

  // ── Invite administration (KEH-179 / INV-2) ───────────────────────────
  // Hits the server's invite-admin wrap routes (arcops-server PR #29), which
  // gate on withAuthOrToken + invite-admin membership. The plugin's own admin
  // endpoints are session-cookie authed and unreachable by the CLI's Bearer
  // token. The plaintext code is returned by the server ONLY at create time.
  {
    id: 'invite:create',
    name: 'Create invite code',
    summary: 'Create an invite code (plaintext shown once)',
    description:
      'Codes are single-use per email by default. v1 form limits: ' +
      '(1) max-uses>1 is bound to the invitation email - only that address can ' +
      'spend the uses on the email signup path (others get EMAIL_MISMATCH), so ' +
      'multi-use is only meaningful for repeated signups of the SAME email; ' +
      '(2) the OAuth redeem path does NOT enforce email binding - whoever holds ' +
      'the invite cookie consumes the code. --org-name provisions a new org on ' +
      'redeem (redeemer becomes owner); omit it for a user-only code.',
    scope: 'write',
    idempotent: false,
    args: [
      { name: 'email', type: 'string', required: true, description: 'Invitee email (signup email must match on the email path).' },
      { name: 'org_name', cliName: 'org-name', type: 'string', description: 'Org to provision on redeem (redeemer becomes owner). Omit for a user-only code.' },
      { name: 'max_uses', cliName: 'max-uses', type: 'number', description: 'Max redemptions (default 1). >1 is email-bound on the email path - see form limits.' },
      { name: 'expires', type: 'string', description: 'Expiry: duration (30d, 12h, 45m) or ISO 8601. Default 7d.' },
      { name: 'note', type: 'string', description: 'Operator note (stored in metadata; not shown to the invitee).' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['invite create --email jane@example.com --org-name "Acme Inc" --note "Q3 onboarding"'],
    http: { method: 'POST', path: '/api/invites', body: ['email', 'org_name', 'max_uses', 'expires', 'note'] },
    outputShape: 'unknown',
  },
  {
    id: 'invite:ls',
    name: 'List invite codes',
    summary: 'List invite codes (code plaintext never shown)',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'status', type: 'string', description: 'Filter: pending|used|expired|revoked|all.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['invite ls', 'invite ls --status pending'],
    http: { method: 'GET', path: '/api/invites', query: ['status'] },
    outputShape: 'unknown',
  },
  {
    id: 'invite:revoke',
    name: 'Revoke invite code',
    summary: 'Revoke an invite code (idempotent)',
    scope: 'write',
    idempotent: true,
    args: [
      { name: 'id', type: 'string', required: true, positional: true, description: 'Invitation id.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['invite revoke abc123'],
    http: { method: 'DELETE', path: '/api/invites/:id' },
    outputShape: 'unknown',
  },
  {
    id: 'invite:stats',
    name: 'Invite code stats',
    summary: 'Aggregate invite-code counts by status',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['invite stats'],
    http: { method: 'GET', path: '/api/invites/stats' },
    outputShape: 'unknown',
  },

  // ── Organizations (KEH-198; hits arcops-server #35 / KEH-197 wrap routes) ──
  // The better-auth organization plugin's list/create endpoints are session-
  // cookie authed (unreachable by the CLI's Bearer token - the KEH-188 wall);
  // these wrap the same operations behind withAuthOrToken so the CLI can
  // list/create orgs with its existing ts_ token. Human-admin only - org-scoped
  // BA api-keys are refused with 403 org_admin_required (no attributable user).
  {
    id: 'org:ls',
    name: 'List organizations',
    summary: 'List orgs you own or admin',
    description:
      'Lists organizations where the caller is an owner or admin member via the ' +
      'org-admin wrap endpoint (GET /api/orgs, arcops-server #35 / KEH-197). The ' +
      'server requires an IDENTIFIED HUMAN admin - a ts_ token bridged to a Better ' +
      'Auth user, or a browser/CF-Access session; org-scoped BA api-keys are ' +
      'refused with 403 org_admin_required (no attributable user to list orgs for) ' +
      '- so this verb uses the normal `arcops auth login` human token, not an ' +
      'org-scoped key. Cross-tenant safe by construction: the query JOINs on the ' +
      'caller\'s member rows, so a non-member\'s org is never returned (no ' +
      'existence leak); plain-member orgs are excluded - only orgs you own/admin ' +
      'appear. Returns id, name, slug, your role (owner/admin), and createdAt.',
    scope: 'read',
    idempotent: true,
    args: [
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['org ls'],
    http: { method: 'GET', path: '/api/orgs' },
    outputShape: 'unknown',
  },
  {
    id: 'org:create',
    name: 'Create organization',
    summary: 'Create an org with you as owner (human-admin only)',
    description:
      'Creates an organization with the caller as owner via the org-admin wrap ' +
      'endpoint (POST /api/orgs, arcops-server #35 / KEH-197). The server ' +
      'requires an IDENTIFIED HUMAN admin - a ts_ token bridged to a Better Auth ' +
      'user, or a browser/CF-Access session; org-scoped BA api-keys are refused ' +
      'with 403 org_admin_required (no attributable creator to own the org), and ' +
      'a read-scope key is refused earlier with 403 insufficient_scope - so this ' +
      'verb uses the normal `arcops auth login` human token, not an org-scoped ' +
      'key. Reuses the better-auth organization plugin\'s own createOrganization ' +
      '(system-action mode), so the org is indistinguishable from one created in ' +
      'the UI. --name is required (1-100 chars); --slug is optional and must be ' +
      'lowercase letters, digits, and single hyphens between (e.g. my-org, <= 60 ' +
      'chars) - when omitted it is derived from the name (e.g. "My Org" -> ' +
      'my-org). A duplicate slug is refused with 409 org_already_exists; bad ' +
      'name/slug returns 422 invalid_input (with detail.field). Returns the ' +
      'created org (id, name, slug, your owner role, createdAt).',
    scope: 'write',
    idempotent: false,
    args: [
      { name: 'name', type: 'string', required: true, description: 'Organization display name (1-100 chars).' },
      { name: 'slug', type: 'string', description: 'URL slug (lowercase, digits, single hyphens; <= 60 chars). Derived from --name when omitted.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['org create --name "Acme Inc"', 'org create --name "Acme Inc" --slug acme'],
    http: { method: 'POST', path: '/api/orgs', body: ['name', 'slug'] },
    outputShape: 'unknown',
  },

  // ── Capability discovery (local; prints this registry) ──────────────
  {
    id: 'verbs',
    name: 'Verb registry',
    summary: 'Print the verb registry (use --json for machine-readable catalog)',
    scope: 'read',
    idempotent: true,
    local: true,
    args: [
      { name: 'json', type: 'boolean', cliOnly: true, description: 'Print the full registry as JSON.' },
      { name: 'output', type: 'string', cliOnly: true, description: 'Output format: text or json.' },
    ],
    examples: ['verbs --json'],
    outputShape: 'void',
  },
];
