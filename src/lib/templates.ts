// Template system for inbox replies. Convention over configuration:
// markdown files in ~/.quay/templates/<name>.md. No frontmatter, no DSL —
// just plain markdown with `{{var}}` placeholders. Two vars are auto-injected
// from thread context: {{thread_subject}} and {{customer_email}}. Anything
// else is left as-is so a stray `{{` in the body doesn't error.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const TEMPLATE_EXT = '.md';

export function templatesDir(): string {
  const dir = resolve(homedir(), '.quay', 'templates');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function templatePath(name: string): string {
  // Reject path traversal — names are bare slugs, not subpaths.
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error(`invalid template name: ${name}`);
  }
  const stripped = name.endsWith(TEMPLATE_EXT) ? name.slice(0, -TEMPLATE_EXT.length) : name;
  return resolve(templatesDir(), stripped + TEMPLATE_EXT);
}

export type TemplateInfo = { name: string; size: number; modified: string };

export function listTemplates(): TemplateInfo[] {
  const dir = templatesDir();
  const entries = readdirSync(dir);
  const rows: TemplateInfo[] = [];
  for (const f of entries) {
    if (!f.endsWith(TEMPLATE_EXT)) continue;
    const full = resolve(dir, f);
    const s = statSync(full);
    if (!s.isFile()) continue;
    rows.push({
      name: f.slice(0, -TEMPLATE_EXT.length),
      size: s.size,
      modified: s.mtime.toISOString(),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export function readTemplate(name: string): string {
  const path = templatePath(name);
  if (!existsSync(path)) {
    throw new Error(`template not found: ${name} (${path})`);
  }
  return readFileSync(path, 'utf8');
}

// Replace `{{var}}` with vars[var]. Unknown placeholders pass through
// unchanged — that's deliberate so a customer message containing `{{`
// doesn't get mangled and a typo in a var name surfaces visibly in the
// preview rather than silently producing an empty string.
export function renderTemplate(body: string, vars: Record<string, string | undefined>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined ? match : v;
  });
}
