// Unit tests for CLI Idempotency-Key derivation (C1/KEH-116).
//
// The contract: a key MUST be stable across retries of the same logical
// operation (else the server can't dedupe -> second email). draftId is naturally
// stable; reply/send derive from a sha256 of the logical payload + attachment
// content hashes. These tests pin that stability + distinctness without a
// server (pure functions over file content).
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveDraftSendKey, deriveReplyKey, deriveSendKey } from './idempotency-key';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'idem-key-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('deriveDraftSendKey', () => {
  test('stable + keyed off site+draft id', () => {
    expect(deriveDraftSendKey(42, 7)).toBe('arcops-draft-42-7');
    expect(deriveDraftSendKey(42, 7)).toBe(deriveDraftSendKey(42, 7));
    // Different draft or site => different key.
    expect(deriveDraftSendKey(42, 7)).not.toBe(deriveDraftSendKey(42, 8));
    expect(deriveDraftSendKey(42, 7)).not.toBe(deriveDraftSendKey(43, 7));
  });
});

describe('deriveReplyKey', () => {
  test('stable for the same body; differs across thread / body', () => {
    const k1 = deriveReplyKey(42, 100, 'hello', []);
    const k2 = deriveReplyKey(42, 100, 'hello', []);
    expect(k1).toBe(k2);
    expect(k1.startsWith('arcops-reply-42-100-')).toBe(true);

    expect(deriveReplyKey(42, 100, 'hello', [])).not.toBe(deriveReplyKey(42, 100, 'world', []));
    expect(deriveReplyKey(42, 100, 'hello', [])).not.toBe(deriveReplyKey(42, 101, 'hello', []));
  });

  test('attachment content changes the key; same content is stable', () => {
    const a1 = file('a.txt', 'aaa');
    const a1b = file('b.txt', 'aaa');            // same content, different name
    const a2 = file('c.txt', 'bbb');             // different content
    expect(deriveReplyKey(42, 100, 'body', [a1])).toBe(deriveReplyKey(42, 100, 'body', [a1b]));
    expect(deriveReplyKey(42, 100, 'body', [a1])).not.toBe(deriveReplyKey(42, 100, 'body', [a2]));
  });

  test('attachment order matters (a different order is a different request)', () => {
    const a = file('a.txt', 'aaa');
    const b = file('b.txt', 'bbb');
    expect(deriveReplyKey(42, 100, 'body', [a, b])).not.toBe(deriveReplyKey(42, 100, 'body', [b, a]));
  });
});

describe('deriveSendKey', () => {
  const base = { to: ['x@y.com'], cc: [], subject: 's', body: 'b', fromLocal: 'support' };

  test('stable for the same payload; differs across any field', () => {
    expect(deriveSendKey(42, base, [])).toBe(deriveSendKey(42, base, []));
    expect(deriveSendKey(42, base, []).startsWith('arcops-send-42-')).toBe(true);

    expect(deriveSendKey(42, base, [])).not.toBe(deriveSendKey(42, { ...base, body: 'b2' }, []));
    expect(deriveSendKey(42, base, [])).not.toBe(deriveSendKey(42, { ...base, subject: 's2' }, []));
    expect(deriveSendKey(42, base, [])).not.toBe(deriveSendKey(42, { ...base, to: ['z@y.com'] }, []));
    expect(deriveSendKey(42, base, [])).not.toBe(deriveSendKey(42, { ...base, fromLocal: 'noreply' }, []));
    expect(deriveSendKey(42, base, [])).not.toBe(deriveSendKey(43, base, []));
  });

  test('cc presence changes the key (a real cc list is a different email)', () => {
    expect(deriveSendKey(42, base, [])).not.toBe(deriveSendKey(42, { ...base, cc: ['boss@y.com'] }, []));
  });

  test('attachment content changes the key; same content is stable', () => {
    const a1 = file('inv1.pdf', 'pdf-bytes-1');
    const a2 = file('inv2.pdf', 'pdf-bytes-2');
    expect(deriveSendKey(42, base, [a1])).toBe(deriveSendKey(42, base, [a1]));
    expect(deriveSendKey(42, base, [a1])).not.toBe(deriveSendKey(42, base, [a2]));
  });
});
