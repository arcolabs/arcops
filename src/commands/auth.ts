// src/commands/auth.ts
import { saveCredentials, clearCredentials, loadCredentials, resolveAuth, resolveApiEnv, DEFAULT_API } from '../config';
import { apiGet } from '../api';
import { info, success, error, printJson, detectOutputFormat } from '../output';

export async function login(args: { token?: string; api?: string }) {
  if (!args.token) {
    error('--token <api-key> required (browser OAuth flow not implemented in v1)');
    process.exit(2);
  }
  const api = args.api ?? resolveApiEnv() ?? DEFAULT_API;
  // Sanity-check the key by hitting /api/sites. Let ApiError propagate so
  // dispatch renders the agent-first JSON envelope under `--output json`
  // (contract item 2) instead of a plaintext `✖` line - the cold-start auth
  // failure path must stay machine-parseable.
  await apiGet('/api/sites', { api, token: args.token });
  saveCredentials({ token: args.token, api });
  success(`Logged in to ${api}`);
}

export async function status(args: { token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const fmt = detectOutputFormat(args.output);
  if (!auth.token) {
    if (fmt === 'json') printJson({ authenticated: false, api: auth.api });
    else error('Not logged in. Run: arcops auth login --token <api-key>');
    process.exit(auth.token ? 0 : 1);
  }
  // Let ApiError propagate so dispatch renders the agent-first JSON envelope
  // under `--output json` (contract item 2).
  const sites = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  if (fmt === 'json') {
    printJson({ authenticated: true, api: auth.api, site_count: sites.sites.length });
  } else {
    success(`Authenticated to ${auth.api}`);
    info(`${sites.sites.length} sites visible`);
  }
}

export async function logout() {
  const before = loadCredentials();
  clearCredentials();
  if (before.token) success('Logged out.');
  else info('Already logged out.');
}
