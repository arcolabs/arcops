// src/commands/audit.ts
//
// §8.3.2 ③ - `arcops audit ls <site>`: the product feature "what did my agent
// do for this site". Reads the org/site-scoped append-only ledger through
// GET /api/audit/events (P5 step 3 of the audit unification); the legacy
// GET /api/sites/:siteId/audit path still exists for older releases and is
// deleted only once this one is the published default. stdout = data (JSON when
// piped, table in TTY); human copy + scope badge go to stderr via
// printTable/info.

import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, info, printJson, printTable } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

// One row of the ledger (`audit_events`) as `/api/audit/events` returns it.
// `occurredAt` is when the action happened, which for a backfilled row is the
// legacy row's own timestamp; `createdAt` is when the row reached the ledger.
// `actor` carries the attribution the ledger keeps in one column: `user:<id|email>`
// for a person, `api_key:<id>` for a key, `server:<module>` for the product itself.
export type AuditEvent = {
  id: number;
  eventUid: string;
  orgId: string;
  siteId: number | null;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payloadJson: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
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

  // The ledger endpoint pages at 200 rows and defaults to 100, while this verb
  // has always shown up to 1000 in one call (the legacy path's clamp). Asking
  // once would silently cut a long history in half, so the verb pages itself
  // through `before_id` until it has what was asked for.
  const LEDGER_PAGE = 200;
  const LEDGER_MAX = 1000;
  const requested = args.limit != null ? Number(args.limit) : NaN;
  const target = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), LEDGER_MAX)
    : 200;

  const events: AuditEvent[] = [];
  let before: number | null = null;
  while (events.length < target) {
    const query = new URLSearchParams();
    query.set('site_id', String(site.id));
    query.set('limit', String(Math.min(LEDGER_PAGE, target - events.length)));
    if (before != null) query.set('before_id', String(before));
    const page = await apiGet<{ events: AuditEvent[]; next_cursor: number | null }>(
      `/api/audit/events?${query.toString()}`,
      { api: auth.api, token: auth.token },
    );
    events.push(...page.events);
    if (page.next_cursor == null || page.events.length === 0) break;
    before = page.next_cursor;
  }

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(events);

  if (events.length === 0) {
    info(`No audit entries for ${site.domain}. Send/write operations performed via API keys are recorded here.`);
    return;
  }

  printTable(
    events.map((e) => ({
      id: e.id,
      created_at:
        typeof e.occurredAt === 'string' ? e.occurredAt.slice(0, 19).replace('T', ' ') : e.occurredAt,
      action: e.action,
      actor: e.actor,
      target: e.subjectType ? `${e.subjectType}:${e.subjectId ?? ''}` : '',
    })) as unknown as Record<string, unknown>[],
    ['id', 'created_at', 'action', 'actor', 'target'],
  );
}
