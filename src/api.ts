const DEFAULT_TIMEOUT_MS = Number(process.env.TS_TIMEOUT_MS ?? 30_000);

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
    'user-agent': `ts-cli/${process.env.CLI_VERSION ?? 'dev'}`,
  };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError'
      ? `Request to ${url.host} timed out after ${timeoutMs}ms (override with TS_TIMEOUT_MS).`
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
        `Add a CF Access bypass policy for /api/* with header rule "Authorization starts with Bearer ts_". ` +
        `(See traffic-source CF Zero Trust dashboard.)`,
      );
    }
    throw new ApiError(res.status, `Unexpected redirect to ${loc || '(no location)'}`);
  }

  const text = await res.text();
  const ctype = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    if (ctype.includes('application/json') && text) {
      try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && 'error' in j) errMsg = String(j.error);
        throw new ApiError(res.status, errMsg, j);
      } catch (e) {
        if (e instanceof ApiError) throw e;
      }
    }
    throw new ApiError(res.status, errMsg);
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