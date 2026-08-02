import { describe, expect, test } from 'bun:test';
import { parsePositiveSiteId, resolveSiteFromList } from './site-resolve';

const SITES = [
  { id: 1, domain: 'tritonix.cn', name: 'Tritonix' },
  { id: 2, domain: 'foo.io', name: 'Foo' },
];

describe('resolveSiteFromList', () => {
  test('numeric input matches id', () => {
    expect(resolveSiteFromList('2', SITES)?.domain).toBe('foo.io');
  });
  test('domain input matches', () => {
    expect(resolveSiteFromList('tritonix.cn', SITES)?.id).toBe(1);
  });
  test('unknown input returns null', () => {
    expect(resolveSiteFromList('nope', SITES)).toBeNull();
  });
  test('empty input returns null', () => {
    expect(resolveSiteFromList('', SITES)).toBeNull();
  });
});

describe('parsePositiveSiteId', () => {
  test('accepts a safe positive numeric id without a workspace lookup', () => {
    expect(parsePositiveSiteId('7')).toBe(7);
    expect(parsePositiveSiteId('0007')).toBe(7);
  });

  test('rejects zero, negative, decimal, and non-numeric site refs', () => {
    expect(parsePositiveSiteId('0')).toBeNull();
    expect(parsePositiveSiteId('-1')).toBeNull();
    expect(parsePositiveSiteId('1.5')).toBeNull();
    expect(parsePositiveSiteId('acme.com')).toBeNull();
  });
});
