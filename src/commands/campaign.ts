import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable, error } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

export async function ls(args: {
  site?: string; token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const data = await apiGet<{ campaigns: Record<string, unknown>[] }>(
    `/api/sites/${site.id}/campaigns`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.campaigns);
  printTable(data.campaigns, ['id', 'label', 'destination', 'utm_source', 'utm_medium', 'utm_campaign']);
}

export async function show(args: {
  site?: string; id?: string; token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  if (!args.id) { error('--id required'); process.exit(2); }
  const campaignId = Number(args.id);
  if (!Number.isFinite(campaignId)) { error('invalid campaign id'); process.exit(2); }
  const data = await apiGet<{ campaign: Record<string, unknown> }>(
    `/api/sites/${site.id}/campaigns/${campaignId}`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.campaign);
  printTable([data.campaign] as Record<string, unknown>[], Object.keys(data.campaign));
}
