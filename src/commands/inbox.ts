import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable, error } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

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
