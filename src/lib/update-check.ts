// src/lib/update-check.ts
//
// Announce when a newer arcops release is published, on interactive startup
// (the Codex CLI pattern: `✨ Update available!` banner on launch). arcops is
// agent-pipe-first, so the reminder is bounded by four rules:
//   1. stderr only - stdout stays data (the JSON/text output contract).
//   2. Interactive TTY only - piped / agent invocations stay completely quiet.
//   3. Cached - one registry hit per 24h, not per invocation.
//   4. Network failure is silent - never blocks a command, never changes the
//      exit code, never prints an error.
//
// Source of truth is the npm registry `latest` dist-tag. arcops publishes
// only to npm, so the registry is the release fact itself - unlike Codex,
// which must reconcile GitHub releases against npm publish lag and Homebrew
// cask updates. One source means no false "update available" while a release
// is still syncing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { warn } from '../output';
import { VERSION } from '../version';

const REGISTRY_URL = 'https://registry.npmjs.org/@arcolab%2farcops/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // one registry hit per 24h
const FETCH_TIMEOUT_MS = 3000;                 // bounded; never hang a command
const CACHE_FILENAME = 'update-check.json';

export type UpdateCheckDeps = {
  home?: string;               // cache root; defaults to homedir()
  version?: string;            // current version; defaults to VERSION
  isTty?: boolean;             // stderr tty gate; defaults to process.stderr.isTTY
  noUpdateCheck?: boolean;     // opt-out; defaults to ARCOPS_NO_UPDATE_CHECK=1
  fetchFn?: typeof fetch;      // injectable for tests
  now?: () => Date;            // injectable clock
  warnFn?: (msg: string) => void; // defaults to output.warn (stderr)
};

type UpdateCache = { lastCheckedAt: string; latest: string };

// ── version comparison ──────────────────────────────────────────────────────
// Compare major.minor.patch numerically. Prerelease suffixes are ignored so a
// staged 0.10.0-beta.1 never counts as an upgrade over 0.9.3 (Codex behaves
// the same). Unparseable input => not newer: fail silent, never a wrong banner.
export function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

// Source builds (CLI_VERSION not injected at build time -> "0.0.0-dev") must
// never announce; a dev checkout is not a released install.
export function isDevVersion(version: string): boolean {
  const p = parseVersion(version);
  return p !== null && p[0] === 0 && p[1] === 0 && p[2] === 0;
}

// Pick the upgrade command that matches how this process is installed. The npm
// package is the only release channel; bun vs npm only changes the installer.
export function updateCommand(): string {
  const exe = process.execPath ?? '';
  return exe.includes('bun')
    ? 'bun i -g @arcolab/arcops@latest'
    : 'npm i -g @arcolab/arcops@latest';
}

// ── cache ───────────────────────────────────────────────────────────────────
function cachePath(home: string): string {
  return resolve(home, '.arcops', CACHE_FILENAME);
}

function readCache(path: string): UpdateCache | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateCache>;
    if (typeof raw.latest !== 'string' || typeof raw.lastCheckedAt !== 'string') return null;
    return { latest: raw.latest, lastCheckedAt: raw.lastCheckedAt };
  } catch {
    return null; // corrupt cache = no cache; never warn about it
  }
}

function writeCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(cache) + '\n');
  } catch {
    // A read-only home / disk issue must never affect the command.
  }
}

async function fetchLatest(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' && body.version.length > 0 ? body.version : null;
  } catch {
    return null; // network / timeout / parse failure: silent
  }
}

// ── entry ───────────────────────────────────────────────────────────────────
// Called from main.ts before dispatch so the bounded registry fetch runs
// concurrently with the command; the returned promise is awaited before exit.
// Fast path (fresh cache) is fully synchronous - zero added latency.
export async function maybeWarnUpdate(deps: UpdateCheckDeps = {}): Promise<void> {
  const isTty = deps.isTty ?? !!process.stderr.isTTY;
  const noUpdateCheck = deps.noUpdateCheck ?? !!process.env.ARCOPS_NO_UPDATE_CHECK;
  const version = deps.version ?? VERSION;
  if (!isTty || noUpdateCheck || isDevVersion(version)) return;

  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => new Date());
  const fetchFn = deps.fetchFn ?? fetch;
  const emit = deps.warnFn ?? warn;
  const path = cachePath(home);

  const cached = readCache(path);
  const fresh = cached !== null
    && now().getTime() - new Date(cached.lastCheckedAt).getTime() < CHECK_INTERVAL_MS;

  let latest: string | null = null;
  if (fresh && cached) {
    latest = cached.latest;
  } else {
    const fetched = await fetchLatest(fetchFn);
    if (fetched !== null) {
      latest = fetched;
      writeCache(path, { lastCheckedAt: now().toISOString(), latest: fetched });
    }
  }

  if (latest !== null && isNewer(latest, version)) {
    emit(`New version available: ${latest} (you have ${version}) - run \`${updateCommand()}\` to update`);
  }
}
