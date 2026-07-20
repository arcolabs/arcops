// Build the first-party tracking embed tag for a site. The public collector
// script (<api>/t.js) reads the site id from its own `data-site` attribute and
// POSTs pageviews/events to <api>/api/collect (contract verified against
// https://arcops.cc/t.js - KEH-201). The tag is derived from the resolved API
// base so `--api` / ARCOPS_API overrides produce a matching snippet.
export function embedSnippet(api: string, siteId: number | string): string {
  const base = api.replace(/\/+$/, '');
  return `<script src="${base}/t.js" data-site="${siteId}" defer></script>`;
}
