/**
 * Settings routes (auth required).
 *
 * GET  /settings                — raw mx_settings doc (override layer only)
 * PUT  /settings                — update raw mx_settings doc
 * GET  /settings/defaults       — effective per-endpoint defaults (config + override)
 * PUT  /settings/defaults       — write an override for per-endpoint defaults
 * GET  /settings/slo            — effective SLO (config + override)
 * PUT  /settings/slo            — write an override for the global SLO
 * GET  /settings/retention      — read-only view of ctx.config.retention
 * GET  /settings/aggregation    — read-only view of ctx.config.aggregation
 * GET  /modules                 — read-only view of ctx.config.modules
 * GET  /slo                     — effective SLO (kept for the KPI card hook)
 * GET  /runtime                 — read-only process-constant runtime values
 * GET  /endpoints/:id/settings  — per-endpoint config overrides
 * PUT  /endpoints/:id/settings  — update per-endpoint overrides
 * POST /admin/reset             — wipe all mx_ collections and in-memory state
 */

import type { FastifyInstance } from 'fastify'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eventBus } from '../../core/eventBus.js'
import { formatError } from '../../utils/errors.js'
import type { AppContext } from '../server.js'
import type { EndpointDoc } from '../../storage/types.js'
import { mutableFieldProps } from './endpoints.js'

/** Endpoint fields that can be overridden per-endpoint via the settings API. */
const OVERRIDABLE_FIELDS = [
  'checkInterval',
  'timeout',
  'latencyThreshold',
  'sslWarningDays',
  'failureThreshold',
  'recoveryThreshold',
  'alertCooldown',
  'recoveryAlert',
  'escalationDelay',
  'escalationChannelId',
  'notificationChannelIds',
  'assertions',
] as const

// Narrow the shared mutable-field schema down to the fields this route accepts,
// so range enforcement matches PUT /endpoints/:id exactly.
const settingsBodyProps = Object.fromEntries(
  OVERRIDABLE_FIELDS.map((f) => [f, mutableFieldProps[f]]),
) as { [K in (typeof OVERRIDABLE_FIELDS)[number]]: (typeof mutableFieldProps)[K] }

const settingsBodySchema = {
  type: 'object',
  properties: settingsBodyProps,
  additionalProperties: false,
} as const

// Fields accepted by PUT /settings/defaults — subset of mutableFieldProps,
// minus the per-endpoint-only fields (escalationChannelId, channel lists, assertions).
const DEFAULTS_OVERRIDE_FIELDS = [
  'checkInterval',
  'timeout',
  'latencyThreshold',
  'sslWarningDays',
  'failureThreshold',
  'recoveryThreshold',
  'alertCooldown',
  'recoveryAlert',
  'escalationDelay',
] as const

const defaultsOverrideBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      DEFAULTS_OVERRIDE_FIELDS.map((f) => [f, mutableFieldProps[f]]),
    ),
    // expectedStatusCodes is accepted on create but not in mutableFieldProps's
    // numeric-range set — reuse the HTTP create schema entry.
    expectedStatusCodes: mutableFieldProps.expectedStatusCodes,
  },
} as const

const sloOverrideBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'number', minimum: 90, maximum: 99.999 },
    windowDays: { type: 'integer', enum: [7, 14, 30, 60, 90] },
  },
} as const

const adminResetBodySchema = {
  type: 'object',
  required: ['confirm'],
  additionalProperties: false,
  properties: {
    confirm: { type: 'string', const: 'RESET EVERYTHING' },
  },
} as const

export function settingsRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── Global settings ───────────────────────────────────────────────────────

    fastify.get('/settings', async (_request, reply) => {
      const settings = await ctx.adapter.getSettings()
      return reply.send({ data: settings })
    })

    // ── Module toggles (read-only view of ctx.config.modules) ────────────────
    // The dashboard uses this to disable channel types / transports whose
    // backing module is off. Changing module state still requires editing
    // watchdeck.config.js and restarting.
    fastify.get('/modules', async (_request, reply) => {
      return reply.send({ data: ctx.config.modules })
    })

    // ── Effective SLO (config + mx_settings.slo override) ────────────────────
    // Drives the "SLO burn rate" KPI card on the endpoint detail page and the
    // Settings page's SLO section.
    fastify.get('/slo', async (_request, reply) => {
      const slo = await ctx.adapter.getEffectiveSlo(ctx.config)
      return reply.send({ data: slo })
    })

    // ── Runtime info (read-only view of static server-side runtime values) ──
    // Used by the dashboard for fields that are constant for the process
    // lifetime — currently the probe name shown on every check row.
    fastify.get('/runtime', async (_request, reply) => {
      return reply.send({ data: { probeName: ctx.config.probeName } })
    })

    // ── Settings sub-routes used by the global Settings page ─────────────────

    fastify.get('/settings/defaults', async (_request, reply) => {
      const data = await ctx.adapter.getEffectiveDefaults(ctx.config)
      return reply.send({ data })
    })

    fastify.put(
      '/settings/defaults',
      { schema: { body: defaultsOverrideBodySchema } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>
        // Only keep the known keys; never let arbitrary values leak into mx_settings.
        const override: Record<string, unknown> = {}
        for (const field of [...DEFAULTS_OVERRIDE_FIELDS, 'expectedStatusCodes'] as const) {
          if (field in body) override[field] = body[field]
        }
        await ctx.adapter.updateSettings({ defaults: override })
        const data = await ctx.adapter.getEffectiveDefaults(ctx.config)
        return reply.send({ data })
      },
    )

    fastify.get('/settings/slo', async (_request, reply) => {
      const data = await ctx.adapter.getEffectiveSlo(ctx.config)
      return reply.send({ data })
    })

    fastify.put(
      '/settings/slo',
      { schema: { body: sloOverrideBodySchema } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown>
        const override: Record<string, unknown> = {}
        if ('target' in body) override.target = body.target
        if ('windowDays' in body) override.windowDays = body.windowDays
        await ctx.adapter.updateSettings({ slo: override })
        const data = await ctx.adapter.getEffectiveSlo(ctx.config)
        return reply.send({ data })
      },
    )

    fastify.get('/settings/retention', async (_request, reply) => {
      return reply.send({ data: ctx.config.retention })
    })

    fastify.get('/settings/aggregation', async (_request, reply) => {
      return reply.send({ data: ctx.config.aggregation })
    })

    fastify.put('/settings', async (request, reply) => {
      const body = request.body as Record<string, unknown>
      const { _id: _d, ...changes } = body
      const updated = await ctx.adapter.updateSettings(changes)
      return reply.send({ data: updated })
    })

    // ── POST /admin/reset — hard reset ──────────────────────────────────────
    // Nukes every mx_ collection (deleteMany, preserves indexes), the disk
    // buffer file, and in-memory state that'd otherwise hold stale references
    // to wiped rows. Requires the literal phrase `RESET EVERYTHING` in the body.
    // Config file is untouched — users don't need to re-run init.
    fastify.post(
      '/admin/reset',
      { schema: { body: adminResetBodySchema } },
      async (_request, reply) => {
        // 1. Stop the dispatcher so its in-memory cooldown / dedup / coalescing
        //    trackers don't hold references to ids we're about to delete.
        if (ctx.notifications) {
          ctx.notifications.stop()
        }

        // 2. Wipe every mx_ collection.
        const cleared = await ctx.adapter.hardReset()

        // 3. Clear the disk-buffer file so a subsequent reconnect doesn't
        //    replay checks for endpoints that no longer exist.
        const diskBufferPath = path.join(os.homedir(), '.watchdeck', 'buffer.jsonl')
        try {
          await fs.rm(diskBufferPath, { force: true })
        } catch {
          // Best-effort — absence is fine.
        }

        // 4. Clear the in-memory event history so newly connected SSE clients
        //    don't replay events about the now-deleted endpoints.
        eventBus.clearHistory()

        // 5. Reset the scheduler: stop the tick loop, detach subscriptions,
        //    clear heap + failure counts, and re-init (which re-subscribes
        //    and reloads the now-empty endpoint list).
        await ctx.scheduler.reset()

        // 6. Restart the dispatcher so alerts can resume as new endpoints are
        //    created.
        if (ctx.notifications) {
          await ctx.notifications.start()
        }

        // 7. Announce the reset so every connected dashboard reloads. Emitted
        //    last so clients only see the event after the server is back in a
        //    clean, ready-to-use state.
        eventBus.emit('system:reset', { timestamp: new Date(), cleared })

        return reply.send({ data: { cleared } })
      },
    )

    // ── Per-endpoint settings ─────────────────────────────────────────────────

    fastify.get('/endpoints/:id/settings', async (request, reply) => {
      const { id } = request.params as { id: string }
      const endpoint = await ctx.adapter.getEndpointById(id)
      if (!endpoint) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }
      // Return only the overridable fields
      const overrides: Record<string, unknown> = {}
      for (const field of OVERRIDABLE_FIELDS) {
        if (endpoint[field] !== undefined) overrides[field] = endpoint[field]
      }
      return reply.send({ data: overrides })
    })

    fastify.put('/endpoints/:id/settings', { schema: { body: settingsBodySchema } }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const existing = await ctx.adapter.getEndpointById(id)
      if (!existing) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      const body = request.body as Record<string, unknown>
      // Only allow overridable fields
      const changes: Record<string, unknown> = {}
      for (const field of OVERRIDABLE_FIELDS) {
        if (field in body) changes[field] = body[field]
      }

      if (Object.keys(changes).length === 0) {
        return reply.code(422).send(
          formatError('VALIDATION_ERROR', 'No overridable fields found in request body'),
        )
      }

      if (Array.isArray(changes.notificationChannelIds)) {
        changes.notificationChannelIds = (changes.notificationChannelIds as unknown[])
          .filter((v): v is string => typeof v === 'string')
      }

      const updated = await ctx.adapter.updateEndpoint(id, changes as Partial<EndpointDoc>)
      if (!updated) {
        return reply.code(404).send(formatError('NOT_FOUND', `Endpoint ${id} not found`))
      }

      eventBus.emit('endpoint:updated', {
        timestamp: new Date(),
        endpointId: id,
        changes: changes as Partial<EndpointDoc>,
      })

      return reply.send({ data: updated })
    })
  }
}
