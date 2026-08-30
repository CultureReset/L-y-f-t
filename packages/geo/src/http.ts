/**
 * The HTTP seam for provider adapters.
 *
 * Adapters take an injectable client so their tests never touch the network and
 * so a deployment can add its own retries, caching, or metrics without every
 * adapter growing its own copy.
 */

export type HttpClient = <T>(url: string, init?: RequestInit) => Promise<T>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

export interface HttpJsonOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly headers?: Record<string, string>;
}

/** Default client: JSON, a timeout, and bounded retries on 5xx and 429. */
export const createHttpClient = (options: HttpJsonOptions = {}): HttpClient => {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const retries = options.retries ?? 2;

  return async <T>(url: string, init: RequestInit = {}): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: { accept: 'application/json', ...options.headers, ...init.headers },
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          const error = new HttpError(response.status, url, body);
          // Only transient failures are worth another attempt.
          if (response.status >= 500 || response.status === 429) {
            lastError = error;
            await backoff(attempt);
            continue;
          }
          throw error;
        }
        return (await response.json()) as T;
      } catch (e) {
        lastError = e;
        if (e instanceof HttpError) throw e;
        if (attempt === retries) break;
        await backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
};

const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));

export const httpJson: HttpClient = createHttpClient();
