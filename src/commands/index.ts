// src/commands/index.ts
//
// Catalog-as-data: each command is a row. Adding a new command = appending
// to this array. Dispatch reads `path` and routes; never switch on name.

import * as attribution from './attribution';
import * as auth from './auth';
import * as campaign from './campaign';
import * as customer from './customer';
import * as directory from './directory';
import * as funnel from './funnel';
import * as gsc from './gsc';
import * as inbox from './inbox';
import * as overview from './overview';
import * as profile from './profile';
import * as revenue from './revenue';
import * as site from './site';
import * as template from './template';
import * as traffic from './traffic';

export type CommandHandler = (args: Record<string, string>) => Promise<void> | void;

export type CommandDef = {
  path: string[];           // e.g. ['auth', 'login']
  summary: string;
  flags?: string[];         // documented option names
  positional?: string[];    // documented positional names
  handler: CommandHandler;
};

export const COMMANDS: CommandDef[] = [
  { path: ['auth', 'login'],  summary: 'Save API token to ~/.quay/credentials.json',
    flags: ['--token', '--api'],
    handler: (a) => auth.login({ token: a.token, api: a.api }) },
  { path: ['auth', 'status'], summary: 'Show current auth state',
    flags: ['--output'],
    handler: (a) => auth.status({ token: a.token, api: a.api, output: a.output }) },
  { path: ['auth', 'logout'], summary: 'Clear stored credentials',
    handler: () => auth.logout() },
  { path: ['site', 'ls'], summary: 'List all sites',
    flags: ['--output'],
    handler: (a) => site.ls(a) },
  { path: ['overview'], summary: 'Show overview analytics',
    flags: ['--output', '--days'],
    handler: (a) => overview.overview({ token: a.token, api: a.api, output: a.output, days: a.days }) },
  { path: ['site', 'show'], summary: 'Show a single site',
    positional: ['site'],
    flags: ['--output'],
    handler: (a) => site.show(a) },
  { path: ['site', 'profile'], summary: 'Show the site marketing profile',
    positional: ['site'],
    flags: ['--output'],
    handler: (a) => profile.show({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['site', 'submissions'], summary: 'Show directory submission status (with tracked UTM URLs)',
    positional: ['site'],
    flags: ['--output'],
    handler: (a) => directory.submissions({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['directory', 'ls'], summary: 'List the global directory catalog',
    flags: ['--output'],
    handler: (a) => directory.ls({ token: a.token, api: a.api, output: a.output }) },
  { path: ['revenue'], summary: 'Show revenue analytics',
    positional: ['site'],
    flags: ['--output', '--days', '--group-by'],
    handler: (a) => revenue.revenue({ site: a.site, days: a.days, group_by: a.group_by, token: a.token, api: a.api, output: a.output }) },
  { path: ['traffic'], summary: 'Show traffic analytics',
    positional: ['site'],
    flags: ['--output', '--days', '--group-by'],
    handler: (a) => traffic.traffic({ site: a.site, days: a.days, group_by: a.group_by, token: a.token, api: a.api, output: a.output }) },
  { path: ['campaign', 'ls'], summary: 'List campaigns for a site',
    positional: ['site'],
    flags: ['--output'],
    handler: (a) => campaign.ls({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['campaign', 'show'], summary: 'Show a campaign',
    positional: ['site', 'id'],
    flags: ['--output'],
    handler: (a) => campaign.show({ site: a.site, id: a.id, token: a.token, api: a.api, output: a.output }) },
  { path: ['campaign', 'create'], summary: 'Create tracked campaign URL',
    positional: ['site'],
    flags: ['--source', '--medium', '--campaign', '--term', '--content', '--dest', '--name'],
    handler: (a) => campaign.create({ site: a.site, source: a.source, medium: a.medium, campaign: a.campaign, term: a.term, content: a.content, dest: a.dest, name: a.name, token: a.token, api: a.api, output: a.output }) },
  { path: ['funnel', 'ls'], summary: 'List funnels for a site',
    positional: ['site'],
    flags: ['--output'],
    handler: (a) => funnel.ls({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['funnel', 'show'], summary: 'Show a funnel',
    positional: ['site', 'id'],
    flags: ['--output'],
    handler: (a) => funnel.show({ site: a.site, id: a.id, token: a.token, api: a.api, output: a.output }) },
  { path: ['gsc', 'query'], summary: 'GSC top queries (use --page to verify cannibalization)',
    positional: ['site'], flags: ['--days', '--limit', '--page', '--output'],
    handler: (a) => gsc.query({ site: a.site, days: a.days, limit: a.limit, page: a.page, token: a.token, api: a.api, output: a.output }) },
  { path: ['gsc', 'page'], summary: 'GSC top pages',
    positional: ['site'], flags: ['--days', '--limit', '--output'],
    handler: (a) => gsc.page({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
  { path: ['gsc', 'country'], summary: 'GSC top countries',
    positional: ['site'], flags: ['--days', '--limit', '--output'],
    handler: (a) => gsc.country({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
  { path: ['customer', 'ls'], summary: 'List customers',
    positional: ['site'], flags: ['--output'],
    handler: (a) => customer.ls({ site: a.site, 'min-ltv': a['min-ltv'], token: a.token, api: a.api, output: a.output }) },
  { path: ['attribution', 'diag'], summary: 'Attribution coverage health for a site',
    positional: ['site'], flags: ['--output'],
    handler: (a) => attribution.diag({ site: a.site, token: a.token, api: a.api, output: a.output }) },
  { path: ['attribution', 'backfill'], summary: 'Retroactive first-touch UTM for unattributed customers',
    positional: ['site'], flags: ['--limit', '--all', '--output'],
    handler: (a) => attribution.backfill({ site: a.site, limit: a.limit, all: a.all, token: a.token, api: a.api, output: a.output }) },

  // ── Inbox lifecycle (read / snooze / assign / archive / draft / reply) ──
  { path: ['inbox', 'ls'], summary: 'List inbox threads',
    positional: ['site'],
    flags: ['--unread', '--status', '--assignee', '--unassigned', '--from', '--search', '--limit', '--output'],
    handler: (a) => inbox.ls(a) },
  { path: ['inbox', 'show'], summary: 'Show thread + messages (does not mark read; use `inbox read`)',
    positional: ['site', 'thread-id'], flags: ['--output'],
    handler: (a) => inbox.show(a) },
  { path: ['inbox', 'read'], summary: 'Mark thread as read (clears unread_for_ops)',
    positional: ['site', 'thread-id'],
    handler: (a) => inbox.read(a) },
  { path: ['inbox', 'snooze'], summary: 'Snooze thread until --until (3d / tomorrow / ISO)',
    positional: ['site', 'thread-id'], flags: ['--until'],
    handler: (a) => inbox.snooze(a) },
  { path: ['inbox', 'assign'], summary: 'Assign thread to operator email',
    positional: ['site', 'thread-id'], flags: ['--to'],
    handler: (a) => inbox.assign(a) },
  { path: ['inbox', 'unassign'], summary: 'Clear thread assignee',
    positional: ['site', 'thread-id'],
    handler: (a) => inbox.unassign(a) },
  { path: ['inbox', 'archive'], summary: 'Archive (close) an inbox thread',
    positional: ['site', 'thread-id'],
    handler: (a) => inbox.archive(a) },
  { path: ['inbox', 'unarchive'], summary: 'Reopen a closed thread',
    positional: ['site', 'thread-id'],
    handler: (a) => inbox.unarchive(a) },
  { path: ['inbox', 'reply'], summary: 'Send reply (send scope; preview + typed-confirm unless --yes)',
    positional: ['site', 'thread-id'],
    flags: ['--body', '--body-file', '--template', '--attach', '--quote', '--yes'],
    handler: (a) => inbox.reply(a) },
  { path: ['inbox', 'send'], summary: 'Send a new email — creates a fresh thread (send scope)',
    positional: ['site'],
    flags: ['--to', '--cc', '--subject', '--from', '--body', '--body-file', '--template', '--yes', '--output'],
    handler: (a) => inbox.send(a) },
  { path: ['inbox', 'draft', 'create'], summary: 'Save a draft reply',
    positional: ['site', 'thread-id'],
    flags: ['--body', '--body-file', '--template', '--quote'],
    handler: (a) => inbox.draft.create(a) },
  { path: ['inbox', 'draft', 'ls'], summary: 'List pending drafts on a thread',
    positional: ['site', 'thread-id'], flags: ['--output'],
    handler: (a) => inbox.draft.ls(a) },
  { path: ['inbox', 'draft', 'show'], summary: 'Print a draft body',
    positional: ['site', 'thread-id', 'draft-id'], flags: ['--output'],
    handler: (a) => inbox.draft.show(a) },
  { path: ['inbox', 'draft', 'send'], summary: 'Promote a draft to an outbound reply (send scope)',
    positional: ['site', 'thread-id', 'draft-id'], flags: ['--yes'],
    handler: (a) => inbox.draft.send(a) },
  { path: ['inbox', 'draft', 'rm'], summary: 'Discard a draft',
    positional: ['site', 'thread-id', 'draft-id'],
    handler: (a) => inbox.draft.rm(a) },

  // ── Templates (~/.quay/templates/<name>.md) ──
  { path: ['template', 'ls'], summary: 'List reply templates in ~/.quay/templates',
    flags: ['--output'],
    handler: (a) => template.ls({ output: a.output }) },
  { path: ['template', 'show'], summary: 'Print a template body',
    positional: ['name'], flags: ['--output'],
    handler: (a) => template.show({ name: a.name, output: a.output }) },
  { path: ['template', 'edit'], summary: 'Open template in $EDITOR (creates if missing)',
    positional: ['name'],
    handler: (a) => template.edit({ name: a.name }) },
];
