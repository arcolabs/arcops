// src/lib/markdown-email.ts
//
// Render a Markdown body into email-safe HTML for the inbox send/reply paths
// (KEH-274). The server already accepts `bodyHtml` alongside `body` and ships
// it as the `text/html` part of a multipart/alternative email (`quay`
// src/lib/inbox.ts: sendReply/sendNewMessage pass `html: bodyHtml` to the
// provider). The gap was purely CLI-side - we never rendered one. This module
// is that renderer.
//
// Design constraints (see KEH-274 acceptance):
// - Zero dependencies. The CLI keeps a single runtime dep (picocolors); a
//   markdown library would double the bundle for a subset we can own. We need
//   a pragmatic subset, not CommonMark.
// - No typographic substitution. `--` stays `--`, quotes stay ASCII, `...`
//   stays three dots (acceptance #4: `--ar 9:16 --v 8.1` must survive). We
//   never run smartypants.
// - Email-safe inline styles. Gmail strips <style> and class attributes;
//   Outlook renders with Word's engine. Tables and code MUST carry inline
//   styles + border attributes or they render borderless (acceptance #1:
//   tables rendering in Gmail/Outlook is a hard gate, not "emitted a <table>").
// - CJK / emoji safe. Pure UTF-8 passthrough; no unicode case-folding or
//   punctuation munging.
// - No raw-HTML passthrough. All text is HTML-escaped; the only tags in the
//   output are the ones we generate. Author input is trusted (our team) but
//   we still close the XSS door by construction.
//
// Supported subset: headings (#{1-6}), paragraphs, hard line breaks, bold
// (**), italic (_), inline code (`), fenced code blocks (```), GFM tables with
// alignment, ordered/unordered lists (nested via indentation), blockquotes,
// horizontal rules, and links (http/https/mailto/tel only). Anything else
// falls through as a paragraph. This is the construct set our customer-facing
// emails use; richer markdown is out of scope.
//
// Idempotency note (acceptance #7): renderMarkdownEmail is a pure function of
// the body, so the existing body-based Idempotency-Key (src/lib/idempotency-key)
// is already stable across retries of the same command (same body -> same HTML
// -> same key). The server's own integrity fingerprint independently includes
// bodyHtml (reply.ts/send.ts payload), so content integrity is enforced
// server-side without coupling the CLI key to renderer version. No key
// derivation change is needed or wanted.

// ─── Styles ───────────────────────────────────────────────────────────
// All inline: Gmail drops <style>/class, Outlook uses Word's engine. Tables
// also carry border/cellpadding/cellspacing attributes for Outlook.

const WRAPPER_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  'font-size:14px;line-height:1.5;color:#222222;';

const P_STYLE = 'margin:8px 0;';
const H_STYLE = 'margin:16px 0 8px;line-height:1.3;';
const TABLE_STYLE = 'border-collapse:collapse;width:100%;max-width:600px;margin:12px 0;';
const CELL_STYLE = 'border:1px solid #cccccc;padding:8px 12px;text-align:';
const TH_EXTRA = ';background:#f4f4f4;font-weight:600;';
const CODE_BLOCK_STYLE =
  'background:#f4f4f4;border:1px solid #cccccc;border-radius:4px;padding:12px;overflow-x:auto;margin:12px 0;';
const CODE_INLINE_STYLE =
  'background:#f4f4f4;padding:1px 5px;border-radius:3px;border:1px solid #dddddd;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;';
const BLOCKQUOTE_STYLE =
  'border-left:3px solid #cccccc;margin:12px 0;padding:4px 12px;color:#555555;';
const HR_STYLE = 'border:none;border-top:1px solid #cccccc;margin:16px 0;';
const LIST_STYLE = 'margin:8px 0;padding-left:24px;';

// ─── Escaping ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Allow only http(s), mailto, tel. Blocks javascript:, data:, and schemeless
// or protocol-relative URLs (unsafe in an email HTML body).
function sanitizeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(u)) return u;
  return null;
}

// ─── Inline ───────────────────────────────────────────────────────────
// Single-pass recursive tokenizer. Handles code spans, links, bold, italic,
// and escapes everything else. Recursing into link/bold/italic inner text
// means nesting (e.g. [**bold link**](url)) works without escape-ordering
// races. `*...*` italic is intentionally NOT supported - stray asterisks are
// common in business/financial text (footnotes, multiplication) and the
// acceptance set only requires bold; italic uses unambiguous `_..._`.

export function renderInline(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];

    // Inline code span (matching backtick runs; CommonMark space-trim rule).
    if (ch === '`') {
      let open = 0;
      while (i + open < n && text[i + open] === '`') open++;
      let j = i + open;
      let closeStart = -1;
      let closeLen = 0;
      while (j < n) {
        if (text[j] === '`') {
          let run = 0;
          while (j + run < n && text[j + run] === '`') run++;
          if (run >= open) { closeStart = j; closeLen = run; break; }
          j += run;
        } else j++;
      }
      if (closeStart !== -1) {
        let content = text.slice(i + open, closeStart);
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ') {
          content = content.slice(1, -1);
        }
        out.push(`<code style="${CODE_INLINE_STYLE}">${escapeHtml(content)}</code>`);
        i = closeStart + closeLen;
        continue;
      }
      out.push(escapeHtml('`'.repeat(open)));
      i += open;
      continue;
    }

    // Link [text](url)
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close !== -1 && text[close + 1] === '(') {
        const parenClose = text.indexOf(')', close + 2);
        if (parenClose !== -1) {
          const linkText = text.slice(i + 1, close);
          let url = text.slice(close + 2, parenClose);
          const titleMatch = /\s+"[^"]*"\s*$/.exec(url);
          if (titleMatch) url = url.slice(0, titleMatch.index);
          const safe = sanitizeUrl(url);
          if (safe) {
            out.push(`<a href="${escapeAttr(safe)}">${renderInline(linkText)}</a>`);
          } else {
            // Unsafe scheme: render the link text as plain (escaped), drop the URL.
            out.push(renderInline(linkText));
          }
          i = parenClose + 1;
          continue;
        }
      }
    }

    // Bold **...**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        out.push(`<strong>${renderInline(text.slice(i + 2, end))}</strong>`);
        i = end + 2;
        continue;
      }
    }

    // Italic _..._ (word-boundary safe: not inside snake_case identifiers).
    if (ch === '_') {
      const prevChar = i > 0 ? text[i - 1] : '';
      const prevIsWord = prevChar !== '' && /\w/.test(prevChar);
      if (!prevIsWord) {
        let j = i + 1;
        while (j < n && text[j] !== '_') j++;
        if (j < n && j > i + 1) {
          const inner = text.slice(i + 1, j);
          const nextChar = text[j + 1] ?? '';
          const nextIsWord = nextChar !== '' && /\w/.test(nextChar);
          if (!nextIsWord && inner.trim()) {
            out.push(`<em>${renderInline(inner)}</em>`);
            i = j + 1;
            continue;
          }
        }
      }
    }

    // Default: accumulate raw text until the next special char, then escape.
    let j = i;
    while (j < n && text[j] !== '`' && text[j] !== '[' && text[j] !== '*' && text[j] !== '_') j++;
    if (j === i) j++; // guarantee progress past an unhandled special char
    out.push(escapeHtml(text.slice(i, j)));
    i = j;
  }
  return out.join('');
}

// ─── Block parsing ────────────────────────────────────────────────────

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function dedent(line: string, n: number): string {
  let i = 0;
  while (i < n && i < line.length && line[i] === ' ') i++;
  return line.slice(i);
}

function isListItemStart(line: string): boolean {
  return /^\s{0,3}[-*+]\s+\S/.test(line) || /^\s{0,3}\d{1,9}[.)]\s+\S/.test(line);
}

function looksLikeTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && t.length > 1 && !/^\s*$/.test(t);
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  // pipe-led / pipe-joined cells of dashes with optional colons.
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(t) && t.includes('-');
}

// Does line `i` begin a new block? Used to stop paragraph run-in.
function isBlockBoundary(lines: string[], i: number, end: number): boolean {
  const l = lines[i];
  if (/^\s{0,3}#{1,6}\s+/.test(l)) return true;
  if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) return true;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) return true;
  if (/^\s{0,3}>/.test(l)) return true;
  if (isListItemStart(l)) return true;
  if (looksLikeTableRow(l) && i + 1 < end && isTableSeparator(lines[i + 1])) return true;
  return false;
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Split a table row into trimmed cells, honoring escaped pipes (\|).
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; }
    else if (s[k] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

function parseAligns(line: string): Array<'left' | 'center' | 'right'> {
  return splitTableRow(line).map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function parseTable(lines: string[], start: number, end: number): { html: string; next: number } {
  const headerCells = splitTableRow(lines[start]);
  const aligns = parseAligns(lines[start + 1]);
  const alignFor = (idx: number): 'left' | 'center' | 'right' => aligns[idx] ?? 'left';
  const cellStyle = (idx: number, isHeader: boolean): string =>
    `${CELL_STYLE}${alignFor(idx)}${isHeader ? TH_EXTRA : ';'}`;

  let html = `<table border="1" cellpadding="0" cellspacing="0" style="${TABLE_STYLE}">\n<thead>\n<tr>`;
  headerCells.forEach((c, idx) => {
    html += `<th style="${cellStyle(idx, true)}">${renderInline(c)}</th>`;
  });
  html += `</tr>\n</thead>\n<tbody>`;
  let i = start + 2;
  while (i < end && looksLikeTableRow(lines[i]) && !isTableSeparator(lines[i]) && !/^\s*$/.test(lines[i])) {
    const row = splitTableRow(lines[i]);
    html += '\n<tr>';
    row.forEach((c, idx) => {
      html += `<td style="${cellStyle(idx, false)}">${renderInline(c)}</td>`;
    });
    html += '</tr>';
    i++;
  }
  html += `\n</tbody>\n</table>`;
  return { html, next: i };
}

// Tight lists render item text bare (no <p>); loose lists (a blank line
// between/within items) wrap each item's text in <p>, per CommonMark.
function unwrapLeadingParagraph(html: string): string {
  const m = /^<p(?:\s[^>]*)?>([\s\S]*?)<\/p>(\n|$)/.exec(html);
  if (m) return m[1] + html.slice(m[0].length);
  return html;
}

function parseList(lines: string[], start: number, end: number): { html: string; next: number } {
  const baseIndent = indentOf(lines[start]);
  const ordered = /^\s{0,3}\d{1,9}[.)]\s/.test(lines[start]);
  const tag = ordered ? 'ol' : 'ul';

  // Collect raw lines for each item: a new item starts at baseIndent; deeper
  // indented lines are continuation/nested content. Blank lines stay if the
  // list resumes after them; any blank line makes the list loose.
  const itemRaw: string[][] = [];
  let loose = false;
  let i = start;
  while (i < end) {
    const l = lines[i];
    if (/^\s*$/.test(l)) {
      let j = i;
      while (j < end && /^\s*$/.test(lines[j])) j++;
      const resumes = j < end && indentOf(lines[j]) >= baseIndent &&
        (isListItemStart(lines[j]) || indentOf(lines[j]) > baseIndent);
      if (resumes && itemRaw.length > 0) { loose = true; itemRaw[itemRaw.length - 1].push(l); i++; continue; }
      break;
    }
    const ind = indentOf(l);
    if (ind < baseIndent) break;
    if (ind === baseIndent && isListItemStart(l)) { itemRaw.push([l]); i++; }
    else if (itemRaw.length > 0) { itemRaw[itemRaw.length - 1].push(l); i++; }
    else break;
  }

  const items: string[] = [];
  for (const raw of itemRaw) {
    const m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(raw[0])!;
    const prefixLen = m[1].length + m[2].length + m[3].length;
    const innerLines = [m[4], ...raw.slice(1).map((l) => dedent(l, prefixLen))];
    let inner = parseBlocks(innerLines, 0, innerLines.length).join('\n');
    if (!loose) inner = unwrapLeadingParagraph(inner);
    items.push(`<li>${inner}</li>`);
  }

  const startAttr = ordered ? ` start="${/^(\d+)/.exec(lines[start].trim())?.[1] ?? 1}"` : '';
  return {
    html: `<${tag}${startAttr} style="${LIST_STYLE}">\n${items.join('\n')}\n</${tag}>`,
    next: i,
  };
}

function renderParagraph(lines: string[]): string {
  // Hard break: a line ending with 2+ spaces -> <br/>. Soft wrap otherwise.
  const rendered = lines.map((l) => {
    const hard = / {2,}$/.test(l);
    return { html: renderInline(l.replace(/\s+$/, '')), hard };
  });
  let s = '';
  for (let k = 0; k < rendered.length; k++) {
    s += rendered[k].html;
    if (k < rendered.length - 1) s += rendered[k].hard ? '<br/>\n' : ' ';
  }
  return `<p style="${P_STYLE}">${s}</p>`;
}

function renderCodeBlock(code: string): string {
  return `<pre style="${CODE_BLOCK_STYLE}"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
}

function parseBlocks(lines: string[], start: number, end: number): string[] {
  const blocks: string[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    // Fenced code block
    const fence = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const indent = fence[1];
      const marker = fence[2][0];
      const minLen = fence[2].length;
      const closeRe = new RegExp('^' + reEscape(indent) + reEscape(marker) + '{' + minLen + ',}\\s*$');
      const codeLines: string[] = [];
      i++;
      while (i < end && !closeRe.test(lines[i])) {
        codeLines.push(dedent(lines[i], indent.length));
        i++;
      }
      i++; // closing fence (if present)
      blocks.push(renderCodeBlock(codeLines.join('\n')));
      continue;
    }

    // ATX heading
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(`<h${level} style="${H_STYLE}">${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(`<hr style="${HR_STYLE}"/>`);
      i++;
      continue;
    }

    // GFM table
    if (looksLikeTableRow(line) && i + 1 < end && isTableSeparator(lines[i + 1])) {
      const result = parseTable(lines, i, end);
      blocks.push(result.html);
      i = result.next;
      continue;
    }

    // Blockquote
    if (/^\s{0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < end && /^\s{0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s{0,3}> ?/, ''));
        i++;
      }
      const inner = parseBlocks(quoteLines, 0, quoteLines.length).join('\n');
      blocks.push(`<blockquote style="${BLOCKQUOTE_STYLE}">\n${inner}\n</blockquote>`);
      continue;
    }

    // List
    if (isListItemStart(line)) {
      const result = parseList(lines, i, end);
      blocks.push(result.html);
      i = result.next;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < end) {
      const l = lines[i];
      if (/^\s*$/.test(l)) break;
      if (isBlockBoundary(lines, i, end)) break;
      paraLines.push(l);
      i++;
    }
    blocks.push(renderParagraph(paraLines));
  }
  return blocks;
}

// ─── Public API ───────────────────────────────────────────────────────

export function renderMarkdownEmail(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = parseBlocks(lines, 0, lines.length);
  return `<div style="${WRAPPER_STYLE}">\n${blocks.join('\n')}\n</div>`;
}

// Detect whether a body uses any Markdown construct. When it does not, the
// caller sends NO bodyHtml and the email goes out text-only - byte-identical
// to pre-KEH-274 behavior (acceptance #5: zero regression for plain text).
// When it does, the caller renders and sends bodyHtml alongside the text.
export function hasMarkdown(md: string): boolean {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s{0,3}#{1,6}\s+/.test(l)) return true;          // heading
    if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) return true;       // fenced code
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) return true; // hr
    if (/^\s{0,3}>/.test(l)) return true;                   // blockquote
    if (isListItemStart(l)) return true;                    // list item
    if (looksLikeTableRow(l) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) return true; // table
    if (l.includes('**')) return true;                       // bold
    if (/`[^`]/.test(l)) return true;                        // inline code (opening backtick)
    if (/\[[^\]]+\]\([^)]+\)/.test(l)) return true;          // link
    if (/(^|[^\w])_[^\s_][^]*?_(?![\w])/ .test(l)) return true; // _italic_
  }
  return false;
}
