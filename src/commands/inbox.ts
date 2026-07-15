// Inbox handlers — full lifecycle (read, snooze, assign, archive, reply, draft).
// Server contract is in `~/projects/saas/quay/src/lib/inbox.ts`. State machine:
//   open ⇄ snoozed ⇄ closed (via mark-read / snooze / archive / unarchive)
//   assign / unassign updates assigneeEmail (independent axis from status).

import { resolveAuth } from '../config';
import { apiCall, apiGet, apiPost, apiDelete } from '../api';
import {
  detectOutputFormat, printJson, printTable,
  error, success, info, withSpinner, runSuccess,
} from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';
import { openEditor } from '../lib/editor';
import { confirmByTyping } from '../lib/confirm';
import { renderTemplate, readTemplate } from '../lib/templates';
import { parseSnoozeUntil } from '../lib/snooze-parse';
import { splitList } from '../dispatch';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

// Map common attachment extensions to MIME types. The server (formidable)
// trusts the part's Content-Type, and Cloudflare forwards it as-is, so a
// missing type lands as application/octet-stream — which makes some mail
// clients show a PDF/image as a generic blob. Dependency-free on purpose;
// covers the file kinds we actually email (invoices, receipts, exports).
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeForFile(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

// ─── Helpers ──────────────────────────────────────────────────────────

function requireThreadId(args: { 'thread-id'?: string }): number {
  const id = Number(args['thread-id']);
  if (!Number.isFinite(id)) { error('thread-id required'); process.exit(2); }
  return id;
}

function requireDraftId(args: { 'draft-id'?: string }): number {
  const id = Number(args['draft-id']);
  if (!Number.isFinite(id)) { error('draft-id required'); process.exit(2); }
  return id;
}

// --attach is a repeatable flag (one file per occurrence). A comma-separated
// value like `--attach a.pdf,b.pdf` is a common mistake - the whole string
// becomes one filename and ENOENTs. Reject it explicitly with a clear message
// instead of letting it surface as a confusing read/stat error (contract item
// 1: failures must exit non-zero with an actionable cause).
function parseAttachPaths(raw: string | undefined): string[] {
  const paths = splitList(raw);
  for (const p of paths) {
    if (p.includes(',')) {
      error(`--attach takes one file per flag; repeat --attach for multiple files (comma-separated lists are not supported). Got: ${p}`);
      process.exit(2);
    }
  }
  return paths;
}

// verify-after-send (contract item 3): after a send-class action returns
// success, re-fetch the thread and confirm an outbound message actually
// landed. The server creates the inbox_messages row synchronously in the same
// request, so if it is missing the email did not send - exit non-zero with a
// clear cause instead of the old "exit 0 but nothing went out" failure mode.
// `expectedMessageId` (from send / draft.send responses) is checked first;
// otherwise a new outbound vs `preSendOutboundIds` proves the send landed.
async function verifyOutboundLanded(
  auth: { api: string; token: string },
  siteId: number,
  threadId: number,
  opts: { expectedMessageId?: number; preSendOutboundIds?: Set<number> } = {},
): Promise<void> {
  const data = await apiGet<{ messages: Array<{ id: number; direction: string }> }>(
    `/api/sites/${siteId}/inbox/threads/${threadId}`,
    { api: auth.api, token: auth.token },
  );
  const outbounds = data.messages.filter((m) => m.direction === 'outbound');
  let landed: boolean;
  if (opts.expectedMessageId !== undefined) {
    landed = outbounds.some((m) => m.id === opts.expectedMessageId);
  } else {
    const pre = opts.preSendOutboundIds ?? new Set<number>();
    landed = outbounds.some((m) => !pre.has(m.id));
  }
  if (!landed) {
    throw new Error(
      `Send returned success but no outbound message landed on thread ${threadId} - the email may not have been sent. ` +
      `Re-check with: arcops inbox show <site> ${threadId}`,
    );
  }
}

// Resolve reply body from any of: --body, --body-file, --template, $EDITOR.
// Returns { body, source } so callers can label preview output.
async function resolveBody(args: {
  body?: string;
  'body-file'?: string;
  template?: string;
}, ctx: { editorSeed?: string; templateVars?: Record<string, string | undefined> }): Promise<{ body: string; source: string }> {
  if (args.body) return { body: args.body, source: 'flag' };

  if (args['body-file']) {
    const file = args['body-file'];
    const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
    return { body: raw, source: file === '-' ? 'stdin' : `file:${file}` };
  }

  if (args.template) {
    const raw = readTemplate(args.template);
    const rendered = renderTemplate(raw, ctx.templateVars ?? {});
    return { body: rendered, source: `template:${args.template}` };
  }

  // pipe / non-TTY must never block on an interactive editor (contract item
  // 4). Require an explicit body source when stdin is not a TTY.
  if (!process.stdin.isTTY) {
    error('No body source provided (--body, --body-file, or --template) and stdin is not a TTY; refusing to open an interactive editor.');
    process.exit(2);
  }
  const edited = openEditor('', ctx.editorSeed ?? 'Compose your reply.');
  return { body: edited, source: 'editor' };
}

function templateVarsFromThread(thread: {
  subject?: string | null;
  participant_emails?: string[];
}, lastInboundFrom?: string): Record<string, string | undefined> {
  return {
    thread_subject: thread.subject ?? '',
    customer_email: lastInboundFrom ?? thread.participant_emails?.[0] ?? '',
  };
}

// Quote the most recent inbound message body inline. Server stores bodies
// per-message so we round-trip an extra GET. No-op if there's no inbound.
async function buildQuotedReply(
  body: string,
  auth: { api: string; token: string },
  siteId: number,
  threadId: number,
  thread: { messages?: Array<{ id: number; from_email: string; received_at: string; direction: string }> },
): Promise<string> {
  const messages = thread.messages ?? [];
  // pick most recent inbound
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  if (!lastInbound) {
    info('--quote: no inbound message on this thread, skipping quote');
    return body;
  }
  const { text } = await apiGet<{ text: string | null; html: string | null }>(
    `/api/sites/${siteId}/inbox/messages/${lastInbound.id}/body`,
    { api: auth.api, token: auth.token },
  );
  if (!text || !text.trim()) {
    info('--quote: prior message has no plain-text body, skipping quote');
    return body;
  }
  const date = new Date(lastInbound.received_at).toUTCString();
  const quoted = text.split('\n').map((l) => '> ' + l).join('\n');
  return `${body}\n\nOn ${date}, ${lastInbound.from_email} wrote:\n${quoted}\n`;
}

// ─── Listing + reading ────────────────────────────────────────────────

export async function ls(args: {
  site?: string;
  unread?: string; status?: string; assignee?: string; unassigned?: string;
  from?: string; search?: string; limit?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = {};
  if (args.unread === 'true') query.unread = 'true';
  if (args.status) query.status = args.status;
  if (args.unassigned === 'true') query.assignee = 'unassigned';
  else if (args.assignee) query.assignee = args.assignee;
  if (args.from) query.from = args.from;
  if (args.search) query.search = args.search;
  if (args.limit) query.limit = args.limit;

  const data = await apiGet<{
    threads: Record<string, unknown>[];
    counts: Record<string, number>;
  }>(`/api/sites/${site.id}/inbox/threads`, { api: auth.api, token: auth.token, query });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  if (data.counts) {
    const c = data.counts;
    info(`open=${c.open ?? 0}  waiting=${c.waiting ?? 0}  snoozed=${c.snoozed ?? 0}  closed=${c.closed ?? 0}`);
  }
  printTable(
    data.threads,
    ['id', 'subject', 'last_message_at', 'unread_for_ops', 'assignee_email', 'status'],
  );
}

export async function show(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);

  const data = await apiGet<{
    thread: Record<string, unknown>;
    messages: Record<string, unknown>[];
  }>(`/api/sites/${site.id}/inbox/threads/${threadId}`, { api: auth.api, token: auth.token });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  process.stderr.write(`Thread: ${data.thread.subject}\n`);
  process.stderr.write(
    `Status: ${data.thread.status}  Unread: ${data.thread.unread_for_ops}  Assignee: ${data.thread.assignee_email ?? '—'}\n`,
  );
  printTable(data.messages, ['id', 'from_email', 'subject', 'direction', 'received_at']);
}

// ─── State mutations ──────────────────────────────────────────────────

export async function read(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/mark-read`, {
    api: auth.api, token: auth.token,
  });
  success(`Thread ${threadId} marked read.`);
}

export async function snooze(args: {
  site?: string; 'thread-id'?: string; until?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);
  if (!args.until) { error('--until is required (e.g. 3d, tomorrow, 2026-05-01T09:00Z)'); process.exit(2); }
  const untilIso = parseSnoozeUntil(args.until);
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/snooze`, {
    api: auth.api, token: auth.token,
    body: { until: untilIso },
  });
  success(`Thread ${threadId} snoozed until ${untilIso}.`);
}

export async function assign(args: {
  site?: string; 'thread-id'?: string; to?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);
  if (!args.to || !args.to.includes('@')) { error('--to <email> is required'); process.exit(2); }
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/assign`, {
    api: auth.api, token: auth.token,
    body: { email: args.to },
  });
  success(`Thread ${threadId} assigned to ${args.to}.`);
}

export async function unassign(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/assign`, {
    api: auth.api, token: auth.token,
    body: { email: null },
  });
  success(`Thread ${threadId} unassigned.`);
}

export async function archive(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/close`, {
    api: auth.api, token: auth.token,
  });
  success(`Thread ${threadId} archived.`);
}

export async function unarchive(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/open`, {
    api: auth.api, token: auth.token,
  });
  success(`Thread ${threadId} reopened.`);
}

// ─── Reply (with templates / attachments / quote) ─────────────────────

type ThreadShowResult = {
  thread: {
    subject: string | null;
    participant_emails: string[];
    status: string;
    assignee_email: string | null;
  };
  messages: Array<{ id: number; from_email: string; received_at: string; direction: string }>;
};

export async function reply(args: {
  site?: string; 'thread-id'?: string;
  body?: string; 'body-file'?: string; template?: string;
  attach?: string; quote?: string; yes?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = requireThreadId(args);

  const data = await apiGet<ThreadShowResult>(
    `/api/sites/${site.id}/inbox/threads/${threadId}`,
    { api: auth.api, token: auth.token },
  );

  const lastInboundFrom = [...data.messages].reverse().find((m) => m.direction === 'inbound')?.from_email;
  const vars = templateVarsFromThread(data.thread, lastInboundFrom);

  let { body, source } = await resolveBody(args, {
    editorSeed: `Reply to thread #${threadId} (${data.thread.subject}) on ${site.domain}.`,
    templateVars: vars,
  });

  if (args.quote === 'true') {
    body = await buildQuotedReply(body, auth, site.id, threadId, data);
  }

  const attachPaths = parseAttachPaths(args.attach);
  const recipients = data.thread.participant_emails.join(', ');
  const subject = data.thread.subject || 'Re: (no subject)';

  process.stderr.write(`\n─ Reply preview ─────────────────────────────────────\n`);
  process.stderr.write(`Site:     ${site.domain}\n`);
  process.stderr.write(`To:       ${recipients}\n`);
  process.stderr.write(`Subject:  ${subject}\n`);
  process.stderr.write(`Source:   ${source}\n`);
  if (attachPaths.length > 0) {
    process.stderr.write(`Attach:   ${attachPaths.map((p) => `${basename(p)} (${statSync(p).size}B)`).join(', ')}\n`);
  }
  process.stderr.write(`Body:     [${body.length} chars]\n`);
  process.stderr.write(body.split('\n').map((l) => '          ' + l).join('\n') + '\n');
  process.stderr.write(`─────────────────────────────────────────────────────\n`);

  if (args.yes !== 'true') {
    const ok = await confirmByTyping(site.domain, `Type the site domain (${site.domain}) to confirm send: `);
    if (!ok) { error('Send aborted.'); process.exit(1); }
  }

  // Snapshot outbound message ids before send so verify-after-send can prove
  // a *new* outbound landed (contract item 3).
  const preSendOutboundIds = new Set(
    data.messages.filter((m) => m.direction === 'outbound').map((m) => m.id),
  );

  const start = Date.now();
  await withSpinner(`Sending reply to ${recipients}…`, async () => {
    if (attachPaths.length === 0) {
      await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/reply`, {
        api: auth.api, token: auth.token,
        body: { body },
      });
    } else {
      const fd = new FormData();
      fd.append('body', body);
      for (const p of attachPaths) {
        const buf = readFileSync(p);
        fd.append(
          'attachments',
          new Blob([buf], { type: mimeForFile(p) }),
          basename(p),
        );
      }
      await apiCall(`/api/sites/${site.id}/inbox/threads/${threadId}/reply`, {
        api: auth.api, token: auth.token,
        method: 'POST',
        body: fd,
      });
    }
  });
  await verifyOutboundLanded(auth, site.id, threadId, { preSendOutboundIds });
  runSuccess({ title: 'Reply sent', elapsedMs: Date.now() - start, extra: recipients });
}

// ─── Outbound new thread (cold send / customer-initiated chat fallback) ──

// Parse `--to a@x.com,b@y.com` into a trimmed, deduped, lowercased list.
// Comma-separated keeps the flag count down vs `--to a --to b` and matches
// how operators paste recipients from other tools.
function parseEmailList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const e = part.trim().toLowerCase();
    if (!e) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

export async function send(args: {
  site?: string;
  to?: string; cc?: string;
  subject?: string;
  from?: string;
  body?: string; 'body-file'?: string; template?: string;
  attach?: string;
  yes?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);

  const toList = parseEmailList(args.to);
  if (toList.length === 0) { error('--to <email>[,email...] is required'); process.exit(2); }
  const ccList = parseEmailList(args.cc);
  for (const e of [...toList, ...ccList]) {
    if (!e.includes('@')) { error(`Invalid email: ${e}`); process.exit(2); }
  }

  const subject = (args.subject ?? '').trim();
  if (!subject) { error('--subject <text> is required'); process.exit(2); }

  const fromLocal = (args.from ?? 'support').trim();

  const { body, source } = await resolveBody(args, {
    editorSeed: `New email to ${toList.join(', ')} on ${site.domain}\nSubject: ${subject}`,
    templateVars: {
      site_domain: site.domain,
      customer_email: toList[0],
    },
  });
  if (!body || !body.trim()) { error('Body is empty.'); process.exit(2); }

  const attachPaths = parseAttachPaths(args.attach);

  process.stderr.write(`\n─ Send preview ──────────────────────────────────────\n`);
  process.stderr.write(`Site:     ${site.domain}\n`);
  process.stderr.write(`From:     ${fromLocal}@${site.domain}\n`);
  process.stderr.write(`To:       ${toList.join(', ')}\n`);
  if (ccList.length > 0) process.stderr.write(`Cc:       ${ccList.join(', ')}\n`);
  process.stderr.write(`Subject:  ${subject}\n`);
  process.stderr.write(`Source:   ${source}\n`);
  if (attachPaths.length > 0) {
    process.stderr.write(`Attach:   ${attachPaths.map((p) => `${basename(p)} (${statSync(p).size}B)`).join(', ')}\n`);
  }
  process.stderr.write(`Body:     [${body.length} chars]\n`);
  process.stderr.write(body.split('\n').map((l) => '          ' + l).join('\n') + '\n');
  process.stderr.write(`─────────────────────────────────────────────────────\n`);

  if (args.yes !== 'true') {
    const ok = await confirmByTyping(site.domain, `Type the site domain (${site.domain}) to confirm send: `);
    if (!ok) { error('Send aborted.'); process.exit(1); }
  }

  const start = Date.now();
  const result = await withSpinner(`Sending new email to ${toList.join(', ')}…`, async () => {
    if (attachPaths.length === 0) {
      return apiPost<{ threadId: number; messageId: number }>(
        `/api/sites/${site.id}/inbox/send`,
        {
          api: auth.api, token: auth.token,
          body: {
            to: toList,
            ...(ccList.length > 0 ? { cc: ccList } : {}),
            subject,
            body,
            from: fromLocal,
          },
        },
      );
    }
    // Multipart: comma-joined email lists match the server's splitEmails parse.
    const fd = new FormData();
    fd.append('to', toList.join(','));
    if (ccList.length > 0) fd.append('cc', ccList.join(','));
    fd.append('subject', subject);
    fd.append('body', body);
    fd.append('from', fromLocal);
    for (const p of attachPaths) {
      fd.append('attachments', new Blob([readFileSync(p)], { type: mimeForFile(p) }), basename(p));
    }
    return apiPost<{ threadId: number; messageId: number }>(
      `/api/sites/${site.id}/inbox/send`,
      { api: auth.api, token: auth.token, body: fd },
    );
  });

  // verify-after-send (contract item 3): confirm the outbound message the
  // server reported actually landed on the thread before claiming success.
  await verifyOutboundLanded(auth, site.id, result.threadId, { expectedMessageId: result.messageId });

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(result);
  runSuccess({
    title: 'Email sent',
    elapsedMs: Date.now() - start,
    extra: `thread #${result.threadId} • message #${result.messageId}`,
  });
}

// ─── Draft sub-namespace ──────────────────────────────────────────────

export const draft = {
  async create(args: {
    site?: string; 'thread-id'?: string;
    body?: string; 'body-file'?: string; template?: string; quote?: string;
    token?: string; api?: string; output?: string;
  }) {
    const auth = resolveAuth(args);
    const site = await resolveSiteOrExit(args.site ?? '', auth);
    const threadId = requireThreadId(args);

    const data = await apiGet<ThreadShowResult>(
      `/api/sites/${site.id}/inbox/threads/${threadId}`,
      { api: auth.api, token: auth.token },
    );
    const lastInboundFrom = [...data.messages].reverse().find((m) => m.direction === 'inbound')?.from_email;
    const vars = templateVarsFromThread(data.thread, lastInboundFrom);

    let { body, source } = await resolveBody(args, {
      editorSeed: `Draft reply to thread #${threadId} on ${site.domain}\nLines starting with # are stripped.`,
      templateVars: vars,
    });
    if (args.quote === 'true') {
      body = await buildQuotedReply(body, auth, site.id, threadId, data);
    }

    const result = await apiPost<{ draft: { id: number } }>(
      `/api/sites/${site.id}/inbox/threads/${threadId}/drafts`,
      { api: auth.api, token: auth.token, body: { body_text: body } },
    );
    const fmt = detectOutputFormat(args.output);
    if (fmt === 'json') return printJson(result);
    success(`Draft #${result.draft.id} saved (${source}). Send with: arcops inbox draft send ${site.domain} ${result.draft.id}`);
  },

  async ls(args: {
    site?: string; 'thread-id'?: string;
    token?: string; api?: string; output?: string;
  }) {
    const auth = resolveAuth(args);
    const site = await resolveSiteOrExit(args.site ?? '', auth);
    const threadId = requireThreadId(args);
    const data = await apiGet<{ drafts: Array<Record<string, unknown>> }>(
      `/api/sites/${site.id}/inbox/threads/${threadId}/drafts`,
      { api: auth.api, token: auth.token },
    );
    const fmt = detectOutputFormat(args.output);
    if (fmt === 'json') return printJson(data.drafts);
    if (data.drafts.length === 0) {
      info(`No pending drafts on thread ${threadId}.`);
      return;
    }
    printTable(data.drafts, ['id', 'createdAt', 'authorUserId']);
  },

  async show(args: {
    site?: string; 'thread-id'?: string; 'draft-id'?: string;
    token?: string; api?: string; output?: string;
  }) {
    const auth = resolveAuth(args);
    const site = await resolveSiteOrExit(args.site ?? '', auth);
    const threadId = requireThreadId(args);
    const draftId = requireDraftId(args);
    const data = await apiGet<{ draft: { id: number; bodyText: string; createdAt: string } }>(
      `/api/sites/${site.id}/inbox/threads/${threadId}/drafts/${draftId}`,
      { api: auth.api, token: auth.token },
    );
    const fmt = detectOutputFormat(args.output);
    if (fmt === 'json') return printJson(data.draft);
    process.stderr.write(`Draft #${data.draft.id}  •  created ${data.draft.createdAt}\n`);
    process.stdout.write(data.draft.bodyText);
    if (!data.draft.bodyText.endsWith('\n')) process.stdout.write('\n');
  },

  async send(args: {
    site?: string; 'thread-id'?: string; 'draft-id'?: string; yes?: string;
    token?: string; api?: string; output?: string;
  }) {
    const auth = resolveAuth(args);
    const site = await resolveSiteOrExit(args.site ?? '', auth);
    const threadId = requireThreadId(args);
    const draftId = requireDraftId(args);

    const { draft } = await apiGet<{ draft: { id: number; bodyText: string; createdAt: string } }>(
      `/api/sites/${site.id}/inbox/threads/${threadId}/drafts/${draftId}`,
      { api: auth.api, token: auth.token },
    );

    process.stderr.write(`\n─ Draft preview ─────────────────────────────────────\n`);
    process.stderr.write(`Site:     ${site.domain}\n`);
    process.stderr.write(`Draft:    #${draft.id} (${draft.createdAt})\n`);
    process.stderr.write(`Body:     [${draft.bodyText.length} chars]\n`);
    process.stderr.write(draft.bodyText.split('\n').map((l) => '          ' + l).join('\n') + '\n');
    process.stderr.write(`─────────────────────────────────────────────────────\n`);

    if (args.yes !== 'true') {
      const ok = await confirmByTyping(site.domain, `Type the site domain (${site.domain}) to confirm send: `);
      if (!ok) { error('Send aborted.'); process.exit(1); }
    }

    const start = Date.now();
    const result = await withSpinner(`Sending draft #${draftId}…`, async () => {
      return apiPost<{ messageId: number }>(
        `/api/sites/${site.id}/inbox/threads/${threadId}/drafts/${draftId}/send`,
        { api: auth.api, token: auth.token },
      );
    });
    // verify-after-send (contract item 3): confirm the promoted draft landed
    // as an outbound message on the thread.
    await verifyOutboundLanded(auth, site.id, threadId, { expectedMessageId: result.messageId });
    runSuccess({
      title: 'Draft sent',
      elapsedMs: Date.now() - start,
      extra: `message #${result.messageId}`,
    });
  },

  async rm(args: {
    site?: string; 'thread-id'?: string; 'draft-id'?: string;
    token?: string; api?: string; output?: string;
  }) {
    const auth = resolveAuth(args);
    const site = await resolveSiteOrExit(args.site ?? '', auth);
    const threadId = requireThreadId(args);
    const draftId = requireDraftId(args);
    await apiDelete(
      `/api/sites/${site.id}/inbox/threads/${threadId}/drafts/${draftId}`,
      { api: auth.api, token: auth.token },
    );
    success(`Draft #${draftId} discarded.`);
  },
};
