export type SiteRef = { id: number; domain: string; name?: string };

export function resolveSiteFromList(input: string, sites: SiteRef[]): SiteRef | null {
  if (!input) return null;
  if (/^\d+$/.test(input)) {
    const n = Number(input);
    return sites.find(s => s.id === n) ?? null;
  }
  return sites.find(s => s.domain === input) ?? null;
}
