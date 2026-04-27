import { describe, expect, it } from 'bun:test';
import { renderTemplate, templatePath } from './templates';

describe('renderTemplate', () => {
  it('substitutes known vars', () => {
    expect(renderTemplate('Hi {{customer_email}}!', { customer_email: 'a@b.co' }))
      .toBe('Hi a@b.co!');
  });

  it('passes through unknown placeholders unchanged', () => {
    expect(renderTemplate('See {{nope}}', { customer_email: 'x' }))
      .toBe('See {{nope}}');
  });

  it('handles repeated vars', () => {
    expect(renderTemplate('{{a}}-{{a}}-{{b}}', { a: '1', b: '2' }))
      .toBe('1-1-2');
  });

  it('treats undefined as unknown (preserves placeholder)', () => {
    expect(renderTemplate('Hi {{maybe}}', { maybe: undefined }))
      .toBe('Hi {{maybe}}');
  });
});

describe('templatePath', () => {
  it('rejects path traversal', () => {
    expect(() => templatePath('../etc/passwd')).toThrow();
    expect(() => templatePath('/abs/path')).toThrow();
    expect(() => templatePath('.hidden')).toThrow();
  });

  it('strips trailing .md if present', () => {
    expect(templatePath('welcome').endsWith('/welcome.md')).toBe(true);
    expect(templatePath('welcome.md').endsWith('/welcome.md')).toBe(true);
  });
});
