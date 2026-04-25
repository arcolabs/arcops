import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable } from '../output';

type SiteRow = { id: number; domain: string; name: string; createdAt: string };

export async function ls(args: { token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  const { sites } = await apiGet<{ sites: SiteRow[] }>('/api/sites', auth);
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(sites);
  printTable(sites, ['id', 'domain', 'name', 'createdAt']);
}

export async function show(args: { site?: string; token?: string; api?: string; output?: string }) {
  const auth = resolveAuth(args);
  if (!args.site) {
    const { error } = await import('../output');
    error('site argument required (numeric id or domain)');
    process.exit(2);
  }
  const { sites } = await apiGet<{ sites: { id: number; domain: string }[] }>('/api/sites', auth);
  const site = sites.find(s => s.domain === args.site || String(s.id) === args.site);
  if (!site) {
    const { error } = await import('../output');
    error(`No site "${args.site}" found`);
    process.exit(1);
  }
  const { site: siteData } = await apiGet<{ site: Record<string, unknown> }>(`/api/sites/${site.id}`, auth);
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(siteData);
  // In text mode, print key fields
  printTable([siteData] as Record<string, unknown>[], Object.keys(siteData));
}
