import { resolveAuth } from '../config';
import { apiGet } from '../api';
import {
  detectOutputFormat,
  formatPct,
  formatUsdCents,
  info,
  printJson,
  printKV,
  printTable,
} from '../output';

type SiteRow = {
  id: number;
  name: string;
  domain: string;
  has_stripe: boolean;
  mrr_committed_cents: number;
  active_subs: number;
  mtd_gross_cents: number;
  churn_rate: number;
};

type Totals = {
  mrr_committed_cents: number;
  mrr_past_due_cents: number;
  mrr_trialing_cents: number;
  arr_cents: number;
  mtd_gross_cents: number;
  mtd_net_cents: number;
  active_subs: number;
  active_customers_deduped: number;
  unclassified: number;
  backfill_in_progress: number;
  backfill_failed: number;
};

type OverviewResponse = { sites: SiteRow[]; totals: Totals; month: string };

export async function overview(args: { token?: string; api?: string; output?: string; days?: string }) {
  const auth = resolveAuth(args);
  const query: Record<string, string | number | undefined> = {};
  if (args.days) query.days = Number(args.days);
  const data = await apiGet<OverviewResponse>('/api/overview', { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);

  info(`month: ${data.month}`);
  const siteRows = data.sites.map(s => ({
    id: s.id,
    name: s.name,
    domain: s.domain,
    stripe: s.has_stripe ? '✓' : '-',
    mrr: formatUsdCents(s.mrr_committed_cents),
    subs: s.active_subs,
    mtd: formatUsdCents(s.mtd_gross_cents),
    churn: formatPct(s.churn_rate),
  }));
  printTable(siteRows, ['id', 'name', 'domain', 'stripe', 'mrr', 'subs', 'mtd', 'churn']);

  process.stdout.write('\n');
  const t = data.totals;
  printKV([
    ['MRR committed',        formatUsdCents(t.mrr_committed_cents)],
    ['MRR past_due',         formatUsdCents(t.mrr_past_due_cents)],
    ['MRR trialing',         formatUsdCents(t.mrr_trialing_cents)],
    ['ARR',                  formatUsdCents(t.arr_cents)],
    ['MTD gross',            formatUsdCents(t.mtd_gross_cents)],
    ['MTD net',              formatUsdCents(t.mtd_net_cents)],
    ['Active subs',          String(t.active_subs)],
    ['Active customers',     String(t.active_customers_deduped)],
    ['Unclassified',         String(t.unclassified)],
    ['Backfill in progress', String(t.backfill_in_progress)],
    ['Backfill failed',      String(t.backfill_failed)],
  ]);
}
