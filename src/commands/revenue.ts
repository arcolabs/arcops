import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable } from '../output';

export async function revenue(args: {
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
  const data = await apiGet<Record<string, unknown>>(`/api/sites/${site.id}/analytics/revenue`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  // Revenue summary as key-value pairs
  const { site: _, range: __, cohort_matrix: ___, by_utm: ____, ...flat } = data as Record<string, unknown>;
  printTable([flat] as Record<string, unknown>[], Object.keys(flat));
}
