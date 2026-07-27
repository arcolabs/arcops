// src/lib/markdown-email.test.ts
//
// Unit tests for the Markdown -> email-HTML renderer (KEH-274). Pins the
// acceptance-relevant behavior: headings/tables/bold/code/lists render,
// `--` and backtick args survive unmangled, CJK/emoji pass through, raw HTML
// is escaped, unsafe URLs are dropped, and plain-text detection gates the
// text-only fallback (zero regression for non-Markdown bodies).

import { describe, expect, test } from 'bun:test';
import { hasMarkdown, renderInline, renderMarkdownEmail } from './markdown-email';

const WRAP_OPEN = '<div style=';

describe('renderMarkdownEmail: headings', () => {
  test('h1..h6', () => {
    const out = renderMarkdownEmail('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6');
    for (let lvl = 1; lvl <= 6; lvl++) {
      expect(out).toContain(`<h${lvl} style="margin:16px 0 8px;line-height:1.3;">H${lvl}</h${lvl}>`);
    }
  });
});

describe('renderMarkdownEmail: tables (hard acceptance - must render in Gmail/Outlook)', () => {
  test('emits border attrs + inline cell styles so Gmail/Outlook show borders', () => {
    const md = '| Plan | Price |\n|---|---|\n| Pro | $99 |\n| Team | $199 |';
    const out = renderMarkdownEmail(md);
    // border attribute (Outlook) + inline border style (Gmail strips <style>/class).
    expect(out).toContain('<table border="1" cellpadding="0" cellspacing="0"');
    expect(out).toContain('border-collapse:collapse');
    expect(out).toContain('<thead>');
    expect(out).toContain('<th style="border:1px solid #cccccc;padding:8px 12px;text-align:left;background:#f4f4f4;font-weight:600;">Plan</th>');
    expect(out).toContain('<td style="border:1px solid #cccccc;padding:8px 12px;text-align:left;">Pro</td>');
    expect(out).toContain('<td style="border:1px solid #cccccc;padding:8px 12px;text-align:left;">$99</td>');
    expect(out).toContain('</tbody>');
  });

  test('column alignment from the separator row', () => {
    const md = '| L | C | R |\n|:---|:---:|---:|\n| 1 | 2 | 3 |';
    const out = renderMarkdownEmail(md);
    expect(out).toMatch(/<th style="[^"]*text-align:left;[^"]*">L<\/th>/);
    expect(out).toMatch(/<th style="[^"]*text-align:center;[^"]*">C<\/th>/);
    expect(out).toMatch(/<th style="[^"]*text-align:right;[^"]*">R<\/th>/);
    expect(out).toMatch(/<td style="[^"]*text-align:right;[^"]*">3<\/td>/);
  });

  test('inline formatting works inside cells', () => {
    const out = renderMarkdownEmail('| Col |\n|---|\n| **bold** and `code` |');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code style=');
  });

  test('escaped pipes inside a cell stay in the cell', () => {
    const out = renderMarkdownEmail('| a\\|b |\n|---|\n| c |');
    expect(out).toContain('>a|b<');
  });
});

describe('renderMarkdownEmail: emphasis + code', () => {
  test('bold via **', () => {
    expect(renderMarkdownEmail('**hi**')).toContain('<strong>hi</strong>');
  });
  test('italic via _ (word-boundary safe)', () => {
    expect(renderInline('a _word_ b')).toContain('<em>word</em>');
    // snake_case is NOT italicized.
    expect(renderInline('snake_case_var')).toBe('snake_case_var');
  });
  test('inline code escapes content and is not formatted', () => {
    const out = renderInline('see `**not bold**` ok');
    expect(out).toContain('<code style=');
    expect(out).not.toContain('<strong>not bold</strong>'); // not bold inside code
    expect(out).toContain('**not bold**'); // literal, preserved inside <code>
  });
  test('fenced code block escapes HTML and skips inline formatting', () => {
    const md = '```\n<strong>raw</strong>\n**not bold**\n```';
    const out = renderMarkdownEmail(md);
    expect(out).toContain('<pre style=');
    expect(out).toContain('&lt;strong&gt;raw&lt;/strong&gt;');
    expect(out).not.toContain('<strong>raw</strong>');
    expect(out).not.toContain('<strong>not bold</strong>');
  });
  test('code fence with ~~~', () => {
    const out = renderMarkdownEmail('~~~\nhello\n~~~');
    expect(out).toContain('<pre style=');
    expect(out).toContain('hello');
  });
});

describe('renderMarkdownEmail: lists', () => {
  test('unordered list (tight -> no <p>)', () => {
    const out = renderMarkdownEmail('- a\n- b\n- c');
    expect(out).toContain('<ul style="margin:8px 0;padding-left:24px;">');
    expect(out).toContain('<li>a</li>');
    expect(out).toContain('<li>b</li>');
    expect(out).toContain('<li>c</li>');
  });
  test('ordered list preserves start number', () => {
    const out = renderMarkdownEmail('1. first\n2. second');
    expect(out).toContain('<ol start="1" style="margin:8px 0;padding-left:24px;">');
    expect(out).toContain('<li>first</li>');
    expect(out).toContain('<li>second</li>');
  });
  test('nested list', () => {
    const out = renderMarkdownEmail('- top\n  - nested a\n  - nested b\n- top2');
    expect(out).toContain('<ul style="margin:8px 0;padding-left:24px;">');
    expect(out).toContain('<li>top');
    expect(out).toContain('<li>nested a</li>');
    expect(out).toContain('<li>nested b</li>');
    expect(out).toContain('<li>top2</li>');
  });
  test('plus and asterisk bullets', () => {
    expect(renderMarkdownEmail('+ one\n* two').match(/<li>/g)?.length).toBe(2);
  });
});

describe('renderMarkdownEmail: other blocks', () => {
  test('blockquote', () => {
    const out = renderMarkdownEmail('> quoted text');
    expect(out).toContain('<blockquote style=');
    expect(out).toContain('quoted text');
  });
  test('horizontal rule', () => {
    expect(renderMarkdownEmail('a\n\n---\n\nb')).toContain('<hr style="border:none;border-top:1px solid #cccccc;margin:16px 0;"/>');
  });
  test('paragraph wraps plain prose', () => {
    const out = renderMarkdownEmail('Hello world.');
    expect(out).toContain('<p style="margin:8px 0;">Hello world.</p>');
  });
  test('hard line break (2+ trailing spaces) -> <br/>', () => {
    const out = renderMarkdownEmail('line one  \nline two');
    expect(out).toContain('line one<br/>\nline two');
  });
  test('soft wrap (single newline) -> space', () => {
    const out = renderMarkdownEmail('line one\nline two');
    expect(out).toContain('line one line two');
    expect(out).not.toContain('line one<br');
  });
});

describe('renderMarkdownEmail: acceptance #4 - no smartypants / no escaping of args', () => {
  test('-- and flags survive unmangled', () => {
    const out = renderMarkdownEmail('Run with --ar 9:16 --v 8.1 for best results.');
    expect(out).toContain('--ar 9:16 --v 8.1');
    expect(out).not.toMatch(/[–—]/); // no en/em dash
  });
  test('double dash stays double dash, not an en-dash', () => {
    expect(renderInline('a -- b')).toBe('a -- b');
  });
  test('quotes stay ASCII', () => {
    expect(renderInline("she said \"hi\" and 'bye'")).toBe("she said \"hi\" and 'bye'");
  });
  test('backtick content with flags is preserved literally in code span', () => {
    expect(renderInline('use `--ar 9:16 --v 8.1`')).toContain('--ar 9:16 --v 8.1');
  });
});

describe('renderMarkdownEmail: CJK + emoji', () => {
  test('CJK passes through and bold works', () => {
    const out = renderMarkdownEmail('你好 **世界**');
    expect(out).toContain('你好');
    expect(out).toContain('<strong>世界</strong>');
  });
  test('emoji passes through', () => {
    expect(renderMarkdownEmail('Hi 👋 welcome')).toContain('👋');
  });
  test('CJK heading', () => {
    expect(renderMarkdownEmail('## 报价方案')).toContain('<h2 style="margin:16px 0 8px;line-height:1.3;">报价方案</h2>');
  });
});

describe('renderMarkdownEmail: XSS / raw HTML', () => {
  test('raw <script> is escaped, not passed through', () => {
    const out = renderMarkdownEmail('hi <script>alert(1)</script> bye');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });
  test('raw <img onerror> is escaped', () => {
    const out = renderMarkdownEmail('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
  test('ampersand is escaped', () => {
    expect(renderInline('a & b')).toBe('a &amp; b');
  });
});

describe('renderMarkdownEmail: links', () => {
  test('safe link renders as <a>', () => {
    const out = renderInline('[Arcops](https://arcops.cc)');
    expect(out).toBe('<a href="https://arcops.cc">Arcops</a>');
  });
  test('mailto link allowed', () => {
    expect(renderInline('[mail](mailto:x@y.com)')).toBe('<a href="mailto:x@y.com">mail</a>');
  });
  test('javascript: link dropped -> text only', () => {
    const out = renderInline('[x](javascript:alert(1))');
    expect(out).not.toContain('<a');
    expect(out).toContain('x');
  });
  test('data: link dropped', () => {
    expect(renderInline('[x](data:text/html,<script>)')).not.toContain('href="data:');
  });
  test('bold inside link text', () => {
    expect(renderInline('[**bold link**](https://x.com)')).toBe('<a href="https://x.com"><strong>bold link</strong></a>');
  });
});

describe('renderMarkdownEmail: wrapper + empty', () => {
  test('output is wrapped in a styled div', () => {
    expect(renderMarkdownEmail('hi')).toContain(WRAP_OPEN);
  });
  test('empty input -> empty wrapper (server trims to no html part)', () => {
    expect(renderMarkdownEmail('')).toContain(WRAP_OPEN);
    expect(renderMarkdownEmail('').trim()).toMatch(/^<div style="[^"]*">\s*<\/div>$/);
  });
});

describe('hasMarkdown (gates the text-only fallback, acceptance #5)', () => {
  test('plain prose -> false', () => {
    expect(hasMarkdown('Hello world. This is a plain email.')).toBe(false);
    expect(hasMarkdown('Line one\nLine two\n\nAnother paragraph.')).toBe(false);
  });
  test('flags-only prose -> false (--ar etc. is not markdown)', () => {
    expect(hasMarkdown('Run with --ar 9:16 --v 8.1 for best results.')).toBe(false);
  });
  test('snake_case and dollars -> false', () => {
    expect(hasMarkdown('file_size_max is $99.00')).toBe(false);
  });
  test('heading -> true', () => {
    expect(hasMarkdown('## Pricing')).toBe(true);
  });
  test('table -> true', () => {
    expect(hasMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(true);
  });
  test('bold -> true', () => {
    expect(hasMarkdown('**important**')).toBe(true);
  });
  test('inline code -> true', () => {
    expect(hasMarkdown('see `code`')).toBe(true);
  });
  test('list -> true', () => {
    expect(hasMarkdown('- item')).toBe(true);
    expect(hasMarkdown('1. first')).toBe(true);
  });
  test('fenced code -> true', () => {
    expect(hasMarkdown('```\ncode\n```')).toBe(true);
  });
  test('blockquote -> true', () => {
    expect(hasMarkdown('> quoted')).toBe(true);
  });
  test('link -> true', () => {
    expect(hasMarkdown('[Arcops](https://arcops.cc)')).toBe(true);
  });
  test('italic via _ -> true', () => {
    expect(hasMarkdown('a _word_ b')).toBe(true);
  });
  test('empty -> false', () => {
    expect(hasMarkdown('')).toBe(false);
    expect(hasMarkdown('   \n  ')).toBe(false);
  });
});

describe('KEH-273 scenario: pricing email with two tables', () => {
  test('two tables + headings + bold render in one body', () => {
    const md = [
      '## Pricing',
      '',
      'Here are the two plans:',
      '',
      '### Monthly',
      '',
      '| Plan | Price | Seats |',
      '|:---|---:|---:|',
      '| **Pro** | $99/mo | 3 |',
      '| Team | $199/mo | 10 |',
      '',
      '### Annual (prepaid)',
      '',
      '| Plan | Price | Save |',
      '|:---|---:|---:|',
      '| **Pro** | $990/yr | 2mo |',
      '',
      'Reply with `--accept-annual` to confirm.',
      '',
      '— Kai',
    ].join('\n');
    const out = renderMarkdownEmail(md);
    expect(out).toContain('<h2 style="margin:16px 0 8px;line-height:1.3;">Pricing</h2>');
    expect(out).toContain('<h3 style="margin:16px 0 8px;line-height:1.3;">Monthly</h3>');
    expect(out).toContain('<strong>Pro</strong>');
    // two tables
    expect((out.match(/<table border="1"/g) || []).length).toBe(2);
    expect(out).toContain('--accept-annual'); // flag preserved in inline code
    // em-dash in source stays as literal em-dash (we don't touch unicode)
    expect(out).toContain('— Kai');
  });
});
