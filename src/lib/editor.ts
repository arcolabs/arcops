// src/lib/editor.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export function openEditor(initial: string = '', commentPreamble: string = ''): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ts-edit-'));
  const path = resolve(dir, 'reply.md');
  const seed = (commentPreamble ? commentPreamble.split('\n').map(l => `# ${l}`).join('\n') + '\n\n' : '') + initial;
  writeFileSync(path, seed);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const r = spawnSync(editor, [path], { stdio: 'inherit' });
  if (r.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`editor exited with code ${r.status}`);
  }
  const raw = readFileSync(path, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  const stripped = raw.split('\n').filter(l => !l.startsWith('# ')).join('\n').trim();
  if (!stripped) throw new Error('reply body is empty (nothing saved)');
  return stripped;
}
