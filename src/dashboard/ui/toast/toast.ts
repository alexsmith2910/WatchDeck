/**
 * Wrapper around HeroUI's toast queue.
 *
 * Adds:
 *   - `ToastKind` → HeroUI variant + icon + default timeout (variants.ts)
 *   - stable-id updates (calling with the same `id` replaces the existing toast)
 *   - group dedup + cap (older ones close when `maxInGroup` is exceeded)
 *   - onClose subscription (timeout vs user vs programmatic)
 *   - close/clear/clearGroup/update
 *
 * The HeroUI queue is created here as `wdToastQueue` and passed into our
 * ToastProvider so this module's imperative API and the provider share state.
 */
import { ToastQueue } from '@heroui/react'
import type { ToastShellValue } from './ToastShell.js'
import type {
  ToastKind,
  ToastOptions,
  ToastPromiseOptions,
  ToastCloseReason,
} from './types.js'
import { kindSpec } from './variants.js'

/**
 * Hard cap on how many toasts RAC is allowed to track at once.
 *
 * HeroUI's ToastQueue wrapper always constructs the underlying RAC queue with
 * `maxVisibleToasts: Number.MAX_SAFE_INTEGER` and only uses its own
 * `maxVisibleToasts` to drive opacity. That means every toast ever added stays
 * in `visibleToasts` until its timer fires, and each new arrival pushes every
 * older one to a higher index — translateY = -index * gap — so the visible
 * stack creeps upward even though the "hidden" ones are opacity: 0.
 *
 * We enforce the cap manually in `enqueue`: after adding, close anything that
 * falls off the tail of `visibleToasts`. Keep this matched to the provider's
 * `maxVisibleToasts` prop.
 */
const MAX_VISIBLE_TOASTS = 3

export const wdToastQueue = new ToastQueue<ToastShellValue>({
  maxVisibleToasts: MAX_VISIBLE_TOASTS,
})

// ---------------------------------------------------------------------------
// Bookkeeping for ids, groups, and close reasons
// ---------------------------------------------------------------------------

interface Tracked {
  queueKey: string
  id?: string
  group?: string
  onClose?: (reason: ToastCloseReason) => void
  closed?: boolean
}

/** queueKey → tracked entry */
const byKey = new Map<string, Tracked>()
/** user id → queueKey */
const byId = new Map<string, string>()
/** group name → list of queueKeys in insertion order */
const byGroup = new Map<string, string[]>()

function forget(queueKey: string) {
  const t = byKey.get(queueKey)
  if (!t) return
  byKey.delete(queueKey)
  if (t.id) byId.delete(t.id)
  if (t.group) {
    const list = byGroup.get(t.group)
    if (list) {
      const i = list.indexOf(queueKey)
      if (i !== -1) list.splice(i, 1)
      if (list.length === 0) byGroup.delete(t.group)
    }
  }
}

function closeTracked(queueKey: string, reason: ToastCloseReason) {
  const t = byKey.get(queueKey)
  if (!t || t.closed) return
  t.closed = true
  try { t.onClose?.(reason) } catch { /* swallow */ }
  wdToastQueue.close(queueKey)
  forget(queueKey)
}

// ---------------------------------------------------------------------------
// Core enqueue
// ---------------------------------------------------------------------------

function enqueue(opts: ToastOptions, titleOverride?: React.ReactNode): string {
  const spec = kindSpec(opts.kind)
  const title = titleOverride ?? opts.title

  // Stable id replaces any existing entry for the same id.
  if (opts.id) {
    const existing = byId.get(opts.id)
    if (existing) closeTracked(existing, 'programmatic')
  }

  const content: ToastShellValue = {
    variant: spec.variant,
    icon: opts.indicator === false || typeof opts.indicator !== 'undefined' ? undefined : spec.icon,
    accent: opts.accent,
    title,
    description: opts.description,
    indicatorOverride: opts.indicator,
    isLoading: opts.kind === 'loading' || opts.kind === 'promise',
    actions: opts.actions,
    link: opts.link,
  }

  // HeroUI's queue wrapper interprets `undefined` as "use default (4s)" and
  // `0` as "persistent". Map our null / Infinity (persistent) → 0, not undefined.
  const resolvedTimeout =
    opts.timeout === null ? 0
    : typeof opts.timeout === 'number' ? opts.timeout
    : spec.defaultTimeout === Infinity ? 0
    : spec.defaultTimeout

  const queueKey = wdToastQueue.add(content, {
    timeout: resolvedTimeout,
    onClose: () => {
      const t = byKey.get(queueKey)
      if (t && !t.closed) {
        t.closed = true
        try { t.onClose?.('timeout') } catch { /* swallow */ }
        forget(queueKey)
      }
    },
  })

  const tracked: Tracked = {
    queueKey,
    id: opts.id,
    group: opts.group,
    onClose: opts.onClose,
  }
  byKey.set(queueKey, tracked)
  if (opts.id) byId.set(opts.id, queueKey)

  if (opts.group) {
    const list = byGroup.get(opts.group) ?? []
    list.push(queueKey)
    byGroup.set(opts.group, list)
    const cap = opts.maxInGroup ?? 3
    while (list.length > cap) {
      const oldest = list[0]!
      closeTracked(oldest, 'programmatic')
    }
  }

  // Global cap: evict anything past MAX_VISIBLE_TOASTS. RAC inserts new
  // toasts at index 0, so entries beyond the cap are the oldest — close
  // them immediately to keep the stack from creeping upward.
  const visible = wdToastQueue.visibleToasts
  for (let i = MAX_VISIBLE_TOASTS; i < visible.length; i++) {
    closeTracked(visible[i]!.key, 'programmatic')
  }

  if (opts.onMount) queueMicrotask(opts.onMount)

  return opts.id ?? queueKey
}

// ---------------------------------------------------------------------------
// Public call shapes
// ---------------------------------------------------------------------------

function show(titleOrOpts: React.ReactNode | ToastOptions, opts?: Omit<ToastOptions, 'title'>): string {
  if (titleOrOpts && typeof titleOrOpts === 'object' && !Array.isArray(titleOrOpts) && 'kind' in (titleOrOpts as object)) {
    return enqueue(titleOrOpts as ToastOptions)
  }
  return enqueue({ ...(opts ?? {}), title: titleOrOpts as React.ReactNode })
}

function withKind(kind: ToastKind) {
  return (title: React.ReactNode, opts?: Omit<ToastOptions, 'kind' | 'title'>): string =>
    enqueue({ ...(opts ?? {}), kind, title })
}

function update(id: string, opts: Partial<ToastOptions>): string | null {
  const queueKey = byId.get(id)
  if (!queueKey) return null
  const existing = byKey.get(queueKey)
  if (!existing) return null
  // HeroUI's queue has no native update — close + re-emit with same id.
  closeTracked(queueKey, 'programmatic')
  return enqueue({ ...opts, id })
}

function close(idOrKey: string) {
  const queueKey = byId.get(idOrKey) ?? idOrKey
  closeTracked(queueKey, 'user')
}

function clear() {
  for (const key of Array.from(byKey.keys())) closeTracked(key, 'programmatic')
}

function clearGroup(group: string) {
  const list = byGroup.get(group)
  if (!list) return
  for (const key of [...list]) closeTracked(key, 'programmatic')
}

async function promise<T>(
  input: Promise<T> | (() => Promise<T>),
  o: ToastPromiseOptions<T>,
): Promise<T> {
  const id = `promise:${Math.random().toString(36).slice(2, 10)}`
  const p = typeof input === 'function' ? input() : input

  enqueue({
    kind: 'loading',
    title: o.loading,
    description: o.descriptionLoading,
    timeout: null,
    id,
  })

  // On settle: close the loader (if still open — user may have dismissed it)
  // and emit a fresh success/error toast so the result reads as a new event.
  try {
    const data = await p
    close(id)
    const title = typeof o.success === 'function' ? o.success(data) : o.success
    const desc = typeof o.descriptionSuccess === 'function' ? o.descriptionSuccess(data) : o.descriptionSuccess
    enqueue({ kind: 'success', title, description: desc })
    return data
  } catch (err) {
    close(id)
    const e = err instanceof Error ? err : new Error(String(err))
    const title = typeof o.error === 'function' ? o.error(e) : o.error
    const desc = typeof o.descriptionError === 'function' ? o.descriptionError(e) : o.descriptionError
    enqueue({ kind: 'error', title, description: desc })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Exported API — this is the only surface app code should use
// ---------------------------------------------------------------------------

export const toast = Object.assign(show, {
  success: withKind('success'),
  error:   withKind('error'),
  warning: withKind('warning'),
  info:    withKind('info'),
  neutral: withKind('neutral'),
  loading: withKind('loading'),
  custom:  (opts: ToastOptions) => enqueue(opts),
  promise,
  update,
  close,
  clear,
  clearGroup,
})

export type ToastApi = typeof toast
