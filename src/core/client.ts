// Salesforce REST client: host-gated, retrying, limit-aware. No Chrome APIs.

import { assertSalesforceApiOrigin } from './hosts';
import { SfError, sanitize, CancelToken, checkCancel } from './errors';

export interface Session {
  instanceUrl: string;
  accessToken: string;
}

export interface SessionProvider {
  getSession(): Promise<Session>;
  /** Re-reads or refreshes the session after a 401. Returns true when a new session is available. */
  refresh?(): Promise<boolean>;
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  minApiVersion?: number;
}

export interface ApiUsage {
  used: number;
  max: number;
}

export interface SaveResult {
  id?: string;
  success: boolean;
  created?: boolean;
  errors: { statusCode: string; message: string; fields?: string[] }[];
}

type RetryMode = 'safe' | 'never';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SalesforceClient {
  apiVersion = '62.0';
  usage: ApiUsage | null = null;
  requestCount = 0;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  private minApiVersion: number;

  constructor(private provider: SessionProvider, opts: ClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.minApiVersion = opts.minApiVersion ?? 52;
  }

  /** Selects the newest API version the org supports. */
  async init(): Promise<void> {
    const versions = await this.request<{ version: string }[]>('GET', '/services/data/', undefined, 'safe');
    if (!Array.isArray(versions) || versions.length === 0) throw new SfError('Could not read API versions', 'permanent');
    const latest = versions.map((v) => v.version).sort((a, b) => parseFloat(a) - parseFloat(b)).pop()!;
    if (parseFloat(latest) < this.minApiVersion) throw new SfError(`API version ${latest} is older than supported minimum`, 'permanent');
    this.apiVersion = latest;
  }

  get base(): string {
    return `/services/data/v${this.apiVersion}`;
  }

  async request<T>(method: string, path: string, body?: unknown, retry: RetryMode = method === 'GET' ? 'safe' : 'never', cancel?: CancelToken): Promise<T> {
    if (!path.startsWith('/services/')) throw new SfError(`Blocked path outside /services/: ${path}`, 'permanent');
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      checkCancel(cancel);
      const session = await this.provider.getSession();
      const origin = assertSalesforceApiOrigin(session.instanceUrl);
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(origin + path, {
          method,
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (retry === 'safe' && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new SfError(
          retry === 'safe' ? `Network error: ${sanitize(String(e))}` : 'Network error after sending a write; the outcome is unknown.',
          retry === 'safe' ? 'retryable' : 'ambiguous',
        );
      }
      this.readUsage(res);
      if (res.status === 401) {
        if (!refreshed && this.provider.refresh && (await this.provider.refresh())) {
          refreshed = true;
          continue; // a 401 means the request was never executed
        }
        throw new SfError('Session expired or invalid. Log in to the org in a browser tab, then click Reconnect.', 'auth', 401, 'INVALID_SESSION_ID');
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let data: unknown = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (res.ok) return data as T;
      const err = Array.isArray(data) ? (data[0] as { errorCode?: string; message?: string; fields?: string[] }) : (data as { errorCode?: string; message?: string });
      const code = err?.errorCode ?? '';
      const msg = sanitize(err?.message ?? `HTTP ${res.status}`);
      const dailyLimit = code === 'REQUEST_LIMIT_EXCEEDED' && /TotalRequests/i.test(msg);
      const transient = res.status === 503 || res.status === 502 || (code === 'REQUEST_LIMIT_EXCEEDED' && !dailyLimit) || code === 'SERVER_UNAVAILABLE';
      // 502/503 and concurrency limits are rejected before execution, so even writes may be retried.
      if (transient && attempt < this.maxRetries) {
        attempt++;
        await this.sleep(backoff(attempt));
        continue;
      }
      const kind = dailyLimit ? 'limit' : transient ? 'retryable' : 'permanent';
      throw new SfError(`${code ? code + ': ' : ''}${msg}`, kind, res.status, code, (err as { fields?: string[] })?.fields ?? []);
    }
  }

  private readUsage(res: Response) {
    const h = res.headers?.get?.('Sforce-Limit-Info');
    const m = h && /api-usage=(\d+)\/(\d+)/.exec(h);
    if (m) this.usage = { used: Number(m[1]), max: Number(m[2]) };
  }

  // ---- Query ----

  async *queryPages<T = Record<string, unknown>>(soql: string, cancel?: CancelToken): AsyncGenerator<T[]> {
    let res = await this.request<{ records: T[]; nextRecordsUrl?: string; done: boolean }>('GET', `${this.base}/query?q=${encodeURIComponent(soql)}`, undefined, 'safe', cancel);
    yield res.records;
    while (!res.done && res.nextRecordsUrl) {
      res = await this.request('GET', res.nextRecordsUrl, undefined, 'safe', cancel);
      yield res.records;
    }
  }

  async query<T = Record<string, unknown>>(soql: string, max = Infinity, cancel?: CancelToken): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.queryPages<T>(soql, cancel)) {
      for (const r of page) {
        if (out.length >= max) return out;
        out.push(r);
      }
    }
    return out;
  }

  /** Server-side syntax check without running the query. */
  async explain(soql: string): Promise<void> {
    await this.request('GET', `${this.base}/query?explain=${encodeURIComponent(soql)}`, undefined, 'safe');
  }

  async limits(): Promise<Record<string, { Max: number; Remaining: number }>> {
    return this.request('GET', `${this.base}/limits`);
  }

  // ---- Describe ----

  describeGlobal(): Promise<{ sobjects: { name: string; keyPrefix: string | null; label: string; queryable: boolean; createable: boolean }[] }> {
    return this.request('GET', `${this.base}/sobjects/`);
  }

  describe(object: string): Promise<unknown> {
    return this.request('GET', `${this.base}/sobjects/${encodeURIComponent(object)}/describe`);
  }

  // ---- sObject Collections ----

  /** Retrieves up to 2,000 records of one object by Id. Missing records come back as null. */
  retrieve(object: string, ids: string[], fields: string[], cancel?: CancelToken): Promise<(Record<string, unknown> | null)[]> {
    return this.request('POST', `${this.base}/composite/sobjects/${encodeURIComponent(object)}`, { ids, fields }, 'safe', cancel);
  }

  create(records: Record<string, unknown>[], cancel?: CancelToken): Promise<SaveResult[]> {
    return this.request('POST', `${this.base}/composite/sobjects`, { allOrNone: false, records }, 'never', cancel);
  }

  update(records: Record<string, unknown>[], cancel?: CancelToken): Promise<SaveResult[]> {
    // Updates by Id with explicit values are idempotent, so they are safe to retry.
    return this.request('PATCH', `${this.base}/composite/sobjects`, { allOrNone: false, records }, 'safe', cancel);
  }

  upsert(object: string, externalIdField: string, records: Record<string, unknown>[], cancel?: CancelToken): Promise<SaveResult[]> {
    return this.request('PATCH', `${this.base}/composite/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(externalIdField)}`, { allOrNone: false, records }, 'safe', cancel);
  }
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

/** Escapes a value for use inside a SOQL string literal. */
export function soqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Runs `SELECT fields FROM object WHERE field IN (values)` in chunks so URLs stay short. */
export async function queryIn<T = Record<string, unknown>>(
  client: SalesforceClient,
  fields: string[],
  object: string,
  field: string,
  values: string[],
  extraWhere = '',
  cancel?: CancelToken,
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(values)], 150)) {
    if (part.length === 0) continue;
    const soql = `SELECT ${fields.join(', ')} FROM ${object} WHERE ${field} IN (${part.map(soqlString).join(', ')})${extraWhere ? ' AND ' + extraWhere : ''}`;
    out.push(...(await client.query<T>(soql, Infinity, cancel)));
  }
  return out;
}
