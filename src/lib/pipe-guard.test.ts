import { describe, expect, test } from 'bun:test';
import { isPipeError } from './pipe-guard';

// KEH-278 B: the guard suppresses exactly EPIPE (a closed downstream pipe) and
// nothing else. A real I/O fault (ENOSPC, EIO, ...) must stay visible, so the
// predicate is narrow on `code === 'EPIPE'`.

describe('isPipeError (KEH-278 B)', () => {
  test('true for an EPIPE error (closed downstream pipe)', () => {
    const e = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isPipeError(e)).toBe(true);
  });

  test('false for a non-EPIPE write fault (stays visible)', () => {
    const e = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
    expect(isPipeError(e)).toBe(false);
  });

  test('false for a non-Error / no-code value', () => {
    expect(isPipeError(null)).toBe(false);
    expect(isPipeError('EPIPE')).toBe(false);
    expect(isPipeError(new Error('no code'))).toBe(false);
  });
});
