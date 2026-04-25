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
