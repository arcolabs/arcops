import pc from 'picocolors';

export type OutputFormat = 'text' | 'json';

// TTY detection — exported as 2-arg form for testability.
// In production callers pass `process.stdout.isTTY`.
export function detectOutputFormat(flag?: string, isTty: boolean = !!process.stdout.isTTY): OutputFormat {
  if (flag === 'json' || flag === 'text') return flag;
  return isTty ? 'text' : 'json';
}

// stderr-only color: respect NO_COLOR + isTTY for stderr (separate from stdout).
const colorOn = !process.env.NO_COLOR && !!process.stderr.isTTY;
function paint(fn: (s: string) => string, s: string) { return colorOn ? fn(s) : s; }

export function info(msg: string)  { process.stderr.write(paint(pc.dim, msg) + '\n'); }
export function warn(msg: string)  { process.stderr.write(paint(pc.yellow, '⚠ ' + msg) + '\n'); }
export function error(msg: string) { process.stderr.write(paint(pc.red, '✖ ' + msg) + '\n'); }
export function success(msg: string){ process.stderr.write(paint(pc.green, '✓ ' + msg) + '\n'); }

// stdout = data only.
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// Minimal table renderer for human terminals. Pass column widths or 'auto'.
export function printTable(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) {
    process.stdout.write('(no rows)\n');
    return;
  }
  const widths = columns.map(c =>
    Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length))
  );
  const fmt = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join('  ');
  process.stdout.write(fmt(columns) + '\n');
  process.stdout.write(widths.map(w => '─'.repeat(w)).join('  ') + '\n');
  for (const r of rows) {
    process.stdout.write(fmt(columns.map(c => String(r[c] ?? ''))) + '\n');
  }
}
