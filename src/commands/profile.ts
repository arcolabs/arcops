import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, info, printJson, printKV } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

type Profile = {
  site_id: number;
  product_name: string | null;
  tagline: string | null;
  one_liner: string | null;
  description_short: string | null;
  description_long: string | null;
  category: string | null;
  primary_url: string | null;
  logo_url: string | null;
  pricing_model: string | null;
  starting_price_usd: number | null;
  target_audience: string | null;
  key_features: string[];
  social: Record<string, string>;
  founded_year: number | null;
  notes_md: string | null;
  updated_at: string | null;
};

export async function show(args: {
  site?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const { profile } = await apiGet<{ profile: Profile | null }>(
    `/api/sites/${site.id}/profile`,
    { api: auth.api, token: auth.token },
  );

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(profile);

  if (!profile) {
    info(`No profile set for ${site.domain}. Use the web UI Settings → Profile tab to fill it in.`);
    return;
  }

  const kv: [string, string][] = [
    ['product_name',     profile.product_name ?? ''],
    ['tagline',          profile.tagline ?? ''],
    ['one_liner',        profile.one_liner ?? ''],
    ['category',         profile.category ?? ''],
    ['primary_url',      profile.primary_url ?? ''],
    ['logo_url',         profile.logo_url ?? ''],
    ['pricing_model',    profile.pricing_model ?? ''],
    ['starting_price',   profile.starting_price_usd != null ? `$${profile.starting_price_usd}` : ''],
    ['target_audience',  profile.target_audience ?? ''],
    ['founded_year',     profile.founded_year != null ? String(profile.founded_year) : ''],
    ['updated_at',       profile.updated_at ?? ''],
  ];
  printKV(kv);

  if (profile.description_short) {
    process.stdout.write('\ndescription_short:\n');
    process.stdout.write(profile.description_short + '\n');
  }
  if (profile.description_long) {
    process.stdout.write('\ndescription_long:\n');
    process.stdout.write(profile.description_long + '\n');
  }
  if (profile.key_features?.length) {
    process.stdout.write('\nkey_features:\n');
    for (const f of profile.key_features) process.stdout.write(`  - ${f}\n`);
  }
  const socialEntries = Object.entries(profile.social ?? {});
  if (socialEntries.length) {
    process.stdout.write('\nsocial:\n');
    for (const [k, v] of socialEntries) process.stdout.write(`  ${k}: ${v}\n`);
  }
  if (profile.notes_md) {
    process.stdout.write('\nnotes_md:\n');
    process.stdout.write(profile.notes_md + '\n');
  }
}
