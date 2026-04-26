import { resolveAuth } from '../config';
import { apiGet, apiPost } from '../api';
import { detectOutputFormat, printJson, printTable, error, success, withSpinner, runSuccess } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';
import { openEditor } from '../lib/editor';
import { confirmByTyping } from '../lib/confirm';
import { readFileSync } from 'node:fs';

export async function ls(args: {
  site?: string; unread?: string; status?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const query: Record<string, string | number | undefined> = {};
  if (args.unread) query.unread = args.unread;
  if (args.status) query.status = args.status;
  const data = await apiGet<{ threads: Record<string, unknown>[] }>(
    `/api/sites/${site.id}/inbox/threads`,
    { api: auth.api, token: auth.token, query },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data.threads);
  printTable(data.threads, ['id', 'subject', 'last_message_at', 'unread_for_ops']);
}

export async function show(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  if (!args['thread-id']) { error('thread-id required'); process.exit(2); }
  const threadId = Number(args['thread-id']);
  if (!Number.isFinite(threadId)) { error('invalid thread id'); process.exit(2); }
  const data = await apiGet<{ thread: Record<string, unknown>; messages: Record<string, unknown>[] }>(
    `/api/sites/${site.id}/inbox/threads/${threadId}`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  process.stderr.write(`Thread: ${data.thread.subject}\n`);
  printTable(data.messages as Record<string, unknown>[], ['from_email', 'subject', 'created_at']);
}

export async function archive(args: {
  site?: string; 'thread-id'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  if (!args['thread-id']) { error('thread-id required'); process.exit(2); }
  const threadId = Number(args['thread-id']);
  if (!Number.isFinite(threadId)) { error('invalid thread id'); process.exit(2); }
  await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/close`, {
    api: auth.api, token: auth.token,
  });
  success(`Thread ${threadId} archived.`);
}

export async function draft(args: {
  site?: string; 'thread-id'?: string;
  body?: string; 'body-file'?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = Number(args['thread-id']);
  if (!Number.isFinite(threadId)) { error('thread-id required'); process.exit(2); }

  let body: string | undefined = args.body;
  if (!body && args['body-file']) {
    const file = args['body-file'];
    body = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  }
  if (!body) {
    body = openEditor('', `Draft reply to thread #${threadId} on ${site.domain}\nLines starting with # are stripped.`);
  }

  const result = await apiPost<{ draft: { id: number } }>(
    `/api/sites/${site.id}/inbox/threads/${threadId}/drafts`,
    { api: auth.api, token: auth.token, body: { body_text: body } },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(result);
  success(`Draft #${result.draft.id} saved. Review + send in the web UI.`);
}

export async function reply(args: {
  site?: string; 'thread-id'?: string;
  body?: string; 'body-file'?: string; yes?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const threadId = Number(args['thread-id']);
  if (!Number.isFinite(threadId)) { error('thread-id required'); process.exit(2); }

  const { thread } = await apiGet<{
    thread: { subject: string; participant_emails: string[] };
    messages: { fromEmail: string; subject: string }[];
  }>(`/api/sites/${site.id}/inbox/threads/${threadId}`, auth);

  let body: string | undefined = args.body;
  if (!body && args['body-file']) {
    const file = args['body-file'];
    body = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  }
  if (!body) {
    body = openEditor('', `Reply to thread #${threadId} (${thread.subject}) on ${site.domain}.`);
  }

  const recipients = thread.participant_emails.join(', ');
  const subject = thread.subject || 'Re: (no subject)';
  process.stderr.write(`\n─ Reply preview ─────────────────────────────────────\n`);
  process.stderr.write(`Site:     ${site.domain}\n`);
  process.stderr.write(`To:       ${recipients}\n`);
  process.stderr.write(`Subject:  ${subject}\n`);
  process.stderr.write(`Body:     [${body.length} chars]\n`);
  process.stderr.write(body.split('\n').map(l => '          ' + l).join('\n') + '\n');
  process.stderr.write(`─────────────────────────────────────────────────────\n`);

  if (args.yes !== 'true') {
    const ok = await confirmByTyping(site.domain, `Type the site domain (${site.domain}) to confirm send: `);
    if (!ok) { error('Send aborted.'); process.exit(1); }
  }

  const start = Date.now();
  await withSpinner(`Sending reply to ${recipients}…`, async () => {
    await apiPost(`/api/sites/${site.id}/inbox/threads/${threadId}/reply`, {
      api: auth.api, token: auth.token,
      body: { body },
    });
  });
  runSuccess({ title: 'Reply sent', elapsedMs: Date.now() - start, extra: recipients });
}
