/**
 * Shared types for the probe-based system health layer.
 *
 * A "probe" is a small function that exercises one subsystem (DB, scheduler,
 * buffer, etc.) and returns a uniform ProbeResult. Active probes run on a
 * per-subsystem cadence; passive probes just read in-memory state when asked.
 *
 * The overall System Health page reads the latest cached ProbeResult for each
 * subsystem and rolls them up per §4.5 of the redesign spec.
 */

/**
 * - `healthy`  — subsystem is doing its job normally.
 * - `degraded` — subsystem is working but showing pressure (slow, pending work, etc.).
 * - `down`     — subsystem cannot perform its function.
 * - `standby`  — subsystem is idle by design (empty queue, 0 clients, etc.).
 *                Counted as healthy for rollups but rendered distinctly in the UI.
 * - `disabled` — subsystem is turned off by config (no auth middleware, no channels).
 *                Counted as healthy for rollups but rendered as muted.
 */
export type ProbeStatus = 'healthy' | 'degraded' | 'down' | 'standby' | 'disabled'

export interface ProbeResult {
  subsystemId: string
  status: ProbeStatus
  /** Probe round-trip latency (ms). Null when the probe is passive and just reports state. */
  latencyMs: number | null
  /** Subsystem-specific metrics displayed on the page. */
  details: Record<string, unknown>
  /** Epoch ms at which the probe completed. */
  probedAt: number
  /** Present only when status ∈ { 'degraded', 'down' }. */
  error?: string
}

/** Signature every subsystem probe must implement. */
export type ProbeFn = () => Promise<ProbeResult>

/** A single entry in a probe's rolling history ring. */
export interface ProbeHistoryEntry {
  ts: number
  status: ProbeStatus
  latencyMs: number | null
}

/** A subsystem probe is either "core" (carries weight in the overall rollup) or not. */
export type ProbeGroup = 'core' | 'non-core'
