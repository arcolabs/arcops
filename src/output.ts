import pc from 'picocolors';

export type OutputFormat = 'text' | 'json';

// TTY detection — exported as 2-arg form for testability.
// In production callers pass `process.stdout.isTTY`.
export function detectOutputFormat(flag?: string, isTty: boolean = !!process.stdout.isTTY): OutputFormat {
  if (flag === 'json' || flag === 'text') return flag;
  return isTty ? 'text' : 'json';
}

// stderr-only color: respect NO_COLOR + isTTY for stderr (separate from stdout).
export const colorOn = !process.env.NO_COLOR && !!process.stderr.isTTY;
export function paint(fn: (s: string) => string, s: string) { return colorOn ? fn(s) : s; }

export function info(msg: string)  { process.stderr.write(paint(pc.dim, msg) + '\n'); }
export function warn(msg: string)  { process.stderr.write(paint(pc.yellow, '⚠ ' + msg) + '\n'); }
export function error(msg: string) { process.stderr.write(paint(pc.red, '✖ ' + msg) + '\n'); }
export function success(msg: string){ process.stderr.write(paint(pc.green, '✓ ' + msg) + '\n'); }

// stdout = data only.
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// Minimal table renderer for human terminals. Uppercase headers, separator line.
export function printTable(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) {
    process.stdout.write('(no rows)\n');
    return;
  }
  const widths = columns.map(c =>
    Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length))
  );
  const fmt = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join('  ');
  process.stdout.write(fmt(columns.map(c => c.toUpperCase())) + '\n');
  process.stdout.write(widths.map(w => '─'.repeat(w)).join('  ') + '\n');
  for (const r of rows) {
    process.stdout.write(fmt(columns.map(c => String(r[c] ?? ''))) + '\n');
  }
}

// ── Spinner ──────────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  start(): void;
  update(text: string): void;
  stop(): void;
}

export function createSpinner(label: string): Spinner {
  let frame = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentLabel = label;

  return {
    start() {
      if (!colorOn || interval) return;
      interval = setInterval(() => {
        process.stderr.write(`\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${currentLabel}`);
        frame++;
      }, 80);
    },
    update(text: string) {
      currentLabel = text;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (colorOn) process.stderr.write('\r\x1b[K');
    },
  };
}

// Wrap async work with a spinner. Auto-stops on completion.
export async function withSpinner<T>(
  label: string,
  fn: (spinner: Spinner) => Promise<T>,
): Promise<T> {
  const spinner = createSpinner(label);
  spinner.start();
  try {
    return await fn(spinner);
  } finally {
    spinner.stop();
  }
}

// ── Elapsed time ─────────────────────────────────────────────────────────────
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// `✓ title  •  3.2s  •  extra` — completion line on stderr (stdout reserved for data).
export function runSuccess(opts: { title: string; elapsedMs?: number; extra?: string }): void {
  const parts: string[] = [opts.title];
  if (opts.elapsedMs !== undefined) parts.push(formatElapsed(opts.elapsedMs));
  if (opts.extra) parts.push(opts.extra);
  if (!colorOn) {
    process.stderr.write(`✓ ${parts.join('  •  ')}\n`);
    return;
  }
  const s = ` ${pc.dim('•')} `;
  const [head, ...rest] = parts;
  const tail = rest.length > 0 ? s + rest.map(p => pc.dim(p)).join(s) : '';
  process.stderr.write(`${pc.green('✓')} ${head}${tail}\n`);
}
