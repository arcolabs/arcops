import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, printJson, printTable, error, info, success } from '../output';
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

type MoveResponse = {
  site: { id: number; domain: string; name: string; org_id: string };
  move: {
    from_org: string;
    to_org: string;
    to_org_slug: string;
    site_integrations_moved: number;
    retired_site_keys: number;
  };
};

// KEH-161 / spec §8.3.3-① - move a site to another organization (public
// tenant-split path). Destructive-adjacent: interactive runs confirm by
// typing the site domain, agents pass --yes (contract item 4). The server
// enforces owner/admin membership in BOTH orgs and refuses org-scoped BA
// api-keys - use a browser session or a ts_ token.
export async function move(args: {
  site?: string; 'target-org'?: string; yes?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const targetOrg = args['target-org'];
  if (!targetOrg) {
    error('--target-org required (organization slug or id)');
    process.exit(2);
  }
  const site = await resolveSiteOrExit(args.site ?? '', auth);

  info(`Moving ${site.domain} (site ${site.id}) to organization "${targetOrg}"`);
  if (args.yes !== 'true') {
    const ok = await confirmByTyping(
      site.domain,
      `Type the site domain (${site.domain}) to confirm the move: `,
    );
    if (!ok) { error('Move aborted.'); process.exit(1); }
  }

  const result = await apiPost<MoveResponse>(`/api/sites/${site.id}/move`, {
    api: auth.api,
    token: auth.token,
    body: { target_org: targetOrg },
  });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(result);

  success(`Moved ${result.site.domain}: ${result.move.from_org} -> ${result.move.to_org_slug}`);
  info(`Site-level integrations moved: ${result.move.site_integrations_moved}`);
  if (result.move.retired_site_keys > 0) {
    info(
      `${result.move.retired_site_keys} site-constrained API key(s) in the source org are now inert - re-issue them under "${result.move.to_org_slug}".`,
    );
  }
}
