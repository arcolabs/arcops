import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable, error } from '../output';

export async function ls(args: {
  site?: string; token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.site) {
    error('site argument required (numeric id or domain)');
    process.exit(2);
  }
  const { sites } = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  const site = sites.find(s => s.domain === args.site || String(s.id) === args.site);
  if (!site) {
    error(`No site "${args.site}" found`);
    process.exit(1);
  }
  const data = await apiGet<{ funnels: Record<string, unknown>[] }>(
    `/api/sites/${site.id}/funnels`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.funnels);
  printTable(data.funnels, ['id', 'label', 'step_count']);
}

export async function show(args: {
  site?: string; id?: string; token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.site) {
    error('site argument required (numeric id or domain)');
    process.exit(2);
  }
  const { sites } = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  const site = sites.find(s => s.domain === args.site || String(s.id) === args.site);
  if (!site) {
    error(`No site "${args.site}" found`);
    process.exit(1);
  }
  if (!args.id) { error('--id required'); process.exit(2); }
  const funnelId = Number(args.id);
  if (!Number.isFinite(funnelId)) { error('invalid funnel id'); process.exit(2); }
  const data = await apiGet<{ funnel: Record<string, unknown> }>(
    `/api/sites/${site.id}/funnels/${funnelId}`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.funnel);
  printTable([data.funnel] as Record<string, unknown>[], Object.keys(data.funnel));
}
