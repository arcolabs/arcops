import { describe, expect, test } from 'bun:test';
import { resolveSiteFromList } from './site-resolve';

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
