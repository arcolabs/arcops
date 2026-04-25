// src/commands/index.ts
//
// Catalog-as-data: each command is a row. Adding a new command = appending
// to this array. Dispatch reads `path` and routes; never switch on name.

import * as auth from './auth';

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
];
