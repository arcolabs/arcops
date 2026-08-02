import { apiGet } from '../api';
import { resolveAuth } from '../config';
import { parsePositiveSiteId, resolveSiteOrExit } from '../lib/site-resolve';
import { detectOutputFormat, printJson, printKV, printTable } from '../output';

type Args = Record<string, string | undefined>;

type IntegrationListItem = {
  provider: string;
  grant_uid: string | null;
  capability: string;
  grant_status: string;
  binding_status: string;
  effective_route: { source: string; status: string };
  health: { status: string; checked_at: string | null };
  provider_freshness: { status: string; evidence_at: string | null };
  sync_freshness: { status: string; last_sync_at: string | null };
  coverage: { status: string; permission_lost: boolean };
  last_activity_at: string | null;
  manage_url: string;
};

type IntegrationListResponse = { items: IntegrationListItem[] };

type IntegrationDoctorResponse = {
  provider: string;
  grant_uid?: string | null;
  site_id?: number;
  aggregate: string;
  checks: Array<{
    code: string;
    status: string;
    message: string;
    observed?: Record<string, unknown>;
    remediation?: { code: string; message: string; level: string; action: string };
  }>;
  checked_at: string;
  manage_url: string;
};

async function resolveIntegrationSiteId(input: string, auth: { api: string; token: string }): Promise<number> {
  const numeric = parsePositiveSiteId(input);
  if (numeric != null) return numeric;
  return (await resolveSiteOrExit(input, auth)).id;
}

async function siteQuery(args: Args, auth: { api: string; token: string }): Promise<{ site_id?: number }> {
  if (!args.site) return Promise.resolve({});
  return { site_id: await resolveIntegrationSiteId(args.site, auth) };
}

function formatTimestamp(value: string | null | undefined): string {
  return value ? value.replace(/\.\d{3}Z$/, 'Z') : '—';
}

export async function ls(args: Args) {
  const auth = resolveAuth(args);
  const query = await siteQuery(args, auth);
  const result = await apiGet<IntegrationListResponse>('/api/integrations', {
    api: auth.api,
    token: auth.token,
    query,
  });
  if (detectOutputFormat(args.output) === 'json') return printJson(result);
  printTable(result.items.map((item) => ({
    provider: item.provider,
    capability: item.capability,
    grant: item.grant_status,
    binding: item.binding_status,
    route: `${item.effective_route.source}/${item.effective_route.status}`,
    health: item.health.status,
    sync: item.sync_freshness.status,
    last_activity: formatTimestamp(item.last_activity_at),
    manage: item.manage_url,
  })), ['provider', 'capability', 'grant', 'binding', 'route', 'health', 'sync', 'last_activity', 'manage']);
}

export async function doctor(args: Args) {
  const provider = args.provider?.trim();
  if (!provider) throw new Error('<provider> is required (email, search-console, bing, or stripe)');
  const auth = resolveAuth(args);
  const siteId = args.site ? await resolveIntegrationSiteId(args.site, auth) : null;
  const path = siteId != null
    ? `/api/sites/${siteId}/integrations/${encodeURIComponent(provider)}/doctor`
    : `/api/integrations/${encodeURIComponent(provider)}/doctor`;
  const result = await apiGet<IntegrationDoctorResponse>(path, {
    api: auth.api,
    token: auth.token,
    query: {
      ...(args.grant ? { grant_uid: args.grant } : {}),
    },
  });
  if (detectOutputFormat(args.output) === 'json') return printJson(result);
  printKV([
    ['provider', result.provider],
    ['scope', result.site_id == null ? 'workspace' : `site #${result.site_id}`],
    ['grant', result.grant_uid ?? '—'],
    ['aggregate', result.aggregate],
    ['checked_at', formatTimestamp(result.checked_at)],
    ['manage', result.manage_url],
  ]);
  printTable(result.checks.map((check) => ({
    code: check.code,
    status: check.status,
    message: check.message,
    remediation: check.remediation?.code ?? '—',
  })), ['code', 'status', 'message', 'remediation']);
}
