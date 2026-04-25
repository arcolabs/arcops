import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, printJson, printTable, error, success } from '../output';
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

export async function create(args: {
  site?: string; source?: string; medium?: string; campaign?: string;
  term?: string; content?: string; dest?: string; name?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  if (!args.dest || !args.source || !args.campaign) {
    error('--dest, --source, --campaign required');
    process.exit(2);
  }
  const created = await apiPost<{ campaign: Record<string, unknown> }>(
    `/api/sites/${site.id}/campaigns`,
    { api: auth.api, token: auth.token, body: {
      label: args.name ?? `${args.source}/${args.campaign}`,
      destination: args.dest,
      utm_source: args.source,
      utm_medium: args.medium ?? 'referral',
      utm_campaign: args.campaign,
      utm_term: args.term,
      utm_content: args.content,
    }},
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(created.campaign);
  success(`Created campaign for ${site.domain}`);
  process.stdout.write((created.campaign as { url?: string }).url ?? '');
  process.stdout.write('\n');
}
