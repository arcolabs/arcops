import { resolveAuth } from '../config';
import { apiPost } from '../api';
import { detectOutputFormat, info, printJson, success } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

type BackfillResult = {
  scanned: number;
  matched_email: number;
  attributed: number;
  skipped_no_session: number;
};

export async function backfill(args: {
  site?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const data = await apiPost<BackfillResult>(
    `/api/sites/${site.id}/attribution-backfill`,
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(data);
  info(`Attribution backfill on ${site.domain}:`);
  info(`  scanned:            ${data.scanned}`);
  info(`  matched email:      ${data.matched_email}`);
  info(`  attributed:         ${data.attributed}`);
  info(`  skipped no session: ${data.skipped_no_session}`);
  success('Done.');
}
