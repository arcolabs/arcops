import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, info, printJson, success } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

type BackfillResult = {
  scanned: number;
  matched_email: number;
  attributed: number;
  skipped_no_session: number;
};

type DiagResult = {
  customers_total: number;
  customers_with_first_visitor: number;
  customers_with_first_utm: number;
  visitor_emails_total: number;
  visitor_emails_unique_emails: number;
  matchable_unattributed: number;
};

function pct(num: number, denom: number): string {
  if (!denom) return '—';
  return `${Math.round((100 * num) / denom)}%`;
}

export async function diag(args: {
  site?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const data = await apiGet<DiagResult>(
    `/api/sites/${site.id}/attribution-diag`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);

  const total = data.customers_total;
  const unattr = total - data.customers_with_first_visitor;
  info(`Attribution diagnostics for ${site.domain}:`);
  info(`  customers total:           ${total}`);
  info(`  with first_visitor_id:     ${data.customers_with_first_visitor} (${pct(data.customers_with_first_visitor, total)})`);
  info(`  with first_utm_source:     ${data.customers_with_first_utm} (${pct(data.customers_with_first_utm, total)})`);
  info(`  unattributed:              ${unattr}`);
  info('');
  info(`  visitor_emails rows:       ${data.visitor_emails_total}`);
  info(`  unique identified emails:  ${data.visitor_emails_unique_emails}`);
  info('');
  info(`  matchable via backfill:    ${data.matchable_unattributed}  (\`arcops attribution backfill --all\` will attribute exactly this many)`);
}

// Cloudflare caps origin response at 100s, so each call processes a small batch.
// `--all` keeps invoking until the backlog drains (scanned < limit).
const SAFETY_CAP = 200;

export async function backfill(args: {
  site?: string; limit?: string; all?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const limitRaw = args.limit ? Number(args.limit) : 100;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
  const loop = args.all === 'true';

  const totals: BackfillResult = { scanned: 0, matched_email: 0, attributed: 0, skipped_no_session: 0 };
  const passes: BackfillResult[] = [];

  for (let pass = 1; pass <= SAFETY_CAP; pass++) {
    const data = await apiPost<BackfillResult>(
      `/api/sites/${site.id}/attribution-backfill?limit=${limit}`,
      { api: auth.api, token: auth.token },
    );
    passes.push(data);
    totals.scanned += data.scanned;
    totals.matched_email += data.matched_email;
    totals.attributed += data.attributed;
    totals.skipped_no_session += data.skipped_no_session;

    if (!loop) break;
    if (data.scanned < limit) break; // backlog drained
    info(`pass ${pass}: scanned=${data.scanned} attributed=${data.attributed} — continuing`);
  }

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson({ totals, passes });

  info(`Attribution backfill on ${site.domain}${loop ? ` (looped, ${passes.length} pass${passes.length === 1 ? '' : 'es'})` : ''}:`);
  info(`  scanned:            ${totals.scanned}`);
  info(`  matched email:      ${totals.matched_email}`);
  info(`  attributed:         ${totals.attributed}`);
  info(`  skipped no session: ${totals.skipped_no_session}`);
  success('Done.');
}
