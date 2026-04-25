import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable, error } from '../output';

const COLS = {
  query:   ['query', 'clicks', 'impressions', 'ctr', 'position'] as const,
  page:    ['page',  'clicks', 'impressions', 'ctr', 'position'] as const,
  country: ['country', 'clicks', 'impressions'] as const,
};

async function resolveSite(siteArg: string, auth: { api: string; token: string }) {
  if (!siteArg) { error('site argument required (numeric id or domain)'); process.exit(2); }
  const { sites } = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  const site = sites.find(s => s.domain === siteArg || String(s.id) === siteArg);
  if (!site) { error(`No site "${siteArg}" found`); process.exit(1); }
  return site;
}

export async function query(args: { site?: string; days?: string; limit?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const site = await resolveSite(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = { dim: 'query' };
  if (args.days)  query.days  = Number(args.days);
  if (args.limit) query.limit = Number(args.limit);
  const data = await apiGet<{ rows: Record<string, unknown>[] }>(`/api/sites/${site.id}/gsc`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.rows);
  printTable(data.rows, [...COLS.query]);
}

export async function page(args: { site?: string; days?: string; limit?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const site = await resolveSite(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = { dim: 'page' };
  if (args.days)  query.days  = Number(args.days);
  if (args.limit) query.limit = Number(args.limit);
  const data = await apiGet<{ rows: Record<string, unknown>[] }>(`/api/sites/${site.id}/gsc`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.rows);
  printTable(data.rows, [...COLS.page]);
}

export async function country(args: { site?: string; days?: string; limit?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const site = await resolveSite(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = { dim: 'country' };
  if (args.days)  query.days  = Number(args.days);
  if (args.limit) query.limit = Number(args.limit);
  const data = await apiGet<{ rows: Record<string, unknown>[] }>(`/api/sites/${site.id}/gsc`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.rows);
  printTable(data.rows, [...COLS.country]);
}
