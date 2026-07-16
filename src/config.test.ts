import { describe, expect, it } from 'bun:test';
import { migrateLegacy } from './config';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test gets an isolated HOME so migration never touches the real ~/.arcops.
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'arcops-cfg-'));
}

describe('migrateLegacy', () => {
  it('migrates a template-only legacy install without credentials', () => {
    const home = freshHome();
    mkdirSync(join(home, '.quay', 'templates'), { recursive: true });
    writeFileSync(join(home, '.quay', 'templates', 'reply.md'), 'Hi {{customer_email}}');
    expect(existsSync(join(home, '.quay', 'credentials.json'))).toBe(false);

    migrateLegacy(home);

    expect(existsSync(join(home, '.arcops', 'templates', 'reply.md'))).toBe(true);
    expect(readFileSync(join(home, '.arcops', 'templates', 'reply.md'), 'utf8'))
      .toBe('Hi {{customer_email}}');
    // No credentials were present, so none are fabricated.
    expect(existsSync(join(home, '.arcops', 'credentials.json'))).toBe(false);
  });

  it('migrates a config-only legacy install without credentials', () => {
    const home = freshHome();
    mkdirSync(join(home, '.quay'), { recursive: true });
    writeFileSync(join(home, '.quay', 'config.json'), JSON.stringify({ defaultSite: 'sunor.cc' }));

    migrateLegacy(home);

    expect(existsSync(join(home, '.arcops', 'credentials.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.arcops', 'config.json'), 'utf8')).defaultSite)
      .toBe('sunor.cc');
  });

  it('rewrites the retired default api when migrating credentials', () => {
    const home = freshHome();
    mkdirSync(join(home, '.quay'), { recursive: true });
    writeFileSync(
      join(home, '.quay', 'credentials.json'),
      JSON.stringify({ token: 'ts_x', api: 'https://tritonix.cn' }),
    );

    migrateLegacy(home);

    const migrated = JSON.parse(readFileSync(join(home, '.arcops', 'credentials.json'), 'utf8'));
    expect(migrated.token).toBe('ts_x');
    expect(migrated.api).toBe('https://arcops.cc');
  });

  it('preserves a custom api when migrating credentials', () => {
    const home = freshHome();
    mkdirSync(join(home, '.quay'), { recursive: true });
    writeFileSync(
      join(home, '.quay', 'credentials.json'),
      JSON.stringify({ token: 'ts_y', api: 'http://localhost:8787' }),
    );

    migrateLegacy(home);

    const migrated = JSON.parse(readFileSync(join(home, '.arcops', 'credentials.json'), 'utf8'));
    expect(migrated.api).toBe('http://localhost:8787');
  });

  it('is idempotent: a re-run never clobbers an edited copy', () => {
    const home = freshHome();
    mkdirSync(join(home, '.quay', 'templates'), { recursive: true });
    writeFileSync(join(home, '.quay', 'templates', 'reply.md'), 'original');

    migrateLegacy(home);
    writeFileSync(join(home, '.arcops', 'templates', 'reply.md'), 'edited');
    migrateLegacy(home);

    expect(readFileSync(join(home, '.arcops', 'templates', 'reply.md'), 'utf8')).toBe('edited');
  });

  it('is a no-op when no legacy dir exists', () => {
    const home = freshHome();
    migrateLegacy(home);
    expect(existsSync(join(home, '.arcops'))).toBe(false);
  });
});
