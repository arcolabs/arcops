import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, error, info, success, warn, printJson, printTable } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';
import { confirmByTyping } from '../lib/confirm';

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

// Create a site in the caller's org. Drives the public collection endpoint
// (arcops-server POST /api/sites { domain, name } -> 201 { site }). The server
// stamps org_id from the request's tenant context (never from input), cleans
// the domain (strips scheme + trailing slash), and 409s on a duplicate domain.
// This is the first step of the product's value path ("connect your first
// site") and the last CLI gap in the cold-start self-service loop (KEH-191).
//
// The server requires BOTH domain and name; the domain is the sole positional
// and --name is an optional display label that defaults to the domain, so
// `arcops site create acme.com` works as a one-arg command. A write-scope key
// is required (mutation). On success the created site object is emitted as pure
// data on stdout; server errors flow through the standard structured envelope.
export async function create(args: {
  domain?: string;
  name?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.domain) {
    error('domain argument required (the new site domain, e.g. acme.com)');
    process.exit(2);
  }

  const name = args.name ?? args.domain;

  const { site } = await apiPost<{
    site: { id: number; domain: string; name: string; org_id: string; created_at: string };
  }>('/api/sites', {
    api: auth.api,
    token: auth.token,
    body: { domain: args.domain, name },
  });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(site);

  success(`Created site ${site.domain} (id ${site.id})`);
  info(`name:   ${site.name}`);
  info(`org_id: ${site.org_id}`);
}

// Move a site to another organization. Drives the server's public site-move
// endpoint (arcops-server #23 / KEH-161): POST /api/sites/:id/move
// { target_org }. The server requires an IDENTIFIED HUMAN admin - a ts_ token
// bridged to a Better Auth user who is owner/admin of BOTH the source and
// target orgs; org-scoped BA api-keys are refused with 403
// move_requires_human_admin (no personal identity to prove dual-admin). The
// CLI's stored credential is a human ts_ token, so this verb works with normal
// `arcops auth login` credentials - no special token handling.
//
// The move re-homes the site + its site-level integrations to the target org
// and retires the source org's site-constrained BA keys (returned as
// retired_site_keys - re-issue them under the target org). It is gated behind
// a typed confirm (type the site domain) unless --yes is passed, matching the
// inbox send/reply guardrail for destructive sends; --yes runs unattended.
export async function move(args: {
  site?: string;
  to_org?: string;
  yes?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.site) {
    error('site argument required (numeric id or domain)');
    process.exit(2);
  }
  if (!args.to_org) {
    error('--to-org is required (target organization slug or id)');
    process.exit(2);
  }

  // The site lives in the token's source org; resolve id-or-domain to a
  // numeric id (the move endpoint path takes :id). Cross-org ids are absent
  // from /api/sites and fail closed here, never leaking existence.
  const { id: siteId, domain } = await resolveSiteOrExit(args.site, auth);

  if (args.yes !== 'true') {
    const ok = await confirmByTyping(
      domain,
      `Moving site ${domain} (id ${siteId}) to org "${args.to_org}". Type the site domain (${domain}) to confirm: `,
    );
    if (!ok) { error('Move aborted.'); process.exit(1); }
  }

  const result = await apiPost<{
    site: { id: number; domain: string; name: string; org_id: string };
    move: {
      from_org: string;
      to_org: string;
      to_org_slug: string;
      site_integrations_moved: number;
      retired_site_keys: number;
    };
  }>(`/api/sites/${siteId}/move`, {
    api: auth.api,
    token: auth.token,
    body: { target_org: args.to_org },
  });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(result);

  success(`Moved ${result.site.domain} -> ${result.move.to_org_slug} (${result.move.to_org})`);
  info(`from_org:                ${result.move.from_org}`);
  info(`site_integrations_moved: ${result.move.site_integrations_moved}`);
  if (result.move.retired_site_keys > 0) {
    warn(
      `retired_site_keys:       ${result.move.retired_site_keys} source-org BA key(s) are now inert ` +
      `(org mismatch fails closed) - re-issue under ${result.move.to_org_slug}.`,
    );
  } else {
    info(`retired_site_keys:       0`);
  }
}
