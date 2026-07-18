// Inbox handlers — full lifecycle (read, snooze, assign, archive, reply, draft).
// Server contract is in `~/projects/saas/quay/src/lib/inbox.ts`. State machine:
//   open ⇄ snoozed ⇄ closed (via mark-read / snooze / archive / unarchive)
//   assign / unassign updates assigneeEmail (independent axis from status).

import { resolveAuth } from '../config';
import { apiCall, apiGet, apiPost, apiDelete, ApiError } from '../api';
import {
  detectOutputFormat, printJson, printTable,
  error, success, info, warn, withSpinner, runSuccess,
} from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';
import { openEditor } from '../lib/editor';
import { confirmByTyping } from '../lib/confirm';
import { renderTemplate, readTemplate } from '../lib/templates';
import { parseSnoozeUntil } from '../lib/snooze-parse';
import { deriveDraftSendKey, deriveReplyKey, deriveSendKey } from '../lib/idempotency-key';
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

// ─── Network-failure recovery (KEH-164) ────────────────────────────────
// When the send request throws a kind 'network' ApiError (fetch failed - the
// response was lost in transit, e.g. WSL/Clash blip), the server may already
// have processed the send. Reporting a bare failure invites a blind retry, so
// before reporting anything we re-query and check whether a fresh outbound
// actually landed. ONLY kind 'network' gets this treatment: 'timeout' means
// the CLI aborted the request itself, and 'api' errors carry a definitive
// server verdict - both keep their original behavior.

// Client and server clocks can drift; an outbound counts as "fresh" if it was
// recorded up to this long before the send attempt started.
const CLOCK_SKEW_ALLOWANCE_MS = 120_000;

type OutboundHit = { threadId: number; messageId: number };

function isFreshOutbound(
  m: { direction: string; received_at?: string },
  cutoffMs: number,
): boolean {
  if (m.direction !== 'outbound') return false;
  if (!m.received_at) return true; // no timestamp -> don't disqualify
  const t = Date.parse(m.received_at);
  return Number.isNaN(t) || t >= cutoffMs;
}

// Probe a known thread (reply / draft send) for an outbound that appeared
// around the send attempt. `preSendOutboundIds` (when the caller already
// fetched the thread pre-send) additionally excludes pre-existing outbounds.
async function probeThreadForNewOutbound(
  auth: { api: string; token: string },
  siteId: number,
  threadId: number,
  opts: { preSendOutboundIds?: Set<number>; sinceMs: number },
): Promise<OutboundHit | null> {
  const data = await apiGet<{ messages: Array<{ id: number; direction: string; received_at?: string }> }>(
    `/api/sites/${siteId}/inbox/threads/${threadId}`,
    { api: auth.api, token: auth.token },
  );
  const cutoff = opts.sinceMs - CLOCK_SKEW_ALLOWANCE_MS;
  const fresh = data.messages.filter((m) =>
    !opts.preSendOutboundIds?.has(m.id) && isFreshOutbound(m, cutoff),
  );
  return fresh.length > 0 ? { threadId, messageId: fresh[fresh.length - 1].id } : null;
}

// ─── Cold-send network-failure recovery (KEH-164 round 3) ──────────────
// Rounds 1-2 probed the recent-threads list to identify the failed send's new
// thread; Gate rejected both because ANY recency-window mechanism is racy (a
// pre-existing matching thread just outside the window can be bumped in by
// unrelated activity). Round 3 abandons probing entirely: the Idempotency-Key
// header already carries a client-unique token with the send, and the server's
// reserve/replay store (arcops-server src/lib/idempotency.ts) is the
// authoritative record of it. Recovery = re-issue the IDENTICAL request with
// the SAME key:
//   - original was processed  -> the server replays the stored first result
//     (NO duplicate side effect) -> positively confirmed landed.
//   - original never arrived  -> the retry performs the send, exactly once
//     overall - which is the intended end state anyway.
//   - 409 idempotency_in_progress -> the original is still in flight (or
//     crashed after the side effect but before commit) -> bounded backoff,
//     then re-evaluate; exhausting the budget reports status unknown.
//   - network error again -> status unknown + manual check.
// No clocks, no list ordering, and no other actor's activity can tilt the
// verdict, and the ambiguity fallback never guesses success.

// Total same-key retry budget after the original network failure.
const RECOVERY_MAX_ATTEMPTS = 3;
// Cap on each 409-in_progress wait so a persistently in-flight original
// (crashed post-side-effect, pre-commit) fails fast instead of parking the
// CLI for the server's 5-minute in_progress TTL.
const RECOVERY_IN_PROGRESS_WAIT_CAP_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Re-issue the failed send with the same Idempotency-Key until it succeeds
// (replay or exactly-once completion), the budget runs out, or a definitive
// server verdict surfaces. Returns the send result on success; throws an
// ApiError describing the unknown status otherwise. Non-network, non-409
// errors (4xx/5xx, idempotency_conflict) are re-thrown as-is.
async function resendWithSameKey<T>(opts: {
  send: () => Promise<T>;
  networkError: ApiError; // the original failure, for the unknown-status message
  manualCheck: string;    // e.g. `arcops inbox ls <site>`
}): Promise<T> {
  let lastNetworkError = opts.networkError;
  let sawInProgress = false;
  for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
    try {
      return await opts.send();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'api' && e.code === 'idempotency_in_progress') {
        sawInProgress = true;
        const detail = e.detail as { retry_after_sec?: unknown } | undefined;
        const waitSec = typeof detail?.retry_after_sec === 'number' ? detail.retry_after_sec : 5;
        const waitMs = Math.min(waitSec * 1000, RECOVERY_IN_PROGRESS_WAIT_CAP_MS);
        info(`Original send still in flight on the server; re-checking in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${RECOVERY_MAX_ATTEMPTS})…`);
        await sleep(waitMs);
        continue;
      }
      if (e instanceof ApiError && e.kind === 'network') {
        lastNetworkError = e;
        continue;
      }
      throw e;
    }
  }
  // Budget exhausted: report unknown, never a guessed success (CEO r3
  // ambiguity fallback).
  throw new ApiError(0,
    `Send request failed (network): ${opts.networkError.message}. ` +
    (sawInProgress
      ? `The same-key retry kept finding the original request in flight, so its outcome cannot be confirmed. ` +
        `Send status unknown - confirm manually with: ${opts.manualCheck} before re-running (a post-crash re-run is deduped by the idempotency key only if the original never reached the side effect).`
      : `The same-key retry also failed to reach the server (${lastNetworkError.message}). ` +
        `Send status unknown - confirm manually with: ${opts.manualCheck}. Re-running the same command is safe: the idempotency key replays a completed send instead of duplicating it.`),
    { kind: 'network' },
  );
}

// Shared verdict for the three send call sites. Returns the probe hit when
// the outbound is confirmed landed (caller reports success, exit 0). Throws
// otherwise: not-landed -> failure with the safe-to-retry hint (the stable
// idempotency key replays server-side, no duplicate); probe failure -> send
// status unknown with a manual-check command. Thrown errors surface through
// dispatch's emitError (JSON envelope in pipe mode, exit 1).
async function verifyAfterSendNetworkError(opts: {
  networkError: ApiError;
  probe: () => Promise<OutboundHit | null>;
  manualCheck: string; // e.g. `arcops inbox show <site> <thread>`
}): Promise<OutboundHit> {
  warn(`Send request failed (network): ${opts.networkError.message}`);
  info('Verifying whether the outbound actually landed before reporting failure…');
  let hit: OutboundHit | null;
  try {
    hit = await opts.probe();
  } catch (e) {
    throw new ApiError(0,
      `Send request failed (network) and the verify query also failed (${(e as Error).message}). ` +
      `Send status unknown - confirm manually with: ${opts.manualCheck}`,
      { kind: 'network' },
    );
  }
  if (!hit) {
    throw new ApiError(0,
      `Send request failed (network): ${opts.networkError.message}. ` +
      `Verify found no new outbound - the message was NOT sent. ` +
      `Safe to retry: the idempotency key will replay, no duplicate send.`,
      { kind: 'network' },
    );
  }
  return hit;
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
}, siteDomain: string, lastInboundFrom?: string): Record<string, string | undefined> {
  return {
    thread_subject: thread.subject ?? '',
    customer_email: lastInboundFrom ?? thread.participant_emails?.[0] ?? '',
    site_domain: siteDomain,
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
  from?: string; search?: string; limit?: string; cursor?: string;
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
  // Cursor pagination (C4): hand back the opaque `nextCursor` from the previous
  // page to fetch the next. Treated as a black box - the server owns the format.
  if (args.cursor) query.cursor = args.cursor;

  const data = await apiGet<{
    threads: Record<string, unknown>[];
    counts: Record<string, number>;
    nextCursor?: string | null;
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
  // Surface the next-page cursor so an agent (or human) can page through a
  // large inbox without parsing JSON. Absent => last page.
  if (data.nextCursor) {
    info(`More results: arcops inbox ls ${site.domain} --cursor ${data.nextCursor}`);
  }
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
  'idempotency-key'?: string;
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
  const vars = templateVarsFromThread(data.thread, site.domain, lastInboundFrom);

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

  // C1/KEH-116: stable Idempotency-Key so a retry replays the first result on
  // the server instead of sending a second reply. --idempotency-key overrides.
  const idempotencyKey = args['idempotency-key'] ?? deriveReplyKey(site.id, threadId, body, attachPaths);

  const start = Date.now();
  // Snapshot pre-send outbound ids (free - the preview GET already ran) so a
  // network-error probe can tell a freshly landed reply from old outbounds.
  const preSendOutboundIds = new Set(
    data.messages.filter((m) => m.direction === 'outbound').map((m) => m.id),
  );
  // Capture the server-returned messageId so verify-after-send confirms THAT
  // message exists on the thread. This works for both a fresh send (new
  // messageId) AND an idempotent replay (server returns the original messageId
  // without creating a new outbound). The old pre-send-snapshot approach
  // falsely reported failure on replay because no NEW outbound appeared.
  let result: { messageId: number };
  try {
    result = await withSpinner(`Sending reply to ${recipients}…`, async () => {
      if (attachPaths.length === 0) {
        return apiPost<{ messageId: number }>(
          `/api/sites/${site.id}/inbox/threads/${threadId}/reply`,
          { api: auth.api, token: auth.token, idempotencyKey, body: { body } },
        );
      }
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
      return apiCall<{ messageId: number }>(
        `/api/sites/${site.id}/inbox/threads/${threadId}/reply`,
        { api: auth.api, token: auth.token, idempotencyKey, method: 'POST', body: fd },
      );
    });
  } catch (e) {
    // KEH-164: a lost response (network) is not proof of failure - the server
    // may have processed the reply. Verify before reporting anything.
    if (!(e instanceof ApiError && e.kind === 'network')) throw e;
    const hit = await verifyAfterSendNetworkError({
      networkError: e,
      probe: () => probeThreadForNewOutbound(auth, site.id, threadId, { preSendOutboundIds, sinceMs: start }),
      manualCheck: `arcops inbox show ${site.domain} ${threadId}`,
    });
    runSuccess({
      title: 'Reply sent',
      elapsedMs: Date.now() - start,
      extra: `send request failed (network), but verify confirms it landed as message #${hit.messageId}`,
    });
    return;
  }
  await verifyOutboundLanded(auth, site.id, threadId, { expectedMessageId: result.messageId });
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
  'idempotency-key'?: string;
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

  // C1/KEH-116: stable Idempotency-Key so a retry replays the first result on
  // the server instead of sending a second email. --idempotency-key overrides.
  const idempotencyKey = args['idempotency-key']
    ?? deriveSendKey(site.id, { to: toList, cc: ccList, subject, body, fromLocal }, attachPaths);

  const start = Date.now();
  // The send request is a named function so the network-error recovery can
  // re-issue the IDENTICAL request (same Idempotency-Key) - see the catch.
  const doSend = (): Promise<{ threadId: number; messageId: number }> => {
    if (attachPaths.length === 0) {
      return apiPost<{ threadId: number; messageId: number }>(
        `/api/sites/${site.id}/inbox/send`,
        {
          api: auth.api, token: auth.token, idempotencyKey,
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
      { api: auth.api, token: auth.token, idempotencyKey, body: fd },
    );
  };
  let result: { threadId: number; messageId: number };
  try {
    result = await withSpinner(`Sending new email to ${toList.join(', ')}…`, doSend);
  } catch (e) {
    // KEH-164 r3: a lost response (network) is not proof of failure. Re-issue
    // the identical request with the same Idempotency-Key: a processed
    // original replays its stored result (no duplicate), an unprocessed one
    // is completed by this retry - exactly once either way. No probing, no
    // recency windows, race-free by the server's (site_id, key) uniqueness.
    if (!(e instanceof ApiError && e.kind === 'network')) throw e;
    warn(`Send request failed (network): ${e.message}`);
    info('Retrying with the same Idempotency-Key: a processed send replays its stored result (no duplicate); an unreceived one is completed by this retry, exactly once…');
    result = await resendWithSameKey({
      send: doSend,
      networkError: e,
      manualCheck: `arcops inbox ls ${site.domain}`,
    });
    // Same contract-item-3 guarantee as the normal path: the reported
    // messageId must exist on the thread before claiming success.
    await verifyOutboundLanded(auth, site.id, result.threadId, { expectedMessageId: result.messageId });
    runSuccess({
      title: 'Email sent',
      elapsedMs: Date.now() - start,
      extra: `send request failed (network); same-key retry confirms exactly one outbound on thread #${result.threadId} as message #${result.messageId}`,
    });
    const fmt = detectOutputFormat(args.output);
    if (fmt === 'json') return printJson(result);
    return;
  }

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
    const vars = templateVarsFromThread(data.thread, site.domain, lastInboundFrom);

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
    'idempotency-key'?: string;
    token?: string; api?: string; output?: string;
  }) {
    const auth = resolveAuth(args);
    const site = await resolveSiteOrExit(args.site ?? '', auth);
    const threadId = requireThreadId(args);
    const draftId = requireDraftId(args);

    // The preview GET is interactive UX only. On the --yes (agent) path skip
    // it entirely: the drafts read route filters out sent drafts, so a RETRY
    // of an already-sent draft would 404 at the preview and never reach the
    // send endpoint's idempotency replay (second production-e2e bug). The send
    // endpoint is the sole authority on draft state.
    if (args.yes !== 'true') {
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

      const ok = await confirmByTyping(site.domain, `Type the site domain (${site.domain}) to confirm send: `);
      if (!ok) { error('Send aborted.'); process.exit(1); }
    }

    // C1/KEH-116: draftId is the natural stable key - a retry of the same
    // draft send reuses it, so the server replays the first result instead of
    // sending a second outbound. --idempotency-key overrides.
    const idempotencyKey = args['idempotency-key'] ?? deriveDraftSendKey(site.id, draftId);

    const start = Date.now();
    let result: { messageId: number };
    try {
      result = await withSpinner(`Sending draft #${draftId}…`, async () => {
        return apiPost<{ messageId: number }>(
          `/api/sites/${site.id}/inbox/threads/${threadId}/drafts/${draftId}/send`,
          { api: auth.api, token: auth.token, idempotencyKey },
        );
      });
    } catch (e) {
      // KEH-164: lost response (network) - the server may have promoted the
      // draft already. No pre-send snapshot on the --yes path, so the probe
      // relies on the outbound's timestamp vs the send attempt.
      if (!(e instanceof ApiError && e.kind === 'network')) throw e;
      const hit = await verifyAfterSendNetworkError({
        networkError: e,
        probe: () => probeThreadForNewOutbound(auth, site.id, threadId, { sinceMs: start }),
        manualCheck: `arcops inbox show ${site.domain} ${threadId}`,
      });
      runSuccess({
        title: 'Draft sent',
        elapsedMs: Date.now() - start,
        extra: `send request failed (network), but verify confirms it landed as message #${hit.messageId}`,
      });
      if (detectOutputFormat(args.output) === 'json') return printJson({ messageId: hit.messageId });
      return;
    }
    // verify-after-send (contract item 3): confirm the promoted draft landed
    // as an outbound message on the thread.
    await verifyOutboundLanded(auth, site.id, threadId, { expectedMessageId: result.messageId });
    const fmt = detectOutputFormat(args.output);
    if (fmt === 'json') return printJson(result);
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
