const DEFAULT_TIMEOUT_MS = Number(process.env.QUAY_TIMEOUT_MS ?? 30_000);

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
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
  const headers: Record<string, string> = {
    'accept': 'application/json',
    'user-agent': `quay/${process.env.CLI_VERSION ?? 'dev'}`,
  };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  // Body shaping: FormData → let fetch set its own multipart boundary;
  // anything else with a value → JSON. Undefined body = no body, no header.
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
    const msg = (e as Error).name === 'TimeoutError'
      ? `Request to ${url.host} timed out after ${timeoutMs}ms (override with QUAY_TIMEOUT_MS).`
      : `Request to ${url.host} failed: ${(e as Error).message}`;
    throw new ApiError(0, msg);
  }

  // Detect Cloudflare Access intercept (3xx redirect to *.cloudflareaccess.com).
  // CF Access wraps the origin and redirects unauthorized browsers to its OAuth page;
  // the API token never reaches Next.js. Fix: add a CF Access bypass policy on the
  // application for `/api/*` when `Authorization` header matches `^Bearer ts_`.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    if (loc.includes('cloudflareaccess.com')) {
      throw new ApiError(res.status,
        `Cloudflare Access blocked the request to ${url.pathname}. ` +
        `In CF Zero Trust dashboard, add an Application for ${url.host}/api/* with a Bypass + Everyone policy. ` +
        `withAuthOrToken validates Bearer tokens server-side; CF Access cookie (browser) is verified via JWKS in cf-access.ts.`,
      );
    }
    throw new ApiError(res.status, `Unexpected redirect to ${loc || '(no location)'}`);
  }

  const text = await res.text();
  const ctype = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    let body: unknown;
    let detail = '';
    if (ctype.includes('application/json') && text) {
      try {
        body = JSON.parse(text);
        const j = body as Record<string, unknown>;
        if (j.error && typeof j.error === 'object' && typeof (j.error as { code?: unknown }).code === 'string') {
          // Structured error contract from the server:
          //   { error: { code, message, detail? } }
          // Surface code + message, then fold in the most actionable
          // diagnostic from `detail` (upstream reject reason, or the raw
          // error) so the agent sees the real cause inline instead of an
          // opaque status. e.g. for a misconfigured outbound:
          //   HTTP 502: cf_send_failed: Cloudflare rejected the outbound email. (upstream: email.sending.error.email.invalid)
          const ee = j.error as { code: string; message?: string; detail?: Record<string, unknown> };
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
      // Non-JSON error body (often Next.js HTML 500 page). Strip whitespace/tags-ish noise so the snippet is readable.
      detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    if (detail) errMsg += `: ${detail}`;
    const reqId = res.headers.get('x-request-id') ?? res.headers.get('cf-ray');
    if (reqId) errMsg += ` (request-id: ${reqId})`;
    throw new ApiError(res.status, errMsg, body);
  }

  if (!text) return undefined as T;
  if (!ctype.includes('application/json')) {
    throw new ApiError(res.status,
      `Expected JSON from ${url.pathname} but got ${ctype || 'no content-type'} ` +
      `(${text.length} bytes). Check --api url.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ApiError(res.status, `Invalid JSON from ${url.pathname}: ${(e as Error).message}`);
  }
}

export const apiGet    = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'GET' });
export const apiPost   = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'POST' });
export const apiDelete = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'DELETE' });

// 204 No Content / 200 with empty body still come back as undefined from
// apiCall — but typed as `unknown`, callers had to assert. This shim fixes
// that for callers that just need success/failure, not the response body.
export async function apiVoid(path: string, o: Opts): Promise<void> {
  await apiCall(path, o);
}