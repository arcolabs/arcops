// src/commands/invite.ts
//
// KEH-179 (INV-2) - invite-code administration. These verbs hit the server's
// invite-admin wrap routes (arcops-server PR #29), which gate on
// `withAuthOrToken` + invite-admin membership (owner/admin of
// INVITE_ADMIN_ORG_SLUG, verified per-request; BA api-keys are REJECTED -
// a BA key has no attributable creator, so no per-user role check is
// possible; server-side CEO option C, 2026-07-19). The plugin's own
// admin endpoints are session-cookie authed and unreachable by the CLI's
// Bearer token - the wrap is why this surface exists.
//
// Output contract (agent-first): --output json = pure data on stdout. The
// plaintext invite code is returned by the server ONLY at create time and is
// printed once; ls/revoke/stats never surface it (the row stores only its
// SHA-256 hash). The two v1 form limits live on the verb's `description`
// (rendered in `arcops invite create --help` + SKILL.md).

import { resolveAuth } from '../config';
import { apiGet, apiPost, apiDelete } from '../api';
import { detectOutputFormat, error, info, success, printJson, printTable } from '../output';

export interface CreatedInvitation {
  id: string;
  code: string;
  email: string;
  inviteUrl: string;
  expiresAt: string;
  maxUses: number;
  metadata: Record<string, string> | null;
}

export interface InvitationView {
  id: string;
  email: string;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  usedAt: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  invitedBy: string | null;
}

// Create: POST /api/invites { email, org_name?, max_uses?, expires?, note? }
export async function create(args: {
  email?: string;
  org_name?: string;
  max_uses?: string;
  expires?: string;
  note?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.email) {
    error('--email is required');
    process.exit(2);
  }
  const body: Record<string, unknown> = { email: args.email };
  if (args.org_name) body.org_name = args.org_name;
  if (args.max_uses != null && args.max_uses !== '') {
    const n = Number(args.max_uses);
    if (!Number.isFinite(n)) {
      error('--max-uses must be a number');
      process.exit(2);
    }
    body.max_uses = n;
  }
  if (args.expires) body.expires = args.expires;
  if (args.note) body.note = args.note;

  const { invitation } = await apiPost<{ invitation: CreatedInvitation }>(
    '/api/invites',
    { api: auth.api, token: auth.token, body },
  );

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(invitation);

  // Text: the code is the primary output (shown ONCE) -> stdout so it can be
  // piped. The success tick + invite URL + one-time reminder go to stderr.
  success(`Invite code created for ${invitation.email}`);
  process.stdout.write(`code:        ${invitation.code}\n`);
  process.stdout.write(`id:          ${invitation.id}\n`);
  process.stdout.write(`expires_at:  ${invitation.expiresAt}\n`);
  process.stdout.write(`max_uses:    ${invitation.maxUses}\n`);
  if (invitation.inviteUrl) info(`invite_url:  ${invitation.inviteUrl}`);
  info('The code is shown only here - store it securely; it cannot be retrieved again.');
}

// List: GET /api/invites[?status=]
export async function ls(args: {
  status?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  const query = new URLSearchParams();
  if (args.status) query.set('status', args.status);
  const qs = query.toString();
  const { invitations } = await apiGet<{ invitations: InvitationView[] }>(
    `/api/invites${qs ? `?${qs}` : ''}`,
    { api: auth.api, token: auth.token },
  );

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(invitations);

  if (invitations.length === 0) {
    info('No invite codes.');
    return;
  }
  printTable(
    invitations.map((v) => ({
      id: v.id.slice(0, 8),
      email: v.email,
      status: v.status,
      uses: `${v.useCount}/${v.maxUses}`,
      expires_at:
        typeof v.expiresAt === 'string' ? v.expiresAt.slice(0, 19).replace('T', ' ') : v.expiresAt,
    })) as unknown as Record<string, unknown>[],
    ['id', 'email', 'status', 'uses', 'expires_at'],
  );
}

// Revoke: DELETE /api/invites/:id
export async function revoke(args: {
  id?: string;
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  if (!args.id) {
    error('invitation id required (positional)');
    process.exit(2);
  }
  const { invitation } = await apiDelete<{
    invitation: { id: string; revokedAt: string; alreadyRevoked: boolean };
  }>(`/api/invites/${encodeURIComponent(args.id)}`, { api: auth.api, token: auth.token });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(invitation);
  success(`${invitation.alreadyRevoked ? 'Already revoked' : 'Revoked'} ${invitation.id} at ${invitation.revokedAt}`);
}

// Stats: GET /api/invites/stats
export async function stats(args: {
  token?: string;
  api?: string;
  output?: string;
}) {
  const auth = resolveAuth(args);
  const { stats } = await apiGet<{
    stats: { total: number; pending: number; used: number; expired: number; revoked: number };
  }>('/api/invites/stats', { api: auth.api, token: auth.token });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(stats);
  printTable(
    [stats] as unknown as Record<string, unknown>[],
    ['total', 'pending', 'used', 'expired', 'revoked'],
  );
}
