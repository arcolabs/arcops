// C1/KEH-116: derive stable Idempotency-Key values for the email-sending write
// verbs. The key MUST be stable across retries of the same logical operation -
// otherwise the server cannot dedupe (a fresh key per attempt = a second send).
//
// - draft send: draftId is the natural stable identifier.
// - reply / send: derive from a sha256 of the logical payload + attachment
//   content hashes, so a genuine retry (same content) reuses the key while a
//   distinct email (different body / recipients) gets a distinct key and sends.
//
// The CLI-derived key and the server-computed fingerprint are independent: the
// key is the identifier the client reuses; the fingerprint is the server's
// integrity check (it recomputes its own from the parsed payload). They do not
// need to use the same algorithm - only the key must be stable across retries.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

function sha256hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

// Stable combined hash of attachment file contents, read from disk in flag
// order. Two retries with the same files in the same order hash identically.
function hashAttachmentPaths(paths: string[]): string {
  if (paths.length === 0) return '';
  return paths.map((p) => sha256hex(readFileSync(p))).join(':');
}

export function deriveDraftSendKey(siteId: number, draftId: number): string {
  return `arcops-draft-${siteId}-${draftId}`;
}

export function deriveReplyKey(
  siteId: number,
  threadId: number,
  body: string,
  attachPaths: string[],
  replyAll = false,
): string {
  const base = `arcops-reply-${siteId}-${threadId}-${sha256hex(body + '\n' + hashAttachmentPaths(attachPaths))}`;
  // Reply-all and sender-only are DIFFERENT logical operations (the server's
  // fingerprint includes replyAll), so they must not share an idempotency key
  // - a same-body sender-only retry would otherwise 409 against a prior
  // reply-all send. The suffix only applies when replyAll=true, keeping the
  // default key byte-identical to pre-reply-all CLI versions.
  return replyAll ? `${base}::reply-all` : base;
}

export function deriveSendKey(
  siteId: number,
  args: { to: string[]; cc: string[]; subject: string; body: string; fromLocal: string },
  attachPaths: string[],
): string {
  // Fixed-shape literal => JSON.stringify is deterministic across retries.
  const payload = JSON.stringify({
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body: args.body,
    from: args.fromLocal,
  });
  return `arcops-send-${siteId}-${sha256hex(payload + '\n' + hashAttachmentPaths(attachPaths))}`;
}
