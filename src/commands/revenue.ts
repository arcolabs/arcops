import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

export async function revenue(args: {
  site?: string; days?: string; group_by?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = {};
  if (args.days) query.days = Number(args.days);
  const data = await apiGet<Record<string, unknown>>(`/api/sites/${site.id}/analytics/revenue`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  // Revenue summary as key-value pairs
  const { site: _, range: __, cohort_matrix: ___, by_utm: ____, ...flat } = data as Record<string, unknown>;
  printTable([flat] as Record<string, unknown>[], Object.keys(flat));
}
