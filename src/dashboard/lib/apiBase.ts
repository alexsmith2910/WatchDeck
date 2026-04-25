/**
 * Runtime locators the SPA reads to find itself inside the host environment:
 *
 *   • API base — where data fetches go
 *   • Base path — what URL prefix BrowserRouter is mounted under
 *   • Auth headers — extra headers prepended to every fetch (token refresh
 *     friendly: re-invoked per request)
 *
 * Resolution priority for the first two:
 *   1. Programmatic override (`setApiBase` / `setBasePath`) — used by the
 *      `WatchDeckDashboard` mountable component before its first render.
 *   2. `data-api-url` / `data-base-path` on `<div id="root">` — written by
 *      the Fastify dashboard plugin in standalone mode.
 *   3. Built-in defaults (`/api/mx`, root mount).
 *
 * Values are cached on first read so repeat calls are cheap; programmatic
 * setters seed the cache directly.
 */

function readRootAttr(name: string): string | null {
  if (typeof document === "undefined") return null;
  return document.getElementById("root")?.getAttribute(name) ?? null;
}

// ── API base ──────────────────────────────────────────────────────────────
let cachedApiBase: string | null = null;
export function setApiBase(value: string): void {
  cachedApiBase = value.replace(/\/+$/, "");
}
export function getApiBase(): string {
  if (cachedApiBase !== null) return cachedApiBase;
  const attr = readRootAttr("data-api-url");
  cachedApiBase = attr ? attr.replace(/\/+$/, "") : "/api/mx";
  return cachedApiBase;
}

// ── Base path ─────────────────────────────────────────────────────────────
// Returns "" (not "/") when mounted at the root — React Router rejects "/" as
// a basename.
let cachedBasePath: string | null = null;
export function setBasePath(value: string): void {
  cachedBasePath = value === "/" || value === "" ? "" : value.replace(/\/+$/, "");
}
export function getBasePath(): string {
  if (cachedBasePath !== null) return cachedBasePath;
  const attr = readRootAttr("data-base-path");
  if (!attr || attr === "/") {
    cachedBasePath = "";
  } else {
    cachedBasePath = attr.replace(/\/+$/, "");
  }
  return cachedBasePath;
}

// ── Auth headers ──────────────────────────────────────────────────────────
// Function (not value) so token refresh works without re-mounting the SPA —
// the host app can hand back a fresh bearer on every request.
type AuthHeadersFn = () => Record<string, string>;
let authHeadersFn: AuthHeadersFn | null = null;
export function setAuthHeaders(fn: AuthHeadersFn | null): void {
  authHeadersFn = fn;
}
export function getAuthHeaders(): Record<string, string> {
  return authHeadersFn ? authHeadersFn() : {};
}
