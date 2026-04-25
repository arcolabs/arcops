// src/config.ts
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { warn } from './output';

const ROOT = resolve(homedir(), '.ts');
const CRED_PATH = resolve(ROOT, 'credentials.json');
const CFG_PATH = resolve(ROOT, 'config.json');

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

export function loadCredentials(): Partial<Credentials> {
  return readJson(CRED_PATH, {});
}
export function saveCredentials(c: Credentials) {
  writeJson(CRED_PATH, c, 0o600);
}
export function clearCredentials() {
  if (existsSync(CRED_PATH)) writeJson(CRED_PATH, {}, 0o600);
}

export function loadConfig(): Config {
  return readJson(CFG_PATH, {});
}
export function saveConfig(c: Config) {
  writeJson(CFG_PATH, c, 0o600);
}

// Resolve effective auth: explicit --token / --api flags override file.
// Env: TS_API overrides API; never accept TS_TOKEN from env (force explicit).
export function resolveAuth(flags: { token?: string; api?: string }): Credentials {
  const file = loadCredentials();
  const api = flags.api ?? process.env.TS_API ?? file.api ?? 'https://tritonix.cn';
  const token = flags.token ?? file.token ?? '';
  return { api, token };
}
