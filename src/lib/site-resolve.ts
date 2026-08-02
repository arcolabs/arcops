export type SiteRef = { id: number; domain: string; name?: string };

export function resolveSiteFromList(input: string, sites: SiteRef[]): SiteRef | null {
  if (!input) return null;
  if (/^\d+$/.test(input)) {
    const n = Number(input);
    return sites.find(s => s.id === n) ?? null;
  }
  return sites.find(s => s.domain === input) ?? null;
}

/**
 * Numeric site ids are already an unambiguous site-scoped reference. Keep
 * them local so a site-constrained API key never needs the workspace site
 * collection just to reach a site-scoped endpoint.
 */
export function parsePositiveSiteId(input: string): number | null {
  if (!/^\d+$/.test(input)) return null;
  const id = Number(input);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

import { apiGet } from '../api';
import { type Credentials } from '../config';
import { error } from '../output';

export async function resolveSiteOrExit(input: string, auth: Credentials): Promise<SiteRef> {
  if (!input) {
    error('site argument required (numeric id or domain)');
    process.exit(2);
  }
  const { sites } = await apiGet<{ sites: SiteRef[] }>('/api/sites', auth);
  const site = resolveSiteFromList(input, sites);
  if (!site) {
    error(`No site matched "${input}". Available: ${sites.map(s => s.domain).join(', ')}`);
    process.exit(1);
  }
  return site;
}
