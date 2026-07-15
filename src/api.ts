// ARCOPS_TIMEOUT_MS is canonical; QUAY_TIMEOUT_MS read as one-version compat.
const DEFAULT_TIMEOUT_MS = Number(process.env.ARCOPS_TIMEOUT_MS ?? process.env.QUAY_TIMEOUT_MS ?? 30_000);

// Error kinds the CLI distinguishes for rendering + agent consumption.
//  - 'api':       server returned a structured error envelope (S1 contract)
//  - 'intercept': non-JSON / redirected response - endpoint drift, version
//                 mismatch, or a proxy (Cloudflare) intercepted the request
//  - 'timeout':   fetch exceeded ARCOPS_TIMEOUT_MS
//  - 'network':   fetch threw (DNS, connection refused, TLS, ...)
//  - 'parse':     response was JSON-shaped but failed JSON.parse
export type ApiErrorKind = 'api' | 'intercept' | 'timeout' | 'network' | 'parse';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code?: string;      // server error.code from the S1 envelope
  readonly detail?: unknown;   // server error.detail from the S1 envelope
  readonly body?: unknown;

  constructor(
    public status: number,
    message: string,
    opts: { kind?: ApiErrorKind; code?: string; detail?: unknown; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = opts.kind ?? 'api';
    this.code = opts.code;
    this.detail = opts.detail;
    this.body = opts.body;
  }
}

type Opts = {
  api: string;
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  timeoutMs?: number;
  query?: Record<string, string | number | undefined>;
};

export async function apiCall<T = unknown>(path: string, opts: Opts): Promise<T> {
  const url = new URL(path, opts.api);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cliVersion = process.env.CLI_VERSION ?? 'dev';
  const headers: Record<string, string> = {
    'accept': 'application/json',
    'user-agent': `arcops/${cliVersion}`,
    // CLI->server version handshake (item 5). Sent on every request so the
    // server can log/correlate; reading a server-sent version header requires
    // a server-side change that is out of bounds for this slice.
    'x-arcops-cli-version': cliVersion,
  };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  // Body shaping: FormData -> let fetch set its own multipart boundary;
  // anything else with a value -> JSON. Undefined body = no body, no header.
  const isMultipart = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  let body: string | FormData | undefined;
  if (opts.body !== undefined) {
    if (isMultipart) {
      body = opts.body as FormData;
    } else {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError') {
      throw new ApiError(0, `Request to ${url.host} timed out after ${timeoutMs}ms (override with ARCOPS_TIMEOUT_MS).`, { kind: 'timeout' });
    }
    throw new ApiError(0, `Request to ${url.host} failed: ${err.message}`, { kind: 'network' });
  }

  // Detect Cloudflare Access intercept (3xx redirect to *.cloudflareaccess.com).
  // CF Access wraps the origin and redirects unauthorized browsers to its OAuth
  // page; the API token never reaches Next.js. Fix: add a CF Access bypass
  // policy on the application for `/api/*` when `Authorization` matches ^Bearer ts_.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    if (loc.includes('cloudflareaccess.com')) {
      throw new ApiError(res.status,
        `Cloudflare Access intercepted the request to ${url.pathname} (token never reached the API). ` +
        `In CF Zero Trust dashboard, add an Application for ${url.host}/api/* with a Bypass + Everyone policy. ` +
        `withAuthOrToken validates Bearer tokens server-side; the CF Access cookie (browser) is verified via JWKS in cf-access.ts.`,
        { kind: 'intercept' },
      );
    }
    throw new ApiError(res.status,
      `Request to ${url.pathname} was redirected to ${loc || '(no location)'} - endpoint drift or a proxy intercepted the request. Check --api url.`,
      { kind: 'intercept' },
    );
  }

  const text = await res.text();
  const ctype = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    let body: unknown;
    let detail = '';
    let code: string | undefined;
    let detailObj: unknown;
    if (ctype.includes('application/json') && text) {
      try {
        body = JSON.parse(text);
        const j = body as Record<string, unknown>;
        if (j.error && typeof j.error === 'object' && typeof (j.error as { code?: unknown }).code === 'string') {
          // Structured error contract from the server (S1 / KEH-88):
          //   { error: { code, message, detail? } }
          // Preserve code + detail verbatim for agent consumption, and build a
          // human-readable message that folds in the most actionable
          // diagnostic so a TTY user sees the real cause inline. e.g.:
          //   HTTP 502: cf_send_failed: Cloudflare rejected the outbound email. (upstream: email.sending.error.email.invalid)
          const ee = j.error as { code: string; message?: string; detail?: Record<string, unknown> };
          code = ee.code;
          detailObj = ee.detail;
          const parts: string[] = [ee.code];
          if (ee.message) parts.push(ee.message);
          detail = parts.join(': ');
          if (ee.detail) {
            const upstream = ee.detail.upstream;
            const raw = ee.detail.error;
            if (typeof upstream === 'string') detail += ` (upstream: ${upstream})`;
            else if (typeof raw === 'string') detail += ` (${raw.slice(0, 160)})`;
          }
        } else if (typeof j.error === 'string') {
          detail = j.error;
        } else if (typeof j.message === 'string') {
          detail = j.message;
        } else {
          detail = text.slice(0, 200);
        }
      } catch {
        detail = text.slice(0, 200);
      }
    } else if (text) {
      // Non-JSON error body (often a Next.js HTML 500 page or a CF intercept).
      // Strip tags/whitespace so the snippet is readable.
      detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    if (detail) errMsg += `: ${detail}`;
    const reqId = res.headers.get('x-request-id') ?? res.headers.get('cf-ray');
    if (reqId) errMsg += ` (request-id: ${reqId})`;
    throw new ApiError(res.status, errMsg, { kind: 'api', code, detail: detailObj, body });
  }

  if (!text) return undefined as T;
  if (!ctype.includes('application/json')) {
    // Success-path non-JSON: the endpoint drifted, the server is a different
    // version, or a proxy returned HTML. Frame as version-mismatch/intercept
    // so agents never see a bare `undefined` from destructuring HTML.
    throw new ApiError(res.status,
      `Version mismatch or request intercepted: expected JSON from ${url.pathname} but got ${ctype || 'no content-type'} (${text.length} bytes). ` +
      `The endpoint may have drifted, the server may be a different version, or a proxy returned a non-JSON page. Check --api url.`,
      { kind: 'intercept' },
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ApiError(res.status,
      `Invalid JSON from ${url.pathname}: ${(e as Error).message}`,
      { kind: 'parse' },
    );
  }
}

export const apiGet    = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'GET' });
export const apiPost   = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'POST' });
export const apiDelete = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'DELETE' });

// 204 No Content / 200 with empty body still come back as undefined from
// apiCall - but typed as `unknown`, callers had to assert. This shim fixes
// that for callers that just need success/failure, not the response body.
export async function apiVoid(path: string, o: Opts): Promise<void> {
  await apiCall(path, o);
}
