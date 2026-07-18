// src/commands/events.ts
//
// S8d-2 product surface (server: docs/design/s8d-events-webhooks.md §8):
// the org's append-only event log + delivery replay. stdout=data contract:
// piped output is the raw JSON payload; tables are TTY-only.
import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, info, printJson, printTable, success } from '../output';
import type { Delivery } from './webhook';

type EventRow = {
  id: string;
  type: string;
  site_id: number | null;
  data: Record<string, unknown>;
  created_at: string;
};

type EventDetail = {
  event: {
    id: string;
    type: string;
    api_version: string;
    created_at: string;
    site: { id: number; domain: string } | null;
    data: Record<string, unknown>;
  };
  deliveries: Delivery[];
};

export async function ls(args: {
  type?: string; site?: string; since?: string; limit?: string; cursor?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const res = await apiGet<{ events: EventRow[]; next_cursor: string | null }>('/api/events', {
    api: auth.api, token: auth.token,
    query: { type: args.type, site: args.site, since: args.since, limit: args.limit, cursor: args.cursor },
  });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  printTable(
    res.events.map((e) => ({
      id: e.id,
      type: e.type,
      site_id: e.site_id ?? '',
      created_at: e.created_at,
    })) as Record<string, unknown>[],
    ['id', 'type', 'site_id', 'created_at'],
  );
  if (res.next_cursor) info(`More: --cursor ${res.next_cursor}`);
}

export async function show(args: { event?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  if (!args.event) throw new Error('event id (evt_…) is required');
  const res = await apiGet<EventDetail>(`/api/events/${encodeURIComponent(args.event)}`, {
    api: auth.api, token: auth.token,
  });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  printJson(res.event);
  if (res.deliveries.length === 0) {
    info('No deliveries (no endpoint was subscribed at emit time).');
    return;
  }
  printTable(
    res.deliveries.map((d) => ({
      id: d.id,
      endpoint: d.endpoint_id ?? '',
      transport: d.transport ?? '',
      status: d.status,
      attempts: d.attempt_count,
      http: d.last_http_status ?? '',
      last_error: (d.last_error ?? '').slice(0, 60),
    })) as Record<string, unknown>[],
    ['id', 'endpoint', 'transport', 'status', 'attempts', 'http', 'last_error'],
  );
}

export async function replay(args: { delivery_id?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const id = Number(args.delivery_id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('delivery id must be a positive integer (see `events show <evt_…>` or `webhook deliveries`)');
  }
  const res = await apiPost<{ delivery: Delivery | null }>(`/api/event-deliveries/${id}/replay`, {
    api: auth.api, token: auth.token, body: {},
  });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  success(`Delivery ${id} re-armed (status=${res.delivery?.status ?? 'pending'}) — the runner picks it up on the next tick.`);
}
