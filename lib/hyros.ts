// Server-side Hyros REST API client.
// Handles auth, rate limiting (30 req/s, 1000 req/min), 429 backoff, and pagination.

const BASE_URL = "https://api.hyros.com/v1";
// The Hyros API is served from api.hyros.com; the OpenAPI paths are like /api/v1.0/<resource>.
// Full URL example: https://api.hyros.com/v1/api/v1.0/sales

/** Simple rolling-window rate limiter shared across a single export run. */
class RateLimiter {
  private secWindow: number[] = [];
  private minWindow: number[] = [];
  constructor(private perSec = 25, private perMin = 900) {}

  async acquire(): Promise<void> {
    // Loop until both windows have room.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.secWindow = this.secWindow.filter((t) => now - t < 1000);
      this.minWindow = this.minWindow.filter((t) => now - t < 60000);
      if (this.secWindow.length < this.perSec && this.minWindow.length < this.perMin) {
        this.secWindow.push(now);
        this.minWindow.push(now);
        return;
      }
      const waitSec = this.secWindow.length >= this.perSec ? 1000 - (now - this.secWindow[0]) : 0;
      const waitMin = this.minWindow.length >= this.perMin ? 60000 - (now - this.minWindow[0]) : 0;
      await sleep(Math.max(25, waitSec, waitMin));
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface HyrosResponse<T> {
  result?: T;
  nextPageId?: string;
  request_id?: string;
  message?: string[];
}

export class HyrosClient {
  private limiter = new RateLimiter();

  constructor(private apiKey: string) {}

  /** Low-level request with retry on 429 / transient errors. */
  async request<T = any>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<HyrosResponse<T>> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const maxRetries = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.limiter.acquire();
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: { "API-Key": this.apiKey, Accept: "application/json" },
        });
      } catch (e) {
        lastErr = e;
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") || "1");
        await sleep(Math.max(500, retryAfter * 1000));
        continue;
      }
      if (res.status === 401) {
        throw new Error("Unauthorized — check that the API Key is correct (Hyros → Settings → API).");
      }

      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { message: [text] };
      }

      if (!res.ok) {
        const msg = Array.isArray(json?.message) ? json.message.join("; ") : json?.message || res.statusText;
        // Retry 5xx, surface 4xx.
        if (res.status >= 500 && attempt < maxRetries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new Error(`Hyros API ${res.status} on ${path}: ${msg}`);
      }
      return json as HyrosResponse<T>;
    }
    throw new Error(`Request to ${path} failed after retries: ${String(lastErr)}`);
  }

  /**
   * Paginate a list endpoint that returns { result: T[], nextPageId }.
   * Calls onPage after each page so the caller can stream progress.
   */
  async paginate<T = any>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    onPage: (items: T[], fetchedSoFar: number) => void | Promise<void>,
    pageSize = 250
  ): Promise<number> {
    let pageId: string | undefined;
    let fetched = 0;
    let guard = 0;
    do {
      const resp = await this.request<T[]>(path, { ...params, pageSize, pageId });
      const items = (resp.result as T[]) || [];
      fetched += items.length;
      await onPage(items, fetched);
      pageId = resp.nextPageId;
      // Safety: stop if a page is empty but a nextPageId persists (avoid infinite loops).
      if (items.length === 0) break;
      if (++guard > 100000) break;
    } while (pageId);
    return fetched;
  }
}

/** Run async tasks with bounded concurrency, preserving input order. */
export async function pool<I, O>(
  items: I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<O>,
  onProgress?: (done: number) => void
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      done++;
      onProgress?.(done);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, run);
  await Promise.all(runners);
  return results;
}
