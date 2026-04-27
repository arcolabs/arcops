// `quay template ls / show / edit` — manages reusable reply bodies under
// ~/.quay/templates/<name>.md. Plain markdown, no DSL. Variables get
// substituted at apply time (inbox reply --template / inbox draft create
// --template); see lib/templates.ts.

import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  detectOutputFormat, printJson, printTable, error, success, info,
} from '../output';
import {
  listTemplates, readTemplate, templatePath, templatesDir,
} from '../lib/templates';

export function ls(args: { output?: string }) {
  const rows = listTemplates();
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(rows);
  if (rows.length === 0) {
    info(`No templates yet. Create one with: quay template edit <name>`);
    info(`Templates live in ${templatesDir()}`);
    return;
  }
  printTable(rows as unknown as Record<string, unknown>[], ['name', 'size', 'modified']);
}

export function show(args: { name?: string; output?: string }) {
  if (!args.name) { error('template name required'); process.exit(2); }
  const body = readTemplate(args.name);
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson({ name: args.name, body });
  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');
}

export function edit(args: { name?: string }) {
  if (!args.name) { error('template name required'); process.exit(2); }
  const path = templatePath(args.name);
  if (!existsSync(path)) {
    // Seed new template with two of the auto-injected vars as a hint so the
    // operator immediately sees what's available without reading docs.
    const seed = `Hi,

(write reply here — supports {{thread_subject}} and {{customer_email}})

Best,
`;
    writeFileSync(path, seed);
    info(`Created ${path}`);
  }
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const r = spawnSync(editor, [path], { stdio: 'inherit' });
  if (r.status !== 0) {
    error(`editor exited with code ${r.status}`);
    process.exit(1);
  }
  success(`Saved ${path}`);
}
