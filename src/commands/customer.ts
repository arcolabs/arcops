import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable, error } from '../output';

export async function ls(args: {
  site?: string; 'min-ltv'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.site) { error('site argument required'); process.exit(2); }
  const { sites } = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  const site = sites.find(s => s.domain === args.site || String(s.id) === args.site);
  if (!site) { error(`No site "${args.site}"`); process.exit(1); }
  const data = await apiGet<{ customers: Record<string, unknown>[] }>(
    `/api/sites/${site.id}/customers`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.customers);
  printTable(data.customers, ['email', 'firstUtmSource', 'firstUtmMedium', 'firstUtmCampaign', 'createdAt']);
}
