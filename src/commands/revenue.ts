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
import { resolveSiteOrExit } from '../lib/site-resolve';

type RevenueResponse = {
  site: { id: number; name: string; domain: string };
  range: { from: string; to: string };
  utmTouch: 'first' | 'last';
  mrr: {
    committed_cents: number; past_due_cents: number; trialing_cents: number;
    arr_cents: number; active_subs: number; past_due_subs: number; trialing_subs: number;
    active_customers: number; mrr_per_active_cents: number;
  };
  revenue: {
    gross_cents: number; net_cents: number; refund_cents: number;
    dispute_withdrawn_cents: number; dispute_reversed_cents: number;
    charge_count: number; paying_customers: number; arpu_cents: number;
  };
  product_types: { product_type: string; charges: string | number; amount_cents: string | number }[];
  unclassified_count: number;
  topup: {
    mar_cents: number; repeat_rate: number;
    total_topup_customers: number; repeat_customers: number;
  };
  churn: {
    rate: number; canceled_this_month: number; active_at_start: number; month: string;
  };
  ltv_cents: number;
};

const section = (label: string) => process.stdout.write(`\n─ ${label} ─\n`);

export async function revenue(args: {
  site?: string; days?: string; group_by?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = {};
  if (args.days) query.days = Number(args.days);
  if (args.group_by) query.group_by = args.group_by;
  const data = await apiGet<RevenueResponse>(
    `/api/sites/${site.id}/analytics/revenue`,
    { api: auth.api, token: auth.token, query },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);

  info(`${data.site.name} (${data.site.domain})  ${data.range.from} → ${data.range.to}  utm:${data.utmTouch}`);

  const { mrr, revenue: rev, topup, churn } = data;
  section('MRR');
  printKV([
    ['committed',         formatUsdCents(mrr.committed_cents)],
    ['past_due',          formatUsdCents(mrr.past_due_cents)],
    ['trialing',          formatUsdCents(mrr.trialing_cents)],
    ['ARR',               formatUsdCents(mrr.arr_cents)],
    ['active subs',       String(mrr.active_subs)],
    ['past_due subs',     String(mrr.past_due_subs)],
    ['trialing subs',     String(mrr.trialing_subs)],
    ['active customers',  String(mrr.active_customers)],
    ['MRR per active',    formatUsdCents(mrr.mrr_per_active_cents)],
  ]);

  section('Revenue');
  printKV([
    ['gross',             formatUsdCents(rev.gross_cents)],
    ['net',               formatUsdCents(rev.net_cents)],
    ['refund',            formatUsdCents(rev.refund_cents)],
    ['dispute withdrawn', formatUsdCents(rev.dispute_withdrawn_cents)],
    ['dispute reversed',  formatUsdCents(rev.dispute_reversed_cents)],
    ['charge count',      String(rev.charge_count)],
    ['paying customers',  String(rev.paying_customers)],
    ['ARPU',              formatUsdCents(rev.arpu_cents)],
  ]);

  section('Topup');
  printKV([
    ['MAR',               formatUsdCents(topup.mar_cents)],
    ['repeat rate',       formatPct(topup.repeat_rate)],
    ['total customers',   String(topup.total_topup_customers)],
    ['repeat customers',  String(topup.repeat_customers)],
  ]);

  section('Churn');
  printKV([
    ['rate',              formatPct(churn.rate)],
    ['canceled',          String(churn.canceled_this_month)],
    ['active at start',   String(churn.active_at_start)],
    ['month',             churn.month],
  ]);

  process.stdout.write('\n');
  printKV([
    ['LTV',               formatUsdCents(data.ltv_cents)],
    ['Unclassified',      String(data.unclassified_count)],
  ]);

  if (data.product_types.length > 0) {
    section('Product types');
    const rows = data.product_types.map(p => ({
      product_type: p.product_type,
      charges: String(p.charges),
      amount: formatUsdCents(p.amount_cents),
    }));
    printTable(rows, ['product_type', 'charges', 'amount']);
  }
}
