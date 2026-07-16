// src/config.ts
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, copyFileSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { warn } from './output';

// Config home is ~/.arcops. Previously ~/.quay (binary name before the arcops
// rename). On first run we migrate ~/.quay -> ~/.arcops (see migrateLegacy);
// the old dir is left in place as a rollback safety net for one version.

// Layout of the config home (and the legacy ~/.quay home) for a given home
// directory. Centralized so runtime paths and migration share one source of
// truth; tests pass a temp dir to migrateLegacy instead of touching the real
// home.
type ConfigPaths = {
  root: string;
  legacyRoot: string;
  credPath: string;
  cfgPath: string;
  templatesDir: string;
  legacyCredPath: string;
  legacyCfgPath: string;
  legacyTemplatesDir: string;
};
function pathsFor(home: string): ConfigPaths {
  const root = resolve(home, '.arcops');
  const legacyRoot = resolve(home, '.quay');
  return {
    root,
    legacyRoot,
    credPath: resolve(root, 'credentials.json'),
    cfgPath: resolve(root, 'config.json'),
    templatesDir: resolve(root, 'templates'),
    legacyCredPath: resolve(legacyRoot, 'credentials.json'),
    legacyCfgPath: resolve(legacyRoot, 'config.json'),
    legacyTemplatesDir: resolve(legacyRoot, 'templates'),
  };
}

// Runtime paths (real home).
const P = pathsFor(homedir());
export const ROOT = P.root;
export const TEMPLATES_DIR = P.templatesDir;
const CRED_PATH = P.credPath;
const CFG_PATH = P.cfgPath;

// Retired default API URLs, normalized to DEFAULT_API wherever a saved config
// holds one verbatim (custom values like localhost are always preserved):
// tritonix.cn (quay era) and ops.arco.video (brief arcops interim domain,
// unbound 2026-07-16 - requests to it dead-end).
const RETIRED_DEFAULT_APIS = ['https://tritonix.cn', 'https://ops.arco.video'];
const LEGACY_DEFAULT_API = RETIRED_DEFAULT_APIS[0];
export const DEFAULT_API = 'https://arcops.cc';

export type Credentials = { token: string; api: string };
export type Config = { defaultSite?: string };

let warnedThisRun = false;

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
function ensureRoot(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
}

// Migrate ~/.quay -> ~/.arcops. Each artifact (credentials, config, templates)
// migrates independently, so a template-only or config-only legacy install
// still migrates even when credentials are absent. Idempotent per artifact:
// each copies only when the new path is absent and the legacy path exists, so
// this is safe to call on every config access and a re-run never clobbers a
// user's edited copy. The legacy dir is intentionally not deleted (rollback
// safety net for one version).
export function migrateLegacy(home: string = homedir()): void {
  const p = pathsFor(home);
  if (!existsSync(p.legacyRoot)) return; // no legacy install at all
  ensureRoot(p.root);
  let touched = false;

  // Credentials: rewrite the saved api URL when it is exactly the retired
  // quay-era default (https://tritonix.cn -> DEFAULT_API) so migrated
  // installs point at the live server. Custom api values (e.g. localhost) are
  // preserved. (Post-migration retired defaults are additionally normalized
  // in-memory by loadCredentials.)
  if (!existsSync(p.credPath) && existsSync(p.legacyCredPath)) {
    const legacy = readJson<Partial<Credentials>>(p.legacyCredPath, {});
    const api = legacy.api === LEGACY_DEFAULT_API ? DEFAULT_API : legacy.api;
    try {
      writeJson(p.credPath, { ...legacy, ...(api !== undefined ? { api } : {}) }, 0o600);
      touched = true;
    } catch (e) {
      warn(`Could not migrate credentials (${(e as Error).message}).`);
    }
  }

  // Config: plain copy (independent of credentials).
  if (!existsSync(p.cfgPath) && existsSync(p.legacyCfgPath)) {
    try {
      copyFileSync(p.legacyCfgPath, p.cfgPath);
      chmodSync(p.cfgPath, 0o600);
      touched = true;
    } catch (e) {
      warn(`Could not migrate config (${(e as Error).message}).`);
    }
  }

  // Templates: recursive copy (independent of credentials).
  if (!existsSync(p.templatesDir) && existsSync(p.legacyTemplatesDir)) {
    try {
      cpSync(p.legacyTemplatesDir, p.templatesDir, { recursive: true });
      touched = true;
    } catch (e) {
      warn(`Could not migrate templates (${(e as Error).message}).`);
    }
  }

  if (touched) {
    warn(`Migrated ${p.legacyRoot} -> ${p.root}. The old ~/.quay dir is left in place as a backup.`);
  }
}

export function loadCredentials(): Partial<Credentials> {
  migrateLegacy();
  const creds = readJson<Partial<Credentials>>(CRED_PATH, {});
  // Saved configs from earlier releases point at a retired default domain;
  // normalize in-memory so those installs keep working without a re-login.
  if (creds.api && RETIRED_DEFAULT_APIS.includes(creds.api)) {
    creds.api = DEFAULT_API;
  }
  return creds;
}
export function saveCredentials(c: Credentials) {
  ensureRoot(ROOT);
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
  ensureRoot(ROOT);
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
