import { describe, expect, test } from 'bun:test';
import { detectOutputFormat } from './output';

describe('detectOutputFormat', () => {
  test('explicit "json" wins regardless of TTY', () => {
    expect(detectOutputFormat('json', true)).toBe('json');
    expect(detectOutputFormat('json', false)).toBe('json');
  });
  test('explicit "text" wins regardless of TTY', () => {
    expect(detectOutputFormat('text', true)).toBe('text');
    expect(detectOutputFormat('text', false)).toBe('text');
  });
  test('TTY without flag → text', () => {
    expect(detectOutputFormat(undefined, true)).toBe('text');
  });
  test('non-TTY without flag → json', () => {
    expect(detectOutputFormat(undefined, false)).toBe('json');
  });
  test('invalid flag → falls back to TTY detection', () => {
    expect(detectOutputFormat('xml', true)).toBe('text');
    expect(detectOutputFormat('xml', false)).toBe('json');
  });
});
