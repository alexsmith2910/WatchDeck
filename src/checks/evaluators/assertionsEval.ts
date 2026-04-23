/**
 * Assertion evaluator.
 *
 * Runs per-endpoint assertion rules configured in the dashboard's Assertions
 * tab. Invoked from checkRunner AFTER the status-code gate — if the base
 * status is already `down`, the runner skips this work entirely (there is
 * often no body/headers to check on connection errors).
 *
 * Evaluation model:
 *   - All rules run regardless of individual outcomes, so the dashboard can
 *     render per-rule pass/fail chips in the Checks tab.
 *   - Final composite status is the WORST of:
 *       statusEval base status (healthy/degraded — never 'down' here)
 *       ⊕ any failed `severity: "down"` assertion → down
 *       ⊕ any failed `severity: "degraded"` assertion → degraded
 *
 * JSON path syntax is intentionally a tiny dotted reader (no wildcards,
 * filters, or recursive descent). See Rules of use in the dashboard for the
 * user-facing spec.
 */

import type {
  Assertion,
  AssertionEvalResult,
  AssertionOperator,
  AssertionResult,
  AssertionSeverity,
} from '../../storage/types.js'

export interface AssertionEvalInput {
  assertions: Assertion[]
  /** Response body string. Null when the probe couldn't read one. */
  body: string | null
  /** Response headers with lowercase keys. Null when the probe errored out. */
  headers: Record<string, string> | null
  /** Actual elapsed time for the probe, in ms. */
  responseTime: number
  /** TLS certificate days-until-expiry, when captureSsl fired. Null otherwise. */
  sslDaysRemaining: number | null
  /** Whether the endpoint URL is https://. Drives the SSL-rule error wording. */
  isHttps: boolean
}

export function evaluateAssertions(input: AssertionEvalInput): AssertionEvalResult {
  const results: AssertionResult[] = []
  // Parse body as JSON once; any json-kind rule reuses this. Cached as
  // `undefined` until first json rule runs so we don't pay the cost when
  // every rule is latency/header/body.
  let cachedJson: unknown = UNPARSED
  let jsonParseError: string | null = null

  for (let i = 0; i < input.assertions.length; i++) {
    const a = input.assertions[i]
    const base = baseResult(i, a)

    try {
      switch (a.kind) {
        case 'latency':
          results.push(evalLatency(base, a, input.responseTime))
          break
        case 'ssl':
          results.push(evalSsl(base, a, input.sslDaysRemaining, input.isHttps))
          break
        case 'body':
          results.push(evalBody(base, a, input.body))
          break
        case 'header':
          results.push(evalHeader(base, a, input.headers))
          break
        case 'json': {
          if (cachedJson === UNPARSED) {
            if (input.body === null) {
              cachedJson = null
              jsonParseError = 'No response body to parse'
            } else {
              try {
                cachedJson = JSON.parse(input.body)
              } catch (e) {
                cachedJson = null
                jsonParseError = `Body is not valid JSON: ${(e as Error).message}`
              }
            }
          }
          results.push(evalJson(base, a, cachedJson, jsonParseError))
          break
        }
      }
    } catch (e) {
      results.push({ ...base, passed: false, error: (e as Error).message })
    }
  }

  return {
    passed: results.every((r) => r.passed),
    failedSeverity: worstFailedSeverity(results),
    results,
  }
}

// ---------------------------------------------------------------------------
// Per-kind evaluators
// ---------------------------------------------------------------------------

function evalLatency(base: AssertionResult, a: Assertion, ms: number): AssertionResult {
  const target = toNumber(a.value)
  if (target === null) return { ...base, passed: false, actual: ms, error: 'Value is not a number' }
  return { ...base, passed: compareNumber(a.operator, ms, target), actual: ms }
}

function evalSsl(
  base: AssertionResult,
  a: Assertion,
  days: number | null,
  isHttps: boolean,
): AssertionResult {
  if (days === null) {
    // Two distinct causes land here — surface the one that actually applies so
    // the user knows where to look (endpoint config vs global module flag).
    const error = isHttps
      ? 'SSL data not captured — enable sslChecks in watchdeck.config.js'
      : 'Endpoint is HTTP — SSL assertions require HTTPS'
    return { ...base, passed: false, error }
  }
  const target = toNumber(a.value)
  if (target === null) return { ...base, passed: false, actual: days, error: 'Value is not a number' }
  return { ...base, passed: compareNumber(a.operator, days, target), actual: days }
}

function evalBody(
  base: AssertionResult,
  a: Assertion,
  body: string | null,
): AssertionResult {
  if (body === null) return { ...base, passed: false, error: 'Response body not captured' }
  const value = a.value ?? ''
  switch (a.operator) {
    case 'contains':
      return { ...base, passed: body.includes(value) }
    case 'not_contains':
      return { ...base, passed: !body.includes(value) }
    case 'equals':
      return { ...base, passed: body === value }
    default:
      return { ...base, passed: false, error: `Unsupported operator for body: ${a.operator}` }
  }
}

function evalHeader(
  base: AssertionResult,
  a: Assertion,
  headers: Record<string, string> | null,
): AssertionResult {
  if (headers === null) return { ...base, passed: false, error: 'Response headers not captured' }
  const name = (a.target ?? '').toLowerCase().trim()
  if (!name) return { ...base, passed: false, error: 'Header name is required' }
  const actual = headers[name]
  const present = actual !== undefined
  const value = a.value ?? ''

  switch (a.operator) {
    case 'exists':
      return { ...base, passed: present, actual }
    case 'not_exists':
      return { ...base, passed: !present, actual }
    case 'equals':
      return { ...base, passed: present && actual === value, actual }
    case 'contains':
      return { ...base, passed: present && actual.includes(value), actual }
    default:
      return { ...base, passed: false, actual, error: `Unsupported operator for header: ${a.operator}` }
  }
}

function evalJson(
  base: AssertionResult,
  a: Assertion,
  parsed: unknown,
  parseError: string | null,
): AssertionResult {
  if (parseError) return { ...base, passed: false, error: parseError }
  const path = normalisePath(a.target ?? '')
  if (path === null) return { ...base, passed: false, error: 'JSON path is required' }

  const { found, value: actual } = resolveDottedPath(parsed, path)

  switch (a.operator) {
    case 'exists':
      return { ...base, passed: found, actual }
    case 'not_exists':
      return { ...base, passed: !found, actual }
    case 'contains': {
      if (!found) return { ...base, passed: false, actual, error: 'Path not found' }
      if (typeof actual !== 'string') {
        return { ...base, passed: false, actual, error: 'contains operator requires a string value at the path' }
      }
      return { ...base, passed: actual.includes(a.value ?? ''), actual }
    }
    case 'eq':
    case 'neq': {
      if (!found) return { ...base, passed: a.operator === 'neq', actual, error: a.operator === 'eq' ? 'Path not found' : undefined }
      const passed = a.operator === 'eq' ? jsonEq(actual, a.value ?? '') : !jsonEq(actual, a.value ?? '')
      return { ...base, passed, actual }
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (!found) return { ...base, passed: false, actual, error: 'Path not found' }
      const actualNum = toNumber(actual)
      const target = toNumber(a.value)
      if (actualNum === null || target === null) {
        return {
          ...base,
          passed: false,
          actual,
          error: `Numeric comparison requires number values (got actual=${typeof actual})`,
        }
      }
      return { ...base, passed: compareNumber(a.operator, actualNum, target), actual: actualNum }
    }
    default:
      return { ...base, passed: false, actual, error: `Unsupported operator for json: ${a.operator}` }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNPARSED = Symbol('unparsed')

function baseResult(index: number, a: Assertion): AssertionResult {
  return {
    index,
    kind: a.kind,
    operator: a.operator,
    target: a.target,
    value: a.value,
    severity: a.severity,
    passed: false,
  }
}

function worstFailedSeverity(results: AssertionResult[]): AssertionSeverity | null {
  let hasDegraded = false
  for (const r of results) {
    if (r.passed) continue
    if (r.severity === 'down') return 'down'
    if (r.severity === 'degraded') hasDegraded = true
  }
  return hasDegraded ? 'degraded' : null
}

function compareNumber(op: AssertionOperator, actual: number, target: number): boolean {
  switch (op) {
    case 'lt': return actual < target
    case 'lte': return actual <= target
    case 'gt': return actual > target
    case 'gte': return actual >= target
    case 'eq': return actual === target
    case 'neq': return actual !== target
    default: return false
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Loose equality for JSON path `eq` / `neq`. User supplies `value` as a string
 * (that's the UI shape), so we compare stringified actual ≡ user string with
 * a couple of obvious coercions: numbers compare numerically when the user
 * typed a number, and `true`/`false`/`null` match their literals.
 */
function jsonEq(actual: unknown, userValue: string): boolean {
  if (typeof actual === 'string') return actual === userValue
  if (typeof actual === 'number') {
    const n = toNumber(userValue)
    return n !== null && actual === n
  }
  if (typeof actual === 'boolean') return String(actual) === userValue.toLowerCase()
  if (actual === null) return userValue.toLowerCase() === 'null'
  // Objects / arrays: stringify for loose equality
  try {
    return JSON.stringify(actual) === userValue
  } catch {
    return false
  }
}

/**
 * Strip a leading `$` or `$.` so `$.data.status` and `data.status` both work.
 * Returns null when the path is empty or contains only `$`.
 */
function normalisePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '$') return null
  if (trimmed.startsWith('$.')) return trimmed.slice(2)
  if (trimmed.startsWith('$')) return trimmed.slice(1)
  return trimmed
}

/**
 * Walks `obj` by the dotted path. Numeric segments index into arrays. Returns
 * `{ found: false }` if the path breaks anywhere (undefined key, non-object
 * parent, out-of-range index), otherwise `{ found: true, value }`.
 */
function resolveDottedPath(
  obj: unknown,
  path: string,
): { found: boolean; value: unknown } {
  const NOT_FOUND = { found: false, value: undefined }
  const segments = path.split('.')

  let cursor: unknown = obj
  for (const segment of segments) {
    // null / undefined has no properties — the walk broke above this segment.
    if (cursor === null || cursor === undefined) {
      return NOT_FOUND
    }

    // Array: segment must parse as an in-range integer index.
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      const inRange = Number.isInteger(index) && index >= 0 && index < cursor.length
      if (!inRange) return NOT_FOUND
      cursor = cursor[index]
      continue
    }

    // Primitives (string / number / boolean) can't be stepped into.
    if (typeof cursor !== 'object') {
      return NOT_FOUND
    }

    // Plain object: segment must name an existing key.
    const record = cursor as Record<string, unknown>
    if (!(segment in record)) return NOT_FOUND
    cursor = record[segment]
  }

  return { found: true, value: cursor }
}
