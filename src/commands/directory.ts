import { resolveAuth } from '../config';
import { apiGet } from '../api';
import { detectOutputFormat, info, printJson, printTable } from '../output';
import { resolveSiteOrExit } from '../lib/site-resolve';

type Directory = {
  id: number;
  slug: string;
  name: string;
  homepageUrl: string;
  submissionUrl: string | null;
  category: string | null;
  source: string;
  isActive: boolean;
};

type Submission = {
  id: number;
  status: 'planned' | 'submitted' | 'live' | 'rejected';
  submitted_at: string | null;
  listing_url: string | null;
  utm_campaign_id: number | null;
  notes: string | null;
};

type SubmissionRow = {
  directory: {
    id: number; slug: string; name: string;
    homepage_url: string; submission_url: string | null;
    category: string | null; tinypost_slug: string | null;
    source: string; notes: string | null;
  };
  submission: Submission | null;
  tracked_url: string | null;
};

// Sort planned > submitted > live > rejected so the actionable rows are on top.
const STATUS_ORDER: Record<string, number> = { planned: 0, submitted: 1, live: 2, rejected: 3 };

export async function ls(args: {
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const { directories } = await apiGet<{ directories: Directory[] }>(
    '/api/directories',
    { api: auth.api, token: auth.token },
  );
  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(directories);
  printTable(
    directories.map(d => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      category: d.category ?? '',
      source: d.source,
      submission_url: d.submissionUrl ?? d.homepageUrl,
    })) as Record<string, unknown>[],
    ['id', 'slug', 'name', 'category', 'source', 'submission_url'],
  );
}

export async function submissions(args: {
  site?: string;
  token?: string; api?: string; output?: string;
}) {
  const auth = resolveAuth(args);
  const site = await resolveSiteOrExit(args.site ?? '', auth);
  const { submissions } = await apiGet<{ submissions: SubmissionRow[] }>(
    `/api/sites/${site.id}/submissions`,
    { api: auth.api, token: auth.token },
  );

  const fmt = detectOutputFormat(args.output);
  if (fmt === 'json') return printJson(submissions);

  if (submissions.length === 0) {
    info(`No directories registered. Run \`arcops directory ls\` to confirm the catalog is seeded.`);
    return;
  }

  const rows = submissions
    .map(r => ({
      status: r.submission?.status ?? 'planned',
      slug: r.directory.slug,
      name: r.directory.name,
      submission_url: r.directory.submission_url ?? r.directory.homepage_url,
      tracked_url: r.tracked_url ?? '',
      listing_url: r.submission?.listing_url ?? '',
    }))
    .sort((a, b) =>
      (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99) ||
      a.slug.localeCompare(b.slug),
    );

  printTable(
    rows as unknown as Record<string, unknown>[],
    ['status', 'slug', 'name', 'submission_url', 'tracked_url', 'listing_url'],
  );
}
