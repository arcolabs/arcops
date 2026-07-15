// src/config.ts
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, copyFileSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { warn } from './output';

// Config home is ~/.arcops. Previously ~/.quay (binary name before the arcops
// rename). On first run we migrate ~/.quay -> ~/.arcops (see migrateLegacy);
// the old dir is left in place as a rollback safety net for one version.
const ROOT = resolve(homedir(), '.arcops');
const LEGACY_ROOT = resolve(homedir(), '.quay');
const CRED_PATH = resolve(ROOT, 'credentials.json');
const CFG_PATH = resolve(ROOT, 'config.json');
const LEGACY_CRED_PATH = resolve(LEGACY_ROOT, 'credentials.json');
const LEGACY_CFG_PATH = resolve(LEGACY_ROOT, 'config.json');
const TEMPLATES_DIR = resolve(ROOT, 'templates');
const LEGACY_TEMPLATES_DIR = resolve(LEGACY_ROOT, 'templates');

export { ROOT, TEMPLATES_DIR };

const LEGACY_DEFAULT_API = 'https://tritonix.cn';
export const DEFAULT_API = 'https://ops.arco.video';

export type Credentials = { token: string; api: string };
export type Config = { defaultSite?: string };

let warnedThisRun = false;
let migrated = false;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    if (!warnedThisRun) {
      warnedThisRun = true;
      warn(`Config at ${path} unreadable (${(e as Error).message}); falling back.`);
    }
    return fallback;
  }
}

function writeJson(path: string, data: unknown, mode?: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  if (mode !== undefined) chmodSync(path, mode);
}

// Ensure the config home exists and is mode 0700 (credentials live here).
// mkdir's mode is masked by umask and is a no-op if the dir already exists,
// so chmod explicitly to guarantee tight perms regardless of who created it.
function ensureRoot() {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  chmodSync(ROOT, 0o700);
}

// One-time migration from ~/.quay -> ~/.arcops. Copies credentials + config,
// rewriting the saved api URL when it is exactly the retired default
// (https://tritonix.cn -> https://ops.arco.video) so migrated installs point
// at the live server. Custom api values (e.g. localhost) are preserved.
// Idempotent: no-op once ~/.arcops/credentials.json exists. The legacy dir is
// intentionally not deleted (rollback safety net for one version).
function migrateLegacy() {
  if (migrated) return;
  migrated = true;
  if (existsSync(CRED_PATH)) return; // already on the new path
  if (!existsSync(LEGACY_CRED_PATH)) return; // nothing to migrate

  const legacy = readJson<Partial<Credentials>>(LEGACY_CRED_PATH, {});
  const api = legacy.api === LEGACY_DEFAULT_API ? DEFAULT_API : legacy.api;
  try {
    ensureRoot();
    writeJson(CRED_PATH, { ...legacy, ...(api !== undefined ? { api } : {}) }, 0o600);
    if (existsSync(LEGACY_CFG_PATH) && !existsSync(CFG_PATH)) {
      copyFileSync(LEGACY_CFG_PATH, CFG_PATH);
      chmodSync(CFG_PATH, 0o600);
    }
    if (existsSync(LEGACY_TEMPLATES_DIR) && !existsSync(TEMPLATES_DIR)) {
      cpSync(LEGACY_TEMPLATES_DIR, TEMPLATES_DIR, { recursive: true });
    }
    warn(`Migrated credentials from ${LEGACY_ROOT} -> ${ROOT}. The old ~/.quay dir is left in place as a backup.`);
  } catch (e) {
    warn(`Could not migrate ${LEGACY_ROOT} -> ${ROOT} (${(e as Error).message}); reading legacy dir directly.`);
  }
}

export function loadCredentials(): Partial<Credentials> {
  migrateLegacy();
  return readJson(CRED_PATH, {});
}
export function saveCredentials(c: Credentials) {
  ensureRoot();
  writeJson(CRED_PATH, c, 0o600);
}
export function clearCredentials() {
  if (existsSync(CRED_PATH)) writeJson(CRED_PATH, {}, 0o600);
}

export function loadConfig(): Config {
  migrateLegacy();
  return readJson(CFG_PATH, {});
}
export function saveConfig(c: Config) {
  ensureRoot();
  writeJson(CFG_PATH, c, 0o600);
}

// Resolve effective auth: explicit --token / --api flags override file.
// Env: ARCOPS_API overrides API (QUAY_API read as a one-version compat shim,
// never accepted for tokens). Never accept a token from env - force explicit
// file or --token to avoid ambient secrets in shells.
export function resolveAuth(flags: { token?: string; api?: string }): Credentials {
  const file = loadCredentials();
  const api = flags.api ?? resolveApiEnv() ?? file.api ?? DEFAULT_API;
  const token = flags.token ?? file.token ?? '';
  return { api, token };
}

// ARCOPS_API is the canonical override; QUAY_API is read as a one-version
// backward-compat shim for installs that still export the old name.
let apiEnvWarned = false;
export function resolveApiEnv(): string | undefined {
  if (process.env.ARCOPS_API) return process.env.ARCOPS_API;
  if (process.env.QUAY_API) {
    if (!apiEnvWarned) {
      apiEnvWarned = true;
      warn('QUAY_API is deprecated; use ARCOPS_API. Reading QUAY_API for now.');
    }
    return process.env.QUAY_API;
  }
  return undefined;
}
