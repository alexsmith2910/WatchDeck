/**
 * Pure helpers + shared types for the incident detail page.
 *
 * Lifted out of IncidentDetailPage.tsx so the page + its component tree
 * share one source of truth for formatting, classification, and search.
 */
import type { ApiCheck, IncidentTimelineEvent } from "../../types/api";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Subset of fields the SSE `check:complete` event actually sends. This is
 * intentionally NOT ApiCheck — the event has no `_id`, no SSL/body-validation
 * fields, because the broker forwards the raw check engine event, not the
 * saved DB document.
 */
export interface LiveCheck {
  timestamp: string;
  endpointId: string;
  status: "healthy" | "degraded" | "down";
  responseTime: number;
  statusCode: number | null;
  errorMessage: string | null;
}

/** Shared shape used by chart + impact + timeline. Both ApiCheck and LiveCheck
 *  satisfy it, so downstream code doesn't care which source it came from. */
export interface CheckPoint {
  timestamp: string;
  status: "healthy" | "degraded" | "down";
  responseTime: number;
  statusCode: number | null;
  errorMessage?: string | null;
  /** Present for persisted ApiCheck rows, absent for LiveCheck. */
  id?: string;
}

export interface TimelineMeta {
  icon: string;
  iconColor: string;
  tileBg: string;
}

export interface TimelineRow {
  key: string;
  at: string | Date;
  event: string;
  detail?: string;
  check?: CheckPoint;
  badge?: "trigger" | "recovery";
}

export interface IssueSignature {
  fingerprint: string;
  status: "down" | "degraded";
  statusCode: number | null;
  errorMessage: string | null;
  count: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
  firstAt: string;
  lastAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Cap incident-detail live checks — chart doesn't need more history than this
// and leaving the page open on an active incident would otherwise grow forever.
export const MAX_INCIDENT_CHECKS = 1000;

// ---------------------------------------------------------------------------
// Labels + classification
// ---------------------------------------------------------------------------

export function humanCause(cause: string): string {
  const map: Record<string, string> = {
    endpoint_down: "Endpoint Down",
    endpoint_degraded: "Degraded Performance",
    ssl_expiring: "SSL Certificate Expiring",
    ssl_expired: "SSL Certificate Expired",
    high_latency: "High Latency",
    body_mismatch: "Body Validation Failed",
    port_closed: "Port Closed",
  };
  return (
    map[cause] ??
    cause.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function humanEvent(event: string): string {
  const map: Record<string, string> = {
    opened: "Incident Opened",
    resolved: "Incident Resolved",
    check: "Health Check",
    notification_sent: "Notification Sent",
    escalated: "Escalated",
  };
  return (
    map[event] ??
    event.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function severityFromCause(cause: string): {
  label: "Critical" | "Major" | "Minor";
  tone: "danger" | "warning" | "muted";
} {
  const critical = ["endpoint_down", "ssl_expired", "port_closed"];
  const major = ["endpoint_degraded", "high_latency", "body_mismatch"];
  const minor = ["ssl_expiring"];
  if (critical.includes(cause)) return { label: "Critical", tone: "danger" };
  if (major.includes(cause)) return { label: "Major", tone: "warning" };
  if (minor.includes(cause)) return { label: "Minor", tone: "muted" };
  return { label: "Major", tone: "warning" };
}

export function timelineMeta(event: string, detail?: string): TimelineMeta {
  switch (event) {
    case "opened":
      return {
        icon: "solar:flag-bold",
        iconColor: "text-wd-primary",
        tileBg: "bg-wd-primary/10 border-wd-primary/20",
      };
    case "resolved":
      return {
        icon: "solar:flag-2-bold",
        iconColor: "text-wd-success",
        tileBg: "bg-wd-success/10 border-wd-success/20",
      };
    case "notification_sent":
      return {
        icon: "solar:bell-bold",
        iconColor: "text-wd-warning",
        tileBg: "bg-wd-warning/10 border-wd-warning/20",
      };
    case "escalated":
      return {
        icon: "solar:double-alt-arrow-up-bold",
        iconColor: "text-wd-warning",
        tileBg: "bg-wd-warning/10 border-wd-warning/20",
      };
    case "check": {
      if (detail?.includes("down")) {
        return {
          icon: "solar:close-circle-bold",
          iconColor: "text-wd-danger",
          tileBg: "bg-wd-danger/10 border-wd-danger/20",
        };
      }
      if (detail?.includes("degraded")) {
        return {
          icon: "solar:minus-circle-bold",
          iconColor: "text-wd-warning",
          tileBg: "bg-wd-warning/10 border-wd-warning/20",
        };
      }
      return {
        icon: "solar:pulse-linear",
        iconColor: "text-wd-muted",
        tileBg: "bg-wd-surface-hover border-wd-border/50",
      };
    }
    default:
      return {
        icon: "solar:info-circle-linear",
        iconColor: "text-wd-muted",
        tileBg: "bg-wd-surface-hover border-wd-border/50",
      };
  }
}

export function statusCodeColor(code: number): string {
  if (code >= 500) return "bg-wd-danger/15 text-wd-danger";
  if (code >= 400) return "bg-wd-warning/15 text-wd-warning";
  if (code >= 200 && code < 300) return "bg-wd-success/15 text-wd-success";
  return "bg-wd-surface-hover text-wd-muted";
}

// ---------------------------------------------------------------------------
// Parsing + formatting
// ---------------------------------------------------------------------------

/** Parse a check detail string like "down -- 503 -- 142ms" into parts. */
export function parseCheckDetail(detail?: string): {
  status?: string;
  statusCode?: number;
  responseTime?: string;
} {
  if (!detail) return {};
  const parts = detail.split(/\s*[—–-]\s*/).map((s) => s.trim());
  const result: {
    status?: string;
    statusCode?: number;
    responseTime?: string;
  } = {};
  if (parts[0]) result.status = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const codeMatch = /^(?:HTTP\s+)?(\d{3})$/.exec(p);
    if (codeMatch) {
      result.statusCode = parseInt(codeMatch[1], 10);
    } else if (/\d+\s*ms/i.test(p)) {
      result.responseTime = p;
    }
  }
  return result;
}

/** Mirror the server format so parseCheckDetail handles live-check rows the
 *  same as server-written ones. Must match incidentManager.ts. */
export function buildLiveCheckDetail(c: LiveCheck): string {
  if (c.errorMessage) return `${c.status} — ${c.errorMessage}`;
  return `${c.status} — ${c.statusCode ?? "no status code"} — ${c.responseTime}ms`;
}

/** A fingerprint used to group consecutive identical check rows. */
export function checkFingerprint(
  c: CheckPoint | undefined,
  detail: string | undefined,
): string {
  const status = c?.status ?? parseCheckDetail(detail).status ?? "?";
  const code = c?.statusCode ?? parseCheckDetail(detail).statusCode ?? "none";
  const err = c?.errorMessage ?? "none";
  return `${status}|${code}|${err}`;
}

/** Compute the live or final duration in seconds. */
export function computeDuration(
  startedAt: string,
  resolvedAt?: string,
  durationSeconds?: number,
): number {
  if (durationSeconds != null) return durationSeconds;
  if (resolvedAt) {
    return Math.floor(
      (new Date(resolvedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    );
  }
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
}

/**
 * Format a relative offset from an anchor timestamp, signed.
 * Examples: "+0s", "+2m 14s", "+1h 03m", "-15s" (for pre-incident checks).
 */
export function formatRelativeFromAnchor(
  at: string | Date,
  anchor: string | Date,
): string {
  const t = typeof at === "string" ? new Date(at).getTime() : at.getTime();
  const a =
    typeof anchor === "string" ? new Date(anchor).getTime() : anchor.getTime();
  const deltaSec = Math.round((t - a) / 1000);
  const sign = deltaSec < 0 ? "-" : "+";
  const abs = Math.abs(deltaSec);
  if (abs < 60) return `${sign}${abs}s`;
  if (abs < 3600) {
    const m = Math.floor(abs / 60);
    const s = abs % 60;
    return s > 0
      ? `${sign}${m}m ${String(s).padStart(2, "0")}s`
      : `${sign}${m}m`;
  }
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  return m > 0 ? `${sign}${h}h ${String(m).padStart(2, "0")}m` : `${sign}${h}h`;
}

// ---------------------------------------------------------------------------
// Search / derivation
// ---------------------------------------------------------------------------

/**
 * Binary search for the index in a sorted-by-timestamp array that is nearest
 * to target. Returns -1 if the array is empty.
 */
export function nearestIndexByTimestamp(
  sortedTs: number[],
  targetMs: number,
): number {
  if (sortedTs.length === 0) return -1;
  let lo = 0;
  let hi = sortedTs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedTs[mid] < targetMs) lo = mid + 1;
    else hi = mid;
  }
  if (
    lo > 0 &&
    Math.abs(sortedTs[lo - 1] - targetMs) < Math.abs(sortedTs[lo] - targetMs)
  ) {
    return lo - 1;
  }
  return lo;
}

/** Group failing checks by fingerprint; healthy checks are ignored. */
export function buildSignatures(checks: CheckPoint[]): IssueSignature[] {
  const map = new Map<string, IssueSignature>();
  for (const c of checks) {
    if (c.status === "healthy") continue;
    const fp = `${c.status}|${c.statusCode ?? "none"}|${c.errorMessage ?? "none"}`;
    const existing = map.get(fp);
    if (!existing) {
      map.set(fp, {
        fingerprint: fp,
        status: c.status,
        statusCode: c.statusCode,
        errorMessage: c.errorMessage ?? null,
        count: 1,
        minMs: c.responseTime,
        avgMs: c.responseTime,
        maxMs: c.responseTime,
        firstAt: c.timestamp,
        lastAt: c.timestamp,
      });
    } else {
      existing.count += 1;
      existing.minMs = Math.min(existing.minMs, c.responseTime);
      existing.maxMs = Math.max(existing.maxMs, c.responseTime);
      existing.avgMs = Math.round(
        (existing.avgMs * (existing.count - 1) + c.responseTime) /
          existing.count,
      );
      if (c.timestamp < existing.firstAt) existing.firstAt = c.timestamp;
      if (c.timestamp > existing.lastAt) existing.lastAt = c.timestamp;
    }
  }
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.firstAt.localeCompare(b.firstAt),
  );
}

/** Normalize an ApiCheck into a CheckPoint (drops fields not in CheckPoint). */
export function toCheckPoint(c: ApiCheck): CheckPoint {
  return {
    id: c.id,
    timestamp: c.timestamp,
    status: c.status,
    responseTime: c.responseTime,
    statusCode: c.statusCode ?? null,
    errorMessage: c.errorMessage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Timeline compression
// ---------------------------------------------------------------------------

/**
 * A single row rendered by IncidentTimeline. Either a raw server event or a
 * synthetic "N <status> checks" summary that stands in for a long run of
 * repetitive check entries. The raw check log at the bottom of the page
 * still holds every probe; this is strictly a visual condensation.
 */
export interface TimelineDisplayRow {
  key: string;
  at: string;
  /** opened | resolved | check | escalated | notification_sent | collapsed_checks */
  event: string;
  detail?: string;
  /** For `collapsed_checks` only — how many check rows were merged. */
  collapsedCount?: number;
  collapsedStatus?: "healthy" | "degraded" | "down";
  /** For `collapsed_checks` only — first and last timestamps in the run. */
  spanFrom?: string;
  spanTo?: string;
}

/** Shorter-than-or-equal-to this keeps each check row individually. Longer
 *  runs collapse into a single summary. Tuned so that typical failure /
 *  recovery thresholds (1–3) still render each check while long sustained
 *  failures don't drown the timeline. */
const TIMELINE_RUN_INDIVIDUAL_LIMIT = 4;

function isoOf(at: string | Date): string {
  return typeof at === "string" ? at : new Date(at).toISOString();
}

function statusFromDetail(
  detail: string | undefined,
): "healthy" | "degraded" | "down" {
  const s = parseCheckDetail(detail).status?.toLowerCase();
  if (s === "healthy") return "healthy";
  if (s === "degraded") return "degraded";
  return "down";
}

/**
 * Collapse long runs of consecutive same-status check events into a single
 * "N <status> checks" summary row. Non-check events (opened / resolved /
 * escalated / notification_sent) pass through unchanged. Pre-open failing
 * probes can be prepended by passing `preOpenFailing` — we take the last
 * `failureThreshold` of them so the user can see the checks that caused
 * the open event.
 */
export function buildCompressedTimeline(opts: {
  timeline: IncidentTimelineEvent[];
  preOpenFailing: CheckPoint[];
  failureThreshold: number;
  startedAt: string;
}): TimelineDisplayRow[] {
  const { timeline, preOpenFailing, failureThreshold, startedAt } = opts;
  const out: TimelineDisplayRow[] = [];

  // 1. Pre-open failing context — the checks that tripped the threshold.
  const startMs = new Date(startedAt).getTime();
  const preOpen = preOpenFailing
    .filter(
      (c) =>
        c.status !== "healthy" &&
        new Date(c.timestamp).getTime() < startMs,
    )
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
    .slice(-failureThreshold);
  for (const c of preOpen) {
    out.push({
      key: `pre:${c.timestamp}`,
      at: c.timestamp,
      event: "check",
      detail: `${c.status} — ${c.statusCode ?? c.errorMessage ?? "no status"} — ${c.responseTime}ms`,
    });
  }

  // 2. Walk the server timeline, buffering consecutive check events so they
  //    can be compressed against non-check boundaries.
  let buffer: IncidentTimelineEvent[] = [];

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    // Split into runs of same status.
    const runs: { status: "healthy" | "degraded" | "down"; items: IncidentTimelineEvent[] }[] = [];
    for (const e of buffer) {
      const st = statusFromDetail(e.detail);
      const last = runs[runs.length - 1];
      if (last && last.status === st) last.items.push(e);
      else runs.push({ status: st, items: [e] });
    }
    for (const run of runs) {
      if (run.items.length <= TIMELINE_RUN_INDIVIDUAL_LIMIT) {
        for (const e of run.items) {
          out.push({
            key: `tl:${isoOf(e.at)}`,
            at: isoOf(e.at),
            event: e.event,
            detail: e.detail,
          });
        }
      } else {
        const first = run.items[0];
        const last = run.items[run.items.length - 1];
        out.push({
          key: `run:${isoOf(first.at)}-${run.items.length}`,
          at: isoOf(first.at),
          event: "collapsed_checks",
          collapsedCount: run.items.length,
          collapsedStatus: run.status,
          spanFrom: isoOf(first.at),
          spanTo: isoOf(last.at),
        });
      }
    }
    buffer = [];
  };

  for (const e of timeline) {
    if (e.event === "check") {
      buffer.push(e);
    } else {
      flushBuffer();
      out.push({
        key: `tl:${isoOf(e.at)}:${e.event}`,
        at: isoOf(e.at),
        event: e.event,
        detail: e.detail,
      });
    }
  }
  flushBuffer();

  return out;
}
