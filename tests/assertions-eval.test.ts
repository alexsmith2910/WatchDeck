/**
 * Assertion evaluator tests — pure logic, no DB or network.
 * Run: npx tsx tests/assertions-eval.test.ts
 */

import { evaluateAssertions } from '../src/checks/evaluators/assertionsEval.js'
import type { Assertion, AssertionEvalInput } from '../src/checks/evaluators/assertionsEval.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`)
    passed++
  } else {
    console.log(`  ✗  ${label}${detail ? `  →  ${detail}` : ''}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`)
}

function baseInput(overrides: Partial<AssertionEvalInput> = {}): AssertionEvalInput {
  return {
    assertions: [],
    body: null,
    headers: null,
    responseTime: 0,
    sslDaysRemaining: null,
    isHttps: true,
    ...overrides,
  }
}

function a(
  kind: Assertion['kind'],
  operator: Assertion['operator'],
  overrides: Partial<Assertion> = {},
): Assertion {
  return { kind, operator, severity: 'down', ...overrides }
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

section('Latency')
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('latency', 'lt', { value: '500' })],
      responseTime: 120,
    }),
  )
  assert(r.passed && r.results[0].passed, 'latency 120ms < 500ms passes')
  assert(r.results[0].actual === 120, 'actual carries measured ms')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('latency', 'lt', { value: '500', severity: 'degraded' })],
      responseTime: 800,
    }),
  )
  assert(!r.passed, 'latency 800ms < 500ms fails')
  assert(r.failedSeverity === 'degraded', 'failed severity reflects rule severity')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('latency', 'lt', { value: 'banana' })],
      responseTime: 100,
    }),
  )
  assert(!r.results[0].passed, 'non-numeric value fails')
  assert(r.results[0].error === 'Value is not a number', 'rule carries an error')
}

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------

section('SSL days')
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('ssl', 'gte', { value: '14' })],
      sslDaysRemaining: 60,
    }),
  )
  assert(r.passed, 'ssl 60d >= 14d passes')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('ssl', 'gte', { value: '30' })],
      sslDaysRemaining: null,
      isHttps: true,
    }),
  )
  assert(!r.passed, 'ssl rule fails when days not captured on https')
  assert(
    (r.results[0].error ?? '').includes('sslChecks'),
    'https case points at the module flag',
  )
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('ssl', 'gte', { value: '30' })],
      sslDaysRemaining: null,
      isHttps: false,
    }),
  )
  assert(
    (r.results[0].error ?? '').includes('HTTPS'),
    'http case points at the URL scheme',
  )
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

section('Body')
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('body', 'contains', { value: '"status":"ok"' })],
      body: '{"status":"ok","version":"1.2.3"}',
    }),
  )
  assert(r.passed, 'contains substring found')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('body', 'not_contains', { value: 'error' })],
      body: '{"status":"ok"}',
    }),
  )
  assert(r.passed, 'not_contains — substring absent')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('body', 'equals', { value: 'OK' })],
      body: 'OK',
    }),
  )
  assert(r.passed, 'equals — exact match')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('body', 'contains', { value: 'anything' })],
      body: null,
    }),
  )
  assert(!r.passed, 'missing body fails body rule')
  assert(!!r.results[0].error, 'error set when body missing')
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

section('Header')
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('header', 'exists', { target: 'x-request-id' })],
      headers: { 'x-request-id': 'abc-123' },
    }),
  )
  assert(r.passed, 'exists — header present')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('header', 'exists', { target: 'X-Request-ID' })],
      headers: { 'x-request-id': 'abc-123' },
    }),
  )
  assert(r.passed, 'exists — lookup is case-insensitive')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [
        a('header', 'contains', { target: 'content-type', value: 'json' }),
      ],
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  )
  assert(r.passed, 'contains — substring match on header value')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('header', 'not_exists', { target: 'x-debug' })],
      headers: { 'content-type': 'text/plain' },
    }),
  )
  assert(r.passed, 'not_exists — header absent')
}

// ---------------------------------------------------------------------------
// JSON path
// ---------------------------------------------------------------------------

section('JSON path')
{
  const body = JSON.stringify({ data: { status: 'ok' } })
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('json', 'eq', { target: '$.data.status', value: 'ok' })],
      body,
    }),
  )
  assert(r.passed, '$.data.status == ok')
}
{
  const body = JSON.stringify({ items: [{ name: 'alpha' }, { name: 'beta' }] })
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('json', 'eq', { target: 'items.1.name', value: 'beta' })],
      body,
    }),
  )
  assert(r.passed, 'numeric segment indexes arrays')
}
{
  const body = JSON.stringify({ count: 42 })
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('json', 'gt', { target: '$.count', value: '10' })],
      body,
    }),
  )
  assert(r.passed, 'numeric gt on json value')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('json', 'exists', { target: '$.missing' })],
      body: '{"present":true}',
    }),
  )
  assert(!r.passed, 'exists — missing path fails')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [a('json', 'eq', { target: '$.x', value: 'y' })],
      body: 'not-json',
    }),
  )
  assert(!r.results[0].passed && !!r.results[0].error, 'non-JSON body errors cleanly')
}

// ---------------------------------------------------------------------------
// Composite — severity worstOf
// ---------------------------------------------------------------------------

section('Composite')
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [
        a('latency', 'lt', { value: '100', severity: 'degraded' }), // fails
        a('body', 'contains', { value: 'ok' }), // passes → severity 'down' but pass
      ],
      responseTime: 500,
      body: '{"status":"ok"}',
    }),
  )
  assert(!r.passed, 'any failure flips composite passed')
  assert(r.failedSeverity === 'degraded', 'only degraded-sev fail → failedSeverity=degraded')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [
        a('latency', 'lt', { value: '100', severity: 'degraded' }), // fails
        a('body', 'contains', { value: 'ok', severity: 'down' }), // also fails
      ],
      responseTime: 500,
      body: 'nope',
    }),
  )
  assert(r.failedSeverity === 'down', 'down-sev failure beats degraded-sev failure')
}
{
  const r = evaluateAssertions(
    baseInput({
      assertions: [
        a('latency', 'lt', { value: '1000' }),
        a('body', 'contains', { value: 'ok' }),
      ],
      responseTime: 200,
      body: '{"status":"ok"}',
    }),
  )
  assert(r.passed, 'all rules pass → composite passed')
  assert(r.failedSeverity === null, 'failedSeverity is null when all pass')
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n── Summary\n  ${passed} passed · ${failed} failed`)
if (failed > 0) process.exit(1)
