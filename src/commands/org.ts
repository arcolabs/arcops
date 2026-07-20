// src/commands/org.ts
//
// KEH-198 - organization administration. These verbs hit the server's org-admin
// wrap routes (arcops-server #35 / KEH-197), which gate on `withAuthOrToken` +
// `requireOrgAdminActor`. The better-auth organization plugin's own list/create
// endpoints are session-cookie authed (orgSessionMiddleware + requireHeaders -
// unreachable by the CLI's Bearer token, the KEH-188 wall); the wrap performs
// the same operations with the CLI's existing ts_ token so no new auth surface
// is needed.
//
// Authz mirrors site-move's `move_requires_human_admin` (spec §8.3.3-①) and
// invite-admin option C: an IDENTIFIED HUMAN (a browser/CF-Access session or a
// ts_ token bridged to a Better Auth user via legacy_user_map) is required.
// Org-scoped BA api-keys are REJECTED on every org-admin route with 403
// `org_admin_required` - a BA key carries no attributable creator userId, so
// there is no BA user to list orgs for or attribute a created org to (fail
// closed). So these verbs use the normal `arcops auth login` human token, not
// an org-scoped key. A read-scope key hitting POST is refused earlier by the
// scope gate with 403 `insufficient_scope`. Both 403s (and the 409
// `org_already_exists` / 422 `invalid_input` create errors) flow through the
// standard structured error envelope - no special handling here.
//
// Output contract (agent-first): --output json = pure data on stdout. Create
// reuses the plugin's own createOrganization (system-action mode), so the org
// is indistinguishable from one created in the UI; the caller becomes its owner.

import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, error, info, success, printJson, printTable } from '../output';

// Server response shape (KEH-197, camelCase - the route returns OrgView/
// CreatedOrg verbatim). `role` is the caller's role in the org ('owner' for a
// freshly created org; 'owner' | 'admin' for listed orgs).
export interface OrgView {
  id: string;
  name: string;
  slug: string;
  role: string;
  createdAt: string; // ISO 8601
}

// List: GET /api/orgs -> { orgs: OrgView[] }
// Cross-tenant safe by construction: the server JOINs on the caller's member
// rows, so a non-member's org is never returned (no existence leak); plain-
// 'member' orgs are excluded - only orgs the caller owns/admins appear.
export async function ls(args: {
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  const { orgs } = await apiGet<{ orgs: OrgView[] }>('/api/orgs', { api: auth.api, token: auth.token });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(orgs);

  if (orgs.length === 0) {
    info('No organizations you administer.');
    return;
  }
  printTable(
    orgs.map((o) => ({
      id: o.id.slice(0, 8),
      name: o.name,
      slug: o.slug,
      role: o.role,
      created_at:
        typeof o.createdAt === 'string' ? o.createdAt.slice(0, 19).replace('T', ' ') : o.createdAt,
    })) as unknown as Record<string, unknown>[],
    ['id', 'name', 'slug', 'role', 'created_at'],
  );
}

// Create: POST /api/orgs { name, slug? } -> 201 { org: OrgView }
// --name is required (1-100 chars, server-validated); --slug is optional and,
// when omitted, derived from the name server-side (e.g. "My Org" -> my-org).
export async function create(args: {
  name?: string;
  slug?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.name) {
    error('--name is required (the organization display name, e.g. "Acme Inc")');
    process.exit(2);
  }

  // Omit slug when absent/empty so the server derives it from the name (matches
  // the server's normalizeSlug: empty/whitespace slug -> deriveSlug(name)).
  const body: Record<string, unknown> = { name: args.name };
  if (args.slug) body.slug = args.slug;

  const { org } = await apiPost<{ org: OrgView }>('/api/orgs', {
    api: auth.api,
    token: auth.token,
    body,
  });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(org);

  success(`Created organization ${org.name} (${org.slug})`);
  info(`id:    ${org.id}`);
  info(`slug:  ${org.slug}`);
  info(`role:  ${org.role}`);
}
