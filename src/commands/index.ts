// src/commands/index.ts
//
// Catalog-as-data: each command is a row. Adding a new command = appending
// to this array. Dispatch reads `path` and routes; never switch on name.

import * as auth from './auth';
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
];
