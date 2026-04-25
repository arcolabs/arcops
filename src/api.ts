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
    });
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError'
      ? `Request to ${url.host} timed out after ${timeoutMs}ms (override with TS_TIMEOUT_MS).`
      : `Request to ${url.host} failed: ${(e as Error).message}`;
    throw new ApiError(0, msg);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const errMsg = (parsed && typeof parsed === 'object' && 'error' in parsed)
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, errMsg, parsed);
  }
  return parsed as T;
}

export const apiGet    = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'GET' });
export const apiPost   = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'POST' });
export const apiDelete = <T = unknown>(path: string, o: Omit<Opts, 'method'>) => apiCall<T>(path, { ...o, method: 'DELETE' });