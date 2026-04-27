// Parse `--until` for inbox snooze. Returns an ISO 8601 string the server
// will then re-validate (`invalid_snooze_until` / `snooze_until_in_past`).
//
// Accepted forms:
//   - Relative duration: 30m, 2h, 3d, 1w
//   - "tomorrow"  → tomorrow 09:00 local
//   - "tonight"   → today 20:00 local (or tomorrow 20:00 if past)
//   - ISO 8601: 2026-05-01T09:00:00Z (anything Date can parse)
//
// Day names ("monday"/"friday") deliberately not supported — too easy to mean
// "this monday" vs "next monday" and locale-prone. Use ISO for those.

const RELATIVE_RE = /^(\d+)\s*(s|m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

export function parseSnoozeUntil(input: string, now: Date = new Date()): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) throw new Error('--until is required');

  const rel = trimmed.match(RELATIVE_RE);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = UNIT_MS[unit];
    if (!Number.isFinite(n) || n <= 0 || !ms) {
      throw new Error(`invalid relative duration: ${input}`);
    }
    return new Date(now.getTime() + n * ms).toISOString();
  }

  if (trimmed === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  if (trimmed === 'tonight') {
    const d = new Date(now);
    d.setHours(20, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  // Last resort: let Date parse it. Empty/garbage falls through to NaN here.
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`could not parse --until value: ${input} (try '3d', 'tomorrow', or ISO timestamp)`);
  }
  return parsed.toISOString();
}
