// src/commands/webhook.ts
//
// Manage org-level webhook endpoints. stdout is data; tables are for humans
// on a TTY. Plaintext signing secrets appear only in create/rotate responses.
import { resolveAuth } from '../config';
import { apiDelete, apiGet, apiPost, apiCall } from '../api';
import { detectOutputFormat, info, printJson, printKV, printTable, success, warn } from '../output';
import { splitList } from '../dispatch';

export type Endpoint = {
  id: string;
  transport: string;
  name: string;
  enabled_events: string[];
  site_filter: number[] | null;
  status: string;
  consecutive_failures: number;
  url_host: string | null;
  created_at: string;
  updated_at: string;
};

export type Delivery = {
  id: number;
  event_id?: string;
  endpoint_id?: string;
  endpoint_name?: string;
  transport?: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
};

function parseSiteFilter(raw?: string): number[] | null | undefined {
  if (raw == null) return undefined;
  if (raw === '' || raw === 'null' || raw === 'all') return null;
  const ids = raw.split(',').map((value) => Number(value.trim()));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new Error(`--site-filter must be comma-separated positive site ids (got "${raw}")`);
  }
  return ids;
}

export async function ls(args: { token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const { endpoints } = await apiGet<{ endpoints: Endpoint[] }>('/api/webhook-endpoints', {
    api: auth.api,
    token: auth.token,
  });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(endpoints);
  printTable(
    endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      transport: endpoint.transport,
      status: endpoint.status,
      events: endpoint.enabled_events.join(','),
      url_host: endpoint.url_host ?? '',
    })) as Record<string, unknown>[],
    ['id', 'name', 'transport', 'status', 'events', 'url_host'],
  );
}

export async function create(args: {
  name?: string; url?: string; event?: string; site_filter?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.name) throw new Error('--name is required');
  if (!args.url) throw new Error('--url is required');
  const events = splitList(args.event);
  if (events.length === 0) throw new Error('at least one --event is required (e.g. --event "inbox.*")');
  const siteFilter = parseSiteFilter(args.site_filter);

  const res = await apiPost<{ endpoint: Endpoint; secret: string }>('/api/webhook-endpoints', {
    api: auth.api,
    token: auth.token,
    body: {
      name: args.name,
      url: args.url,
      enabled_events: events,
      ...(siteFilter !== undefined ? { site_filter: siteFilter } : {}),
    },
  });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  warn('Save the signing secret NOW — it is shown exactly once (lost = rotate with `webhook update --rotate-secret`).');
  printKV([
    ['id', res.endpoint.id],
    ['name', res.endpoint.name],
    ['status', res.endpoint.status],
    ['events', res.endpoint.enabled_events.join(', ')],
    ['url_host', res.endpoint.url_host ?? ''],
    ['secret', res.secret],
  ]);
}

export async function update(args: {
  endpoint?: string;
  name?: string; url?: string; event?: string; site_filter?: string;
  status?: string; rotate_secret?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.endpoint) throw new Error('endpoint id (we_…) is required');
  if (args.status != null && args.status !== 'active' && args.status !== 'disabled') {
    throw new Error(`--status must be active or disabled (got "${args.status}")`);
  }
  const events = args.event == null ? undefined : splitList(args.event);
  const siteFilter = parseSiteFilter(args.site_filter);
  const rotate = args.rotate_secret === 'true';

  const body: Record<string, unknown> = {};
  if (args.name != null) body.name = args.name;
  if (args.url != null) body.url = args.url;
  if (events != null) body.enabled_events = events;
  if (siteFilter !== undefined) body.site_filter = siteFilter;
  if (args.status != null) body.status = args.status;
  if (rotate) body.rotate_secret = true;
  if (Object.keys(body).length === 0) {
    throw new Error('nothing to update — pass --name/--url/--event/--site-filter/--status/--rotate-secret');
  }

  const res = await apiCall<{ endpoint: Endpoint; secret?: string }>(
    `/api/webhook-endpoints/${encodeURIComponent(args.endpoint)}`,
    { api: auth.api, token: auth.token, method: 'PATCH', body },
  );

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  if (res.secret) warn('New signing secret shown exactly once — save it now.');
  success(`Endpoint ${res.endpoint.id} updated (status=${res.endpoint.status}).`);
  printJson(res);
}

export async function rm(args: { endpoint?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  if (!args.endpoint) throw new Error('endpoint id (we_…) is required');
  const res = await apiDelete<{ deleted: boolean; id: string }>(
    `/api/webhook-endpoints/${encodeURIComponent(args.endpoint)}`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  success(`Endpoint ${res.id} deleted.`);
}

export async function test(args: { endpoint?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  if (!args.endpoint) throw new Error('endpoint id (we_…) is required');
  const res = await apiPost<{ event_id: string; outcome: string; delivery: Delivery | null }>(
    `/api/webhook-endpoints/${encodeURIComponent(args.endpoint)}/test`,
    { api: auth.api, token: auth.token, body: {} },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') {
    printJson(res);
  } else if (res.outcome === 'succeeded') {
    success(`ping delivered (event ${res.event_id}, attempt ${res.delivery?.attempt_count ?? 1}).`);
  }
  if (res.outcome !== 'succeeded') {
    const delivery = res.delivery;
    throw new Error(
      `ping delivery ${res.outcome}: http=${delivery?.last_http_status ?? '-'} error=${delivery?.last_error ?? '(none)'} — event ${res.event_id}`,
    );
  }
}

export async function deliveries(args: {
  endpoint?: string; status?: string; limit?: string; cursor?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.endpoint) throw new Error('endpoint id (we_…) is required');
  const res = await apiGet<{ deliveries: Delivery[]; next_cursor: string | null }>(
    `/api/webhook-endpoints/${encodeURIComponent(args.endpoint)}/deliveries`,
    {
      api: auth.api,
      token: auth.token,
      query: { status: args.status, limit: args.limit, cursor: args.cursor },
    },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(res);
  printTable(
    res.deliveries.map((delivery) => ({
      id: delivery.id,
      event: delivery.event_id ?? '',
      status: delivery.status,
      attempts: delivery.attempt_count,
      http: delivery.last_http_status ?? '',
      next_attempt_at: delivery.status === 'failed' || delivery.status === 'pending' ? delivery.next_attempt_at : '',
      delivered_at: delivery.delivered_at ?? '',
    })) as Record<string, unknown>[],
    ['id', 'event', 'status', 'attempts', 'http', 'next_attempt_at', 'delivered_at'],
  );
  if (res.next_cursor) info(`More: --cursor ${res.next_cursor}`);
}
