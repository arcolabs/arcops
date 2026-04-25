import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, printJson, printTable } from '../output';

export async function overview(args: { token?: string; api?: string; output?: string; days?: string }) {
  const auth = resolveAuth(args);
  const query: Record<string, string | number | undefined> = {};
  if (args.days) query.days = Number(args.days);
  const data = await apiGet<Record<string, unknown>>('/api/overview', { api: auth.api, token: auth.token, query });
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  // Text: print key fields as a table
  const rows = [data];
  const cols = Object.keys(data);
  printTable(rows as Record<string, unknown>[], cols);
}
