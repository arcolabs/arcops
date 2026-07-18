// src/commands/audit.ts
//
// §8.3.2 ③ - `arcops audit ls <site>`: the product feature "what did my agent
// do for this site". Reads the org/site-scoped send/write scope operation log
// from GET /api/sites/:siteId/audit. stdout = data (JSON when piped, table in
// TTY); human copy + scope badge go to stderr via printTable/info.

import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, info, printJson, printTable } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

export type AuditEntry = {
  id: number;
  user_id: number | null;
  user_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
  api_key_id: string | null;
  scope: string | null;
  site_id: number | null;
  created_at: string;
};

export async function ls(args: {
  site?: string;
  limit?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);

  const query = new URLSearchParams();
  const limit = args.limit != null ? Number(args.limit) : NaN;
  if (Number.isFinite(limit)) {
    query.set('limit', String(limit));
  }
  const qs = query.toString();
  const { entries } = await apiGet<{ entries: AuditEntry[] }>(
    `/api/sites/${site.id}/audit${qs ? `?${qs}` : ''}`,
    { api: auth.api, token: auth.token },
  );

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(entries);

  if (entries.length === 0) {
    info(`No audit entries for ${site.domain}. Send/write operations performed via API keys are recorded here.`);
    return;
  }

  printTable(
    entries.map((e) => ({
      id: e.id,
      created_at: typeof e.created_at === 'string' ? e.created_at.slice(0, 19).replace('T', ' ') : e.created_at,
      action: e.action,
      scope: e.scope ?? '',
      api_key_id: e.api_key_id ?? '',
      actor: e.user_email ?? '',
      target: e.target_type ? `${e.target_type}:${e.target_id ?? ''}` : '',
    })) as unknown as Record<string, unknown>[],
    ['id', 'created_at', 'action', 'scope', 'api_key_id', 'actor', 'target'],
  );
}
