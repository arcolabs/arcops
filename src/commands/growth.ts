import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { apiGet, apiPatch, apiPost, apiPut } from '../api';
import { resolveAuth } from '../config';
import { resolveSiteOrExit } from '../lib/site-resolve';
import {
  detectOutputFormat,
  formatPct,
  formatUsdCents,
  info,
  printJson,
  printKV,
  printTable,
  success,
} from '../output';

type Args = Record<string, string | undefined>;

function required(args: Args, name: string): string {
  const value = args[name]?.trim();
  if (!value) throw new Error(`--${name.replace(/_/g, '-')} is required`);
  return value;
}

function jsonInput(value: string | undefined, name: string, fallback?: unknown): any {
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name.replace(/_/g, '-')} is required (JSON or @path)`);
  }
  const raw = value.startsWith('@')
    ? readFileSync(value.slice(1), 'utf8')
    : value;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${name.replace(/_/g, '-')} is not valid JSON: ${(err as Error).message}`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(',')}}`;
}

function idempotencyKey(
  args: Args,
  siteId: number,
  operation: string,
  payload: unknown,
): string {
  if (args.idempotency_key) return args.idempotency_key;
  const digest = crypto.createHash('sha256').update(canonical(payload)).digest('hex').slice(0, 24);
  return `arcops-growth:${siteId}:${operation}:${digest}`;
}

async function context(args: Args) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  return { auth, site };
}

function dateWindow(args: Args): { from: string; to: string } {
  const to = args.to ? new Date(args.to) : new Date();
  const days = args.days === undefined ? 30 : Number(args.days);
  if (!args.from && (!Number.isFinite(days) || days <= 0 || days > 366)) {
    throw new Error('--days must be a number greater than 0 and no greater than 366');
  }
  const from = args.from
    ? new Date(args.from)
    : new Date(to.getTime() - days * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new Error('growth window requires valid --from/--to values with from < to');
  }
  if (to.getTime() > Date.now()) {
    throw new Error('growth window --to cannot be in the future');
  }
  if (to.getTime() - from.getTime() > 366 * 86_400_000) {
    throw new Error('growth windows cannot exceed 366 days');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function isoDate(value: string, name: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--${name.replace(/_/g, '-')} must be a valid date`);
  }
  return date.toISOString();
}

function renderData(data: unknown, output?: string): void {
  if (detectOutputFormat(output) === 'json') return printJson(data);
  printJson(data);
}

export const identity = {
  async upsert(args: Args) {
    const { auth, site } = await context(args);
    if (!args.user_id && !args.account_id) {
      throw new Error('at least one of --user-id or --account-id is required');
    }
    const payload = {
      ...(args.user_id ? {
        user: {
          id: args.user_id,
          ...(args.email ? { email: args.email } : {}),
          ...(args.user_traits ? { traits: jsonInput(args.user_traits, 'user_traits') } : {}),
        },
      } : {}),
      ...(args.account_id ? {
        account: {
          id: args.account_id,
          ...(args.account_name ? { name: args.account_name } : {}),
          ...(args.plan ? { plan: args.plan } : {}),
          ...(args.role ? { role: args.role } : {}),
          ...(args.account_traits ? { traits: jsonInput(args.account_traits, 'account_traits') } : {}),
        },
      } : {}),
      ...(args.visitor_id ? { visitor_id: args.visitor_id } : {}),
      ...(args.session_id ? { session_id: args.session_id } : {}),
      ...(args.stripe_customer_id ? { stripe_customer_id: args.stripe_customer_id } : {}),
    };
    const result = await apiPost(`/api/sites/${site.id}/growth/identity`, {
      api: auth.api,
      token: auth.token,
      body: payload,
      idempotencyKey: idempotencyKey(args, site.id, 'identity', payload),
    });
    renderData(result, args.output);
  },
};

export const lifecycle = {
  async show(args: Args) {
    const { auth, site } = await context(args);
    const result = await apiGet(`/api/sites/${site.id}/growth/lifecycle`, auth);
    renderData(result, args.output);
  },

  async set(args: Args) {
    const { auth, site } = await context(args);
    const payload = jsonInput(args.config, 'config');
    const result = await apiPut(`/api/sites/${site.id}/growth/lifecycle`, {
      api: auth.api,
      token: auth.token,
      body: payload,
      idempotencyKey: idempotencyKey(args, site.id, 'lifecycle', payload),
    });
    renderData(result, args.output);
  },
};

export async function outcomes(args: Args) {
  const { auth, site } = await context(args);
  const window = dateWindow(args);
  const result = await apiGet<any>(`/api/sites/${site.id}/growth/outcomes`, {
    ...auth,
    query: window,
  });
  if (detectOutputFormat(args.output) === 'json') return printJson(result);
  printKV([
    ['site', site.domain],
    ['window', `${window.from.slice(0, 10)} → ${window.to.slice(0, 10)}`],
    ['lifecycle', `v${result.lifecycle_version} (${result.scope})`],
    ['acquired', String(result.totals.acquired)],
    ['activated', `${result.totals.activated} (${formatPct(result.rates.activation) || '—'})`],
    ['paid', `${result.totals.paid} (${formatPct(result.rates.paid_conversion) || '—'})`],
    ['retained', `${result.totals.retained}/${result.totals.retention_eligible} (${formatPct(result.rates.retention) || '—'})`],
    ['revenue', formatUsdCents(result.totals.revenue_cents)],
    ['retained revenue', formatUsdCents(result.totals.retained_revenue_cents)],
    ['coverage', `${result.coverage.identity} identity · ${result.coverage.revenue} revenue · ${result.coverage.freshness}`],
  ]);
  if (result.channels?.length) {
    printTable(result.channels.map((row: any) => ({
      source: row.source ?? '(direct)',
      medium: row.medium ?? '',
      campaign: row.campaign ?? '',
      acquired: row.totals.acquired,
      activation: formatPct(row.rates.activation),
      paid: formatPct(row.rates.paid_conversion),
      revenue: formatUsdCents(row.totals.revenue_cents),
    })), ['source', 'medium', 'campaign', 'acquired', 'activation', 'paid', 'revenue']);
  }
  for (const warning of result.coverage?.warnings ?? []) info(`warning: ${warning}`);
}

function experimentPayload(args: Args) {
  return {
    name: required(args, 'name'),
    hypothesis: required(args, 'hypothesis'),
    target: required(args, 'target'),
    method: required(args, 'method'),
    primary_metric: required(args, 'metric'),
    guardrails: jsonInput(args.guardrails, 'guardrails', []),
    baseline_from: required(args, 'baseline_from'),
    baseline_to: required(args, 'baseline_to'),
    observation_from: required(args, 'observation_from'),
    observation_to: required(args, 'observation_to'),
    status: args.status ?? 'draft',
  };
}

export const experiment = {
  async ls(args: Args) {
    const { auth, site } = await context(args);
    const result = await apiGet<any>(`/api/sites/${site.id}/growth/experiments`, auth);
    if (detectOutputFormat(args.output) === 'json') return printJson(result.experiments);
    printTable(result.experiments.map((row: any) => ({
      uid: row.uid,
      status: row.status,
      metric: row.primary_metric,
      method: row.method,
      name: row.name,
      lifecycle: `v${row.lifecycle_version}`,
    })), ['uid', 'status', 'metric', 'method', 'name', 'lifecycle']);
  },

  async show(args: Args) {
    const { auth, site } = await context(args);
    const uid = required(args, 'uid');
    const result = await apiGet(
      `/api/sites/${site.id}/growth/experiments/${pathSegment(uid)}`,
      auth,
    );
    renderData(result, args.output);
  },

  async create(args: Args) {
    const { auth, site } = await context(args);
    const payload = experimentPayload(args);
    const result = await apiPost(`/api/sites/${site.id}/growth/experiments`, {
      ...auth,
      body: payload,
      idempotencyKey: idempotencyKey(args, site.id, 'experiment-create', payload),
    });
    renderData(result, args.output);
  },

  async update(args: Args) {
    const { auth, site } = await context(args);
    const uid = required(args, 'uid');
    const payload = {
      ...(args.name ? { name: args.name } : {}),
      ...(args.hypothesis ? { hypothesis: args.hypothesis } : {}),
      ...(args.target ? { target: args.target } : {}),
      ...(args.guardrails ? { guardrails: jsonInput(args.guardrails, 'guardrails') } : {}),
      ...(args.status ? { status: args.status } : {}),
    };
    if (Object.keys(payload).length === 0) throw new Error('at least one experiment update flag is required');
    const result = await apiPatch(`/api/sites/${site.id}/growth/experiments/${pathSegment(uid)}`, {
      ...auth,
      body: payload,
      idempotencyKey: idempotencyKey(args, site.id, `experiment-update:${uid}`, payload),
    });
    renderData(result, args.output);
  },

  async readback(args: Args) {
    const { auth, site } = await context(args);
    const uid = required(args, 'uid');
    const window = dateWindow(args);
    const payload = {
      measured_from: window.from,
      measured_to: window.to,
      decision: required(args, 'decision'),
      ...(args.notes ? { notes: args.notes } : {}),
    };
    const result = await apiPost(
      `/api/sites/${site.id}/growth/experiments/${pathSegment(uid)}/readbacks`,
      {
      ...auth,
      body: payload,
      idempotencyKey: idempotencyKey(args, site.id, `readback:${uid}`, payload),
      },
    );
    renderData(result, args.output);
  },
};

export const release = {
  async ls(args: Args) {
    const { auth, site } = await context(args);
    const result = await apiGet<any>(`/api/sites/${site.id}/growth/releases`, {
      ...auth,
      query: { experiment_uid: args.experiment_uid },
    });
    if (detectOutputFormat(args.output) === 'json') return printJson(result.releases);
    printTable(result.releases.map((row: any) => ({
      uid: row.uid,
      deployed_at: row.deployed_at,
      version: row.version ?? '',
      experiment: row.experiment_uid ?? '',
      label: row.label,
    })), ['uid', 'deployed_at', 'version', 'experiment', 'label']);
  },

  async create(args: Args) {
    const { auth, site } = await context(args);
    const payload = {
      label: required(args, 'label'),
      deployed_at: args.deployed_at
        ? isoDate(args.deployed_at, 'deployed_at')
        : new Date().toISOString(),
      ...(args.experiment_uid ? { experiment_uid: args.experiment_uid } : {}),
      ...(args.version ? { version: args.version } : {}),
      ...(args.change_url ? { change_url: args.change_url } : {}),
      ...(args.metadata ? { metadata: jsonInput(args.metadata, 'metadata') } : {}),
    };
    const result = await apiPost(`/api/sites/${site.id}/growth/releases`, {
      ...auth,
      body: payload,
      idempotencyKey: idempotencyKey(args, site.id, 'release-create', payload),
    });
    renderData(result, args.output);
  },
};

export const signal = {
  async ls(args: Args) {
    const { auth, site } = await context(args);
    const result = await apiGet<any>(`/api/sites/${site.id}/growth/signals`, {
      ...auth,
      query: { status: args.status, type: args.type },
    });
    if (detectOutputFormat(args.output) === 'json') return printJson(result.signals);
    printTable(result.signals.map((row: any) => ({
      uid: row.uid,
      status: row.status,
      severity: row.severity,
      type: row.type,
      subject: `${row.subject_type}:${row.subject_key}`,
      last_seen: row.last_seen_at,
    })), ['uid', 'status', 'severity', 'type', 'subject', 'last_seen']);
  },

  async refresh(args: Args) {
    const { auth, site } = await context(args);
    const result = await apiPost<any>(`/api/sites/${site.id}/growth/signals/refresh`, {
      ...auth,
      body: {},
    });
    if (detectOutputFormat(args.output) === 'json') return printJson(result);
    success(`Refreshed signals: ${result.opened} opened, ${result.resolved} resolved`);
    printTable(result.signals.map((row: any) => ({
      uid: row.uid,
      severity: row.severity,
      type: row.type,
      subject: `${row.subject_type}:${row.subject_key}`,
    })), ['uid', 'severity', 'type', 'subject']);
  },

  async ack(args: Args) {
    return updateSignal(args, 'acknowledged');
  },

  async resolve(args: Args) {
    return updateSignal(args, 'resolved');
  },
};

async function updateSignal(args: Args, status: 'acknowledged' | 'resolved') {
  const { auth, site } = await context(args);
  const uid = required(args, 'uid');
  const payload = {
    status,
    ...(status === 'resolved'
      ? { resolution_note: required(args, 'note') }
      : args.note
        ? { resolution_note: args.note }
        : {}),
  };
  const result = await apiPatch(`/api/sites/${site.id}/growth/signals/${pathSegment(uid)}`, {
    ...auth,
    body: payload,
    idempotencyKey: idempotencyKey(args, site.id, `signal-${status}:${uid}`, payload),
  });
  renderData(result, args.output);
}

export async function doctor(args: Args) {
  const { auth, site } = await context(args);
  const result = await apiGet<any>(`/api/sites/${site.id}/growth/doctor`, auth);
  if (detectOutputFormat(args.output) === 'json') return printJson(result);
  printKV([
    ['site', site.domain],
    ['status', result.status],
    ['checks', `${result.counts.pass} pass · ${result.counts.warn} warn · ${result.counts.fail} fail`],
  ]);
  printTable(result.checks.map((check: any) => ({
    status: check.status,
    code: check.code,
    message: check.message,
    remediation: check.remediation?.code ?? '',
  })), ['status', 'code', 'message', 'remediation']);
}
