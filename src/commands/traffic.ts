import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable } from '../output';

export async function traffic(args: {
  site?: string; days?: string; group_by?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.site) {
    const { error } = await import('../output');
    error('site argument required');
    process.exit(2);
  }
  const { sites } = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  const site = sites.find(s => s.domain === args.site || String(s.id) === args.site);
  if (!site) {
    const { error } = await import('../output');
    error(`No site "${args.site}"`);
    process.exit(1);
  }
  const query: Record<string, string | number | undefined> = {};
  if (args.days) query.days = Number(args.days);
  if (args.group_by) query.group_by = args.group_by;
  const data = await apiGet<{ buckets: { bucket: string; sessions: number; pageviews: number }[] }>(`/api/sites/${site.id}/analytics/traffic`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  printTable(data.buckets, ['bucket', 'sessions', 'pageviews']);
}
