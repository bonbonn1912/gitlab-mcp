export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface GitLabResponse<T> {
  data: T;
  headers: Headers;
}

export interface GitLabDownload extends GitLabResponse<Uint8Array> {
  truncated: boolean;
}

export class GitLabApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

export class GitLabClient {
  private readonly origin: string;
  private readonly basePath: string;

  constructor(instanceUrl: string, private readonly token: string) {
    let parsed: URL;
    try {
      parsed = new URL(instanceUrl);
    } catch {
      throw new Error("GITLAB_URL must be an absolute URL, for example https://gitlab.company.example.");
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("GITLAB_URL must use HTTP or HTTPS.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("GITLAB_URL must not contain credentials, a query string, or a fragment.");
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
      throw new Error("This MCP server only supports GitLab Self-Managed/Data Center instances; gitlab.com is not allowed.");
    }

    this.origin = parsed.origin;
    this.basePath = parsed.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
    if (!token.trim()) {
      throw new Error("GITLAB_TOKEN is required. Store it in the environment, not in Gemini settings or source files.");
    }
  }

  async request<T>(
    method: string,
    path: string,
    query: QueryParams = {},
    body?: unknown,
  ): Promise<GitLabResponse<T>> {
    const url = new URL(`${this.basePath}/api/v4/${path.replace(/^\/+/, "")}`, this.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "PRIVATE-TOKEN": this.token,
          "User-Agent": "gitlab-datacenter-mcp-server/1.0.0",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("GitLab request timed out after 30 seconds. Check the instance URL and network connection.");
      }
      throw new Error(`Could not reach the configured GitLab instance: ${safeErrorMessage(error)}`);
    }

    const responseText = await response.text();
    if (!response.ok) {
      throw new GitLabApiError(
        response.status,
        describeApiError(response.status, responseText),
        response.headers.get("x-request-id") ?? undefined,
      );
    }

    if (response.status === 204 || responseText.length === 0) {
      return { data: undefined as T, headers: response.headers };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        return { data: JSON.parse(responseText) as T, headers: response.headers };
      } catch {
        throw new Error("GitLab returned malformed JSON. Check the instance version and API response.");
      }
    }
    return { data: responseText as T, headers: response.headers };
  }

  async requestBytes(
    path: string,
    query: QueryParams = {},
    maxBytes = 90_000,
  ): Promise<GitLabDownload> {
    const url = new URL(`${this.basePath}/api/v4/${path.replace(/^\/+/, "")}`, this.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let target = url;
    let response: Response;
    for (let redirects = 0; ; redirects += 1) {
      try {
        response = await fetch(target, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "*/*",
            ...(target.origin === this.origin ? { "PRIVATE-TOKEN": this.token } : {}),
            "User-Agent": "gitlab-datacenter-mcp-server/1.0.0",
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new Error("GitLab artifact download timed out after 30 seconds.");
        }
        throw new Error(`Could not download the GitLab artifact: ${safeErrorMessage(error)}`);
      }

      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
      if (redirects >= 5) throw new Error("GitLab artifact download exceeded the redirect limit.");
      await response.body?.cancel();
      target = new URL(location, target);
    }

    if (!response.ok) {
      const responseText = await response.text();
      throw new GitLabApiError(
        response.status,
        describeApiError(response.status, responseText),
        response.headers.get("x-request-id") ?? undefined,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) return { data: new Uint8Array(), headers: response.headers, truncated: false };

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - totalBytes;
        if (value.byteLength > remaining) {
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          totalBytes += Math.max(remaining, 0);
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        totalBytes += value.byteLength;
        if (totalBytes === maxBytes) {
          const next = await reader.read();
          truncated = !next.done && next.value.byteLength > 0;
          if (!next.done) await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data: bytes, headers: response.headers, truncated };
  }
}

export function encodePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function describeApiError(status: number, responseText: string): string {
  const common: Record<number, string> = {
    401: "Authentication failed. Check GITLAB_TOKEN and confirm the token is still valid.",
    403: "GitLab denied this operation. Check the token scope and the user's project permissions.",
    404: "GitLab could not find this resource. Check the project path/ID and resource IID.",
    409: "GitLab reported a conflict. Refresh the resource state and retry if appropriate.",
    422: "GitLab rejected the supplied values. Check field requirements and validation details.",
    429: "GitLab rate limit reached. Wait before retrying.",
  };

  let detail = "";
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string") detail = message;
      else if (message !== undefined) detail = JSON.stringify(message);
    }
  } catch {
    // Do not echo HTML or arbitrary server responses into tool errors.
  }
  const prefix = common[status] ?? `GitLab API request failed with HTTP ${status}.`;
  return detail ? `${prefix} Details: ${detail.slice(0, 500)}` : prefix;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return "unknown network error";
}
