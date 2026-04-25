// src/commands/index.ts
//
// Catalog-as-data: each command is a row. Adding a new command = appending
// to this array. Dispatch reads `path` and routes; never switch on name.

import * as auth from './auth';
import * as campaign from './campaign';
import * as customer from './customer';
import * as funnel from './funnel';
import * as gsc from './gsc';
import * as inbox from './inbox';
import * as overview from './overview';
import * as revenue from './revenue';
import * as site from './site';
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
  { path: ['auth', 'login'],  summary: 'Save API token to ~/.ts/credentials.json',
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
{ path: ['gsc', 'query'], summary: 'GSC top queries',
  positional: ['site'], flags: ['--days', '--limit', '--output'],
  handler: (a) => gsc.query({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
{ path: ['gsc', 'page'], summary: 'GSC top pages',
  positional: ['site'], flags: ['--days', '--limit', '--output'],
  handler: (a) => gsc.page({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
{ path: ['gsc', 'country'], summary: 'GSC top countries',
  positional: ['site'], flags: ['--days', '--limit', '--output'],
  handler: (a) => gsc.country({ site: a.site, days: a.days, limit: a.limit, token: a.token, api: a.api, output: a.output }) },
{ path: ['customer', 'ls'], summary: 'List customers',
  positional: ['site'], flags: ['--output'],
  handler: (a) => customer.ls({ site: a.site, 'min-ltv': a['min-ltv'], token: a.token, api: a.api, output: a.output }) },
{ path: ['inbox', 'ls'], summary: 'List inbox threads',
  positional: ['site'], flags: ['--unread', '--status', '--output'],
  handler: (a) => inbox.ls({ site: a.site, unread: a.unread, status: a.status, token: a.token, api: a.api, output: a.output }) },
{ path: ['inbox', 'show'], summary: 'Show thread + messages',
  positional: ['site', 'thread-id'], flags: ['--output'],
  handler: (a) => inbox.show({ site: a.site, 'thread-id': a['thread-id'], token: a.token, api: a.api, output: a.output }) },
{ path: ['inbox', 'archive'], summary: 'Archive (close) an inbox thread',
  positional: ['site', 'thread-id'],
  handler: (a) => inbox.archive({ site: a.site, 'thread-id': a['thread-id'], token: a.token, api: a.api, output: a.output }) },
{ path: ['inbox', 'draft'], summary: 'Save a draft reply (review in web UI)',
  positional: ['site', 'thread-id'],
  flags: ['--body', '--body-file'],
  handler: (a) => inbox.draft({ site: a.site, 'thread-id': a['thread-id'], body: a.body, 'body-file': a['body-file'], token: a.token, api: a.api, output: a.output }) },
];
