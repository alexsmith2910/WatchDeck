/**
 * Dashboard plugin — serves the built React SPA in standalone mode.
 *
 * Mounted at `config.dashboardRoute` (default `/dashboard`):
 *   • Static assets via @fastify/static (hashed JS/CSS bundles, logo, etc.)
 *   • Catch-all returns `index.html` with `data-api-url` injected onto
 *     `<div id="root">` so the SPA can locate the API at runtime — the
 *     dashboard's `getApiBase()` helper reads this attribute.
 *
 * Skipped entirely when `dashboardMode === 'mounted'` or `--api-only` was
 * passed to `start` — the host app embeds the dashboard component instead.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'

interface DashboardPluginOpts {
  dashboardRoute: string
  apiBasePath: string
}

// Paths Vite emits as root-relative in the built index.html. We rewrite these
// to sit under `dashboardRoute` at request time so the static handler actually
// serves them. Keeping the build base at `/` lets the same dist/ run under any
// configured dashboardRoute without a rebuild.
const ROOT_RELATIVE_REFS = [
  /(\ssrc=")\/(assets\/[^"]+)"/g,
  /(\shref=")\/(assets\/[^"]+)"/g,
  /(\shref=")\/(logo-mark\.svg)"/g,
]

// `dist/bin/cli.js` after bundling → `dist/dashboard/` is one level up.
// In dev (running ts directly) the same relationship holds: `src/api/` →
// `dist/dashboard/` doesn't, but standalone mode is meant to run from the
// installed package's `dist/`, so this is the correct production layout.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_DIR = path.resolve(HERE, '../dashboard')

export function dashboardPlugin(opts: DashboardPluginOpts) {
  const { dashboardRoute, apiBasePath } = opts
  // Trim trailing slash so `${route}/foo` and `${route}/` produce sane joins.
  const route = dashboardRoute.replace(/\/+$/, '') || '/'

  return async (fastify: FastifyInstance): Promise<void> => {
    // Static asset serving — only matches files that physically exist under
    // `dist/dashboard/`. Anything else (e.g. /dashboard/endpoints/123) falls
    // through to the catch-all below so client-side routing takes over.
    await fastify.register(fastifyStatic, {
      root: DASHBOARD_DIR,
      prefix: route === '/' ? '/' : `${route}/`,
      // We handle the not-found case ourselves via the catch-all → SPA shell.
      wildcard: false,
      // Avoid sending index.html for bare directory hits — the catch-all
      // does that with the proper API URL injection.
      index: false,
      // Hashed bundles can be cached aggressively; index.html (served via the
      // catch-all) sets its own no-store header.
      cacheControl: true,
      maxAge: '7d',
      decorateReply: false,
    })

    // Catch-all SPA shell. Matches `dashboardRoute` itself plus any deeper
    // path so React Router can handle hard refreshes on `/dashboard/foo/bar`.
    const catchAllPaths = route === '/' ? ['/', '/*'] : [route, `${route}/*`]
    for (const p of catchAllPaths) {
      fastify.get(p, async (_request: FastifyRequest, reply: FastifyReply) => {
        const html = await loadIndexHtml(apiBasePath, route)
        return reply
          .header('Content-Type', 'text/html; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .send(html)
      })
    }
  }
}

// Read + transform once per request — file is small and the overhead is
// negligible compared to the rest of the response. Avoiding a process-level
// cache means dev rebuilds (vite + tsup running together) pick up new index
// hashes without restarting the API server.
async function loadIndexHtml(apiBasePath: string, route: string): Promise<string> {
  const raw = await readFile(path.join(DASHBOARD_DIR, 'index.html'), 'utf8')
  const withAssets = rewriteAssetPaths(raw, route)
  return injectRootAttrs(withAssets, apiBasePath, route)
}

// Rewrite Vite's root-relative asset refs to live under `dashboardRoute`. No-op
// when route === '/'.
function rewriteAssetPaths(html: string, route: string): string {
  if (route === '/') return html
  let out = html
  for (const re of ROOT_RELATIVE_REFS) {
    out = out.replace(re, (_m, attr: string, rel: string) => `${attr}${route}/${rel}"`)
  }
  return out
}

// Inject both runtime locators onto `<div id="root">` in a single pass:
//   data-api-url   — where the SPA fetches data from
//   data-base-path — the URL prefix BrowserRouter is mounted under
// Idempotent: replaces existing attributes if a previous run already wrote
// them, otherwise adds a fresh pair.
function injectRootAttrs(html: string, apiBasePath: string, route: string): string {
  const safeApi = escapeAttr(apiBasePath)
  const safeBase = escapeAttr(route)
  let out = html
  if (out.includes('data-api-url=')) {
    out = out.replace(/data-api-url="[^"]*"/, `data-api-url="${safeApi}"`)
  } else {
    out = out.replace('<div id="root"', `<div id="root" data-api-url="${safeApi}"`)
  }
  if (out.includes('data-base-path=')) {
    out = out.replace(/data-base-path="[^"]*"/, `data-base-path="${safeBase}"`)
  } else {
    out = out.replace('<div id="root"', `<div id="root" data-base-path="${safeBase}"`)
  }
  return out
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
