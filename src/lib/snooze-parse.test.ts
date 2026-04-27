import { describe, expect, it } from 'bun:test';
import { parseSnoozeUntil } from './snooze-parse';

describe('parseSnoozeUntil', () => {
  const now = new Date('2026-04-27T12:00:00Z');

  it('handles relative durations', () => {
    expect(parseSnoozeUntil('30m', now)).toBe('2026-04-27T12:30:00.000Z');
    expect(parseSnoozeUntil('2h', now)).toBe('2026-04-27T14:00:00.000Z');
    expect(parseSnoozeUntil('3d', now)).toBe('2026-04-30T12:00:00.000Z');
    expect(parseSnoozeUntil('1w', now)).toBe('2026-05-04T12:00:00.000Z');
  });

  it('case-insensitive units', () => {
    expect(parseSnoozeUntil('2H', now)).toBe('2026-04-27T14:00:00.000Z');
  });

  it('parses tomorrow as 09:00 next day', () => {
    const out = new Date(parseSnoozeUntil('tomorrow', now));
    // Result is local 09:00 on the day after `now`, surfaced as ISO UTC.
    // Verify it's strictly later than now, < 36h out.
    expect(out.getTime()).toBeGreaterThan(now.getTime());
    expect(out.getTime() - now.getTime()).toBeLessThan(36 * 60 * 60 * 1000);
  });

  it('parses tonight, rolling forward if past 20:00', () => {
    const earlyAfternoon = new Date('2026-04-27T14:00:00Z');
    const lateEvening = new Date('2026-04-27T23:00:00Z');
    const out1 = new Date(parseSnoozeUntil('tonight', earlyAfternoon));
    const out2 = new Date(parseSnoozeUntil('tonight', lateEvening));
    expect(out1.getTime()).toBeGreaterThan(earlyAfternoon.getTime());
    expect(out2.getTime()).toBeGreaterThan(lateEvening.getTime());
  });

  it('parses ISO timestamps', () => {
    expect(parseSnoozeUntil('2026-05-01T09:00:00Z', now)).toBe('2026-05-01T09:00:00.000Z');
  });

  it('rejects garbage', () => {
    expect(() => parseSnoozeUntil('three days', now)).toThrow();
    expect(() => parseSnoozeUntil('', now)).toThrow();
    expect(() => parseSnoozeUntil('0d', now)).toThrow();
  });
});
