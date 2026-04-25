import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

export async function traffic(args: {
  site?: string; days?: string; group_by?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = {};
  if (args.days) query.days = Number(args.days);
  if (args.group_by) query.group_by = args.group_by;
  const data = await apiGet<{ buckets: { bucket: string; sessions: number; pageviews: number }[] }>(`/api/sites/${site.id}/analytics/traffic`, { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  printTable(data.buckets, ['bucket', 'sessions', 'pageviews']);
}
