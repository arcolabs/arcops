// Only `growth identity upsert` remains: the server removed the experiment,
// release, signal, lifecycle, outcome, and doctor ledger in arcops-server #435
// (2026-10-29) and kept the identity route that links product users and
// accounts to Stripe customers.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { apiPost } from '../api';
import { resolveAuth } from '../config';
import { resolveSiteOrExit } from '../lib/site-resolve';
import { detectOutputFormat, printJson } from '../output';

type Args = Record<string, string | undefined>;

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
