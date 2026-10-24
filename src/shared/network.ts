// The parts of the network layer that don't need Electron: the bounded log of a
// tab's traffic, redaction of credentials, and rule patterns. The main process
// (main/network.ts) feeds the log from the DevTools protocol.
import type { NetworkEntry, NetworkEntrySummary, NetworkFilter } from "./api";

// --- Credentials -----------------------------------------------------------------------

export const REDACTED = "[redacted]";

const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "auth",
  "authorization",
  "authentication",
  "session",
  "sessionid",
  "sid",
  "csrf",
  "xsrf",
  "csrftoken",
  "xsrftoken",
  "credential",
  "credentials",
  "signature",
  "sig",
  "cookie",
  "cookies",
  "bearer",
  "otp",
  "jwt",
  "apikey",
  "accesskey",
  "privatekey",
]);

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a header, parameter or field name holds a credential ("Authorization",
 * "x-csrf-token", "accessToken", "api_key", "password"). `keyAlone`: a bare
 * "key" counts too (query parameters; in JSON it's usually just data).
 */
export function isSensitiveName(name: string, keyAlone = false) {
  const w = words(name);
  return w.some((word, i) => SENSITIVE_WORDS.has(word) || (word === "key" && (keyAlone || ["api", "access", "private", "secret"].includes(w[i - 1] ?? ""))));
}

const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[\w~+/.=-]{8,}/gi;

/** Token-looking strings anywhere in a text (JWTs, "Bearer …"). */
export const redactTokens = (text: string) => text.replace(JWT, REDACTED).replace(BEARER, `$1 ${REDACTED}`);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, isSensitiveName(name) ? REDACTED : redactTokens(value)]));
}

export function redactUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactTokens(url);
  }
  let changed = false;
  if (parsed.password) {
    parsed.password = "redacted";
    changed = true;
  }
  for (const [name] of [...parsed.searchParams]) {
    if (isSensitiveName(name, true)) {
      parsed.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  return redactTokens(changed ? parsed.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED) : url);
}

const redactJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSensitiveName(k) && (typeof v === "string" || typeof v === "number") ? REDACTED : redactJson(v)]),
    );
  }
  return typeof value === "string" ? redactTokens(value) : value;
};

/** A request or response body with credentials taken out: JSON fields, form fields, tokens. */
export function redactBody(body: string, mimeType = "") {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(body)));
    } catch {
      // not JSON after all
    }
  }
  if (/x-www-form-urlencoded/i.test(mimeType) || /^[\w.%[\]-]+=[^&\s]*(&[\w.%[\]-]+=[^&\s]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    let changed = false;
    for (const [name] of [...params]) {
      if (isSensitiveName(name, true)) {
        params.set(name, REDACTED);
        changed = true;
      }
    }
    if (changed) return params.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  }
  return redactTokens(body);
}

// --- Rules -----------------------------------------------------------------------------

/** "*" wildcards over the whole URL, or (without one) text the URL contains. Case-insensitive. */
export function urlMatcher(pattern: string): (url: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => false;
  if (!p.includes("*")) {
    const needle = p.toLowerCase();
    return (url) => url.toLowerCase().includes(needle);
  }
  const re = new RegExp(`^${p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return (url) => re.test(url);
}

// --- The log -------------------------------------------------------------------------

/** A captured request with everything (credentials included); only the main process has these. */
export interface Captured extends Omit<NetworkEntry, "redacted" | "hasBody"> {
  /** DevTools' monotonic timestamp (s) when it started. */
  startTs: number;
}

/** Structured data worth keeping the body of: JSON, XML, forms, text from fetch/XHR. */
export function isStructured(mimeType: string, type: string) {
  const m = mimeType.toLowerCase();
  if (/json|xml|graphql|x-www-form-urlencoded|csv|ndjson|event-stream|yaml|protobuf/.test(m) && !/svg/.test(m)) return true;
  return (type === "XHR" || type === "Fetch") && m.startsWith("text/") && !/css|javascript/.test(m);
}

const isData = (e: Captured) => ["XHR", "Fetch", "EventSource", "WebSocket"].includes(e.type) || isStructured(e.mimeType, e.type);

export interface Limits {
  /** Requests kept per tab (the oldest go first). */
  entries: number;
  /** Largest response body kept (characters). */
  body: number;
  /** Bodies kept per tab, in total (characters). */
  tabBodies: number;
}

export const DEFAULT_LIMITS: Limits = { entries: 500, body: 256 * 1024, tabBodies: 3 * 1024 * 1024 };

/** Shared by every tab's log: when all bodies together pass `max`, the oldest anywhere go. */
export class BodyBudget {
  used = 0;
  readonly logs = new Set<TrafficLog>();
  constructor(readonly max = 24 * 1024 * 1024) {}

  enforce() {
    while (this.used > this.max) {
      let oldest: TrafficLog | undefined;
      for (const log of this.logs) {
        const first = log.oldestBody();
        if (first && (!oldest || first.startedAt < oldest.oldestBody()!.startedAt)) oldest = log;
      }
      if (!oldest) return;
      oldest.dropOldestBody();
    }
  }
}

/** One tab's recent traffic, bounded in count and body size. */
export class TrafficLog {
  private entries: Captured[] = [];
  private byId = new Map<string, Captured>();
  private bodies: Captured[] = [];
  private bodyChars = 0;
  private seq = 0;

  constructor(
    private budget: BodyBudget,
    readonly limits: Limits = DEFAULT_LIMITS,
  ) {
    budget.logs.add(this);
  }

  get size() {
    return this.entries.length;
  }

  add(entry: Omit<Captured, "id">): Captured {
    const captured = { ...entry, id: String(++this.seq) } as Captured;
    this.entries.push(captured);
    this.byId.set(captured.id, captured);
    while (this.entries.length > this.limits.entries) this.remove(this.entries[0]!);
    return captured;
  }

  get(id: string) {
    return this.byId.get(id);
  }

  /** Keeps a response body if it fits; returns whether it was kept. */
  setBody(entry: Captured, body: string) {
    if (!this.byId.has(entry.id)) return false;
    if (body.length > this.limits.body) {
      entry.bodyNote = "Too large to keep";
      return false;
    }
    this.dropBody(entry);
    entry.responseBody = body;
    entry.bodyNote = null;
    this.bodies.push(entry);
    this.bodyChars += body.length;
    this.budget.used += body.length;
    while (this.bodyChars > this.limits.tabBodies) this.dropOldestBody();
    this.budget.enforce();
    return entry.responseBody !== null;
  }

  oldestBody() {
    return this.bodies[0];
  }

  dropOldestBody() {
    const entry = this.bodies[0];
    if (!entry) return;
    this.dropBody(entry);
    entry.bodyNote = "Dropped to save memory";
  }

  private dropBody(entry: Captured) {
    if (entry.responseBody === null) return;
    this.bodyChars -= entry.responseBody.length;
    this.budget.used -= entry.responseBody.length;
    entry.responseBody = null;
    const i = this.bodies.indexOf(entry);
    if (i !== -1) this.bodies.splice(i, 1);
  }

  private remove(entry: Captured) {
    this.dropBody(entry);
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.byId.delete(entry.id);
  }

  clear() {
    for (const entry of [...this.entries]) this.remove(entry);
  }

  /** Stops counting against the shared budget (the tab closed). */
  dispose() {
    this.clear();
    this.budget.logs.delete(this);
  }

  list(filter: NetworkFilter = {}, redact = true): NetworkEntrySummary[] {
    const query = filter.query?.trim().toLowerCase();
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), this.limits.entries);
    const matches = this.entries.filter(
      (e) =>
        (filter.kind !== "data" || isData(e)) &&
        (!query || `${e.method} ${e.url} ${e.type} ${e.status ?? ""} ${e.mimeType}`.toLowerCase().includes(query)),
    );
    return matches.slice(-limit).map((e) => summary(e, redact));
  }

  detail(id: string, redact = true): NetworkEntry | null {
    const e = this.byId.get(id);
    if (!e) return null;
    return {
      ...summary(e, redact),
      requestHeaders: redact ? redactHeaders(e.requestHeaders) : { ...e.requestHeaders },
      responseHeaders: redact ? redactHeaders(e.responseHeaders) : { ...e.responseHeaders },
      requestBody: e.requestBody !== null && redact ? redactBody(e.requestBody, e.requestHeaders["content-type"] ?? e.requestHeaders["Content-Type"]) : e.requestBody,
      responseBody: e.responseBody !== null && redact ? redactBody(e.responseBody, e.mimeType) : e.responseBody,
      bodyNote: e.bodyNote,
      redacted: redact,
    };
  }
}

const summary = (e: Captured, redact: boolean): NetworkEntrySummary => ({
  id: e.id,
  method: e.method,
  url: redact ? redactUrl(e.url) : e.url,
  type: e.type,
  status: e.status,
  mimeType: e.mimeType,
  size: e.size,
  startedAt: e.startedAt,
  durationMs: e.durationMs,
  error: e.error,
  rule: e.rule,
  hasBody: e.responseBody !== null,
});
