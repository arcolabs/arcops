import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDevVersion, isNewer, maybeWarnUpdate, parseVersion, updateCommand,
} from './update-check';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'arcops-upd-'));
}

// Captures warn() calls and counts registry fetches.
function harness(home: string, version: string, overrides: Record<string, unknown> = {}) {
  const warned: string[] = [];
  const calls = { n: 0 };
  const okFetch = (latest: string): typeof fetch =>
    (async () => {
      calls.n++;
      return new Response(JSON.stringify({ version: latest }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  return { warned, calls, okFetch };
}

describe('parseVersion / isNewer', () => {
  it('parses major.minor.patch', () => {
    expect(parseVersion('0.9.3')).toEqual([0, 9, 3]);
    expect(parseVersion(' 1.2.3 \n')).toEqual([1, 2, 3]);
  });

  it('ignores prerelease suffixes', () => {
    expect(parseVersion('0.11.0-beta.1')).toEqual([0, 11, 0]);
  });

  it('rejects unparseable input', () => {
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('compares plain semver', () => {
    expect(isNewer('0.9.3', '0.9.2')).toBe(true);
    expect(isNewer('0.9.2', '0.9.3')).toBe(false);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.9.9', '1.0.0')).toBe(false);
    expect(isNewer('0.9.3', '0.9.3')).toBe(false);
  });

  it('never treats a prerelease as newer than the stable release', () => {
    expect(isNewer('0.11.0-beta.1', '0.11.0')).toBe(false);
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('returns false when either side is unparseable', () => {
    expect(isNewer('dev', '0.9.2')).toBe(false);
    expect(isNewer('0.9.3', 'dev')).toBe(false);
  });
});

describe('isDevVersion', () => {
  it('flags only 0.0.0 builds', () => {
    expect(isDevVersion('0.0.0-dev')).toBe(true);
    expect(isDevVersion('0.0.0')).toBe(true);
    expect(isDevVersion('0.9.3')).toBe(false);
  });
});

describe('updateCommand', () => {
  it('returns the bun installer when running under bun', () => {
    // bun test runs under bun, so execPath points at the bun binary.
    expect(updateCommand()).toBe('bun i -g @arcolab/arcops@latest');
  });
});

describe('maybeWarnUpdate', () => {
  it('warns from a fresh cache without hitting the registry', async () => {
    const home = freshHome();
    mkdirSync(join(home, '.arcops'), { recursive: true });
    writeFileSync(join(home, '.arcops', 'update-check.json'),
      JSON.stringify({ lastCheckedAt: new Date().toISOString(), latest: '0.9.3' }));
    const { warned, calls, okFetch } = harness(home, '0.9.2');

    await maybeWarnUpdate({ home, version: '0.9.2', isTty: true, fetchFn: okFetch('9.9.9'), warnFn: (m) => warned.push(m) });

    expect(calls.n).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('0.9.3');
    expect(warned[0]).toContain('0.9.2');
  });

  it('fetches when the cache is stale, warns and persists the new latest', async () => {
    const home = freshHome();
    mkdirSync(join(home, '.arcops'), { recursive: true });
    writeFileSync(join(home, '.arcops', 'update-check.json'),
      JSON.stringify({ lastCheckedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), latest: '0.9.1' }));
    const { warned, calls, okFetch } = harness(home, '0.9.2');

    await maybeWarnUpdate({ home, version: '0.9.2', isTty: true, fetchFn: okFetch('0.9.3'), warnFn: (m) => warned.push(m) });

    expect(calls.n).toBe(1);
    expect(warned).toHaveLength(1);
    const cached = JSON.parse(readFileSync(join(home, '.arcops', 'update-check.json'), 'utf8'));
    expect(cached.latest).toBe('0.9.3');
    expect(typeof cached.lastCheckedAt).toBe('string');
  });

  it('does not warn when already on the latest', async () => {
    const home = freshHome();
    const { warned, okFetch } = harness(home, '0.9.3');
    await maybeWarnUpdate({ home, version: '0.9.3', isTty: true, fetchFn: okFetch('0.9.3'), warnFn: (m) => warned.push(m) });
    expect(warned).toHaveLength(0);
  });

  it('is silent on network failure and does not poison the cache', async () => {
    const home = freshHome();
    const { warned } = harness(home, '0.9.2');
    const failFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await maybeWarnUpdate({ home, version: '0.9.2', isTty: true, fetchFn: failFetch, warnFn: (m) => warned.push(m) });
    expect(warned).toHaveLength(0);
    expect(existsSync(join(home, '.arcops', 'update-check.json'))).toBe(false);
  });

  it('is silent on a non-200 registry response', async () => {
    const home = freshHome();
    const { warned } = harness(home, '0.9.2');
    const calls = { n: 0 };
    const failFetch = (async () => {
      calls.n++;
      return new Response('oops', { status: 503 });
    }) as unknown as typeof fetch;
    await maybeWarnUpdate({ home, version: '0.9.2', isTty: true, fetchFn: failFetch, warnFn: (m) => warned.push(m) });
    expect(calls.n).toBe(1);
    expect(warned).toHaveLength(0);
  });

  it('never warns or fetches when not a TTY', async () => {
    const home = freshHome();
    const { warned, calls, okFetch } = harness(home, '0.9.2');
    await maybeWarnUpdate({ home, version: '0.9.2', isTty: false, fetchFn: okFetch('0.9.3'), warnFn: (m) => warned.push(m) });
    expect(calls.n).toBe(0);
    expect(warned).toHaveLength(0);
  });

  it('never warns or fetches when disabled via ARCOPS_NO_UPDATE_CHECK', async () => {
    const home = freshHome();
    const { warned, calls, okFetch } = harness(home, '0.9.2');
    await maybeWarnUpdate({ home, version: '0.9.2', isTty: true, noUpdateCheck: true, fetchFn: okFetch('0.9.3'), warnFn: (m) => warned.push(m) });
    expect(calls.n).toBe(0);
    expect(warned).toHaveLength(0);
  });

  it('never warns or fetches on a dev build', async () => {
    const home = freshHome();
    const { warned, calls, okFetch } = harness(home, '0.0.0-dev');
    await maybeWarnUpdate({ home, version: '0.0.0-dev', isTty: true, fetchFn: okFetch('0.9.3'), warnFn: (m) => warned.push(m) });
    expect(calls.n).toBe(0);
    expect(warned).toHaveLength(0);
  });

  it('reads the ARCOPS_NO_UPDATE_CHECK env flag', async () => {
    const home = freshHome();
    const { warned, calls, okFetch } = harness(home, '0.9.2');
    process.env.ARCOPS_NO_UPDATE_CHECK = '1';
    try {
      await maybeWarnUpdate({ home, version: '0.9.2', isTty: true, fetchFn: okFetch('0.9.3'), warnFn: (m) => warned.push(m) });
    } finally {
      delete process.env.ARCOPS_NO_UPDATE_CHECK;
    }
    expect(calls.n).toBe(0);
    expect(warned).toHaveLength(0);
  });
});
