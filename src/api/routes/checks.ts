/**
 * Check history routes (auth required).
 *
 * GET /endpoints/:id/checks  — paginated raw check results
 * GET /endpoints/:id/hourly  — hourly summaries (includes partial current hour)
 * GET /endpoints/:id/daily   — daily summaries (includes partial today)
 * GET /endpoints/:id/uptime  — 24h/7d/30d/90d uptime percentages
 */

import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { formatError } from '../../utils/errors.js'
import { parsePagination, toEnvelope } from '../utils/pagination.js'
import { buildHourlySummary } from '../../aggregation/detailedToHourly.js'
import { buildDailySummary } from '../../aggregation/hourlyToDaily.js'
import type { AppContext } from '../server.js'

/** Truncate a Date to the start of its UTC hour */
function truncateToHour(d: Date): Date {
  const t = new Date(d)
  t.setUTCMinutes(0, 0, 0)
  return t
}

/** Truncate a Date to midnight UTC */
function truncateToDay(d: Date): Date {
  const t = new Date(d)
  t.setUTCHours(0, 0, 0, 0)
  return t
}

export function checksRoutes(ctx: AppContext) {
  return async (fastify: FastifyInstance): Promise<void> => {

    // ── GET /endpoints/:id/checks ────────────────────────────────────────────
    fastify.get('/endpoints/:id/checks', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const query = request.query as {
        cursor?: string
        limit?: string
        from?: string
        to?: string
        status?: 'healthy' | 'degraded' | 'down'
      }
      const pagination = parsePagination(query)
      const page = await ctx.adapter.listChecks(id, {
        ...pagination,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        status: query.status,
      })
      return reply.send(toEnvelope(page, pagination.limit ?? 20))
    })

    // ── GET /endpoints/:id/hourly ────────────────────────────────────────────
    // Returns completed hourly summaries + a partial summary for the current
    // in-progress hour (computed on-the-fly from raw checks).
    fastify.get('/endpoints/:id/hourly', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const query = request.query as { limit?: string }
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 48, 1000) : 48

      const now = new Date()
      const currentHourStart = truncateToHour(now)

      // Fetch completed summaries and current-hour raw checks in parallel
      const [summaries, currentHourChecks] = await Promise.all([
        ctx.adapter.listHourlySummaries(id, { limit }),
        ctx.adapter.getChecksInHour(id, currentHourStart, now),
      ])

      // Build a partial summary for the current hour if there are any checks
      if (currentHourChecks.length > 0) {
        const partial = buildHourlySummary(id, currentHourStart, currentHourChecks)
        // The completed summaries are sorted descending by hour.
        // Check if the first summary is already for the current hour (in case
        // aggregation just ran) — if so, replace it with the fresher partial.
        if (
          summaries.length > 0 &&
          summaries[0].hour.getTime() === currentHourStart.getTime()
        ) {
          summaries[0] = { ...partial, _id: summaries[0]._id, createdAt: summaries[0].createdAt }
        } else {
          // Prepend partial as the newest entry (assign a temporary _id)
          summaries.unshift({
            ...partial,
            _id: new ObjectId(),
            createdAt: now,
          } as typeof summaries[0])
        }
      }

      return reply.send({ data: summaries })
    })

    // ── GET /endpoints/:id/daily ─────────────────────────────────────────────
    // Returns completed daily summaries + a partial summary for today
    // (computed on-the-fly from today's hourly summaries + current hour).
    fastify.get('/endpoints/:id/daily', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const query = request.query as { limit?: string }
      const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 90, 365) : 90

      const now = new Date()
      const todayStart = truncateToDay(now)
      const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
      const currentHourStart = truncateToHour(now)

      // Fetch daily summaries, the last 48 hourly summaries (covers both
      // yesterday + today comfortably), and current-hour checks in parallel.
      const [dailies, recentHourlies, currentHourChecks] = await Promise.all([
        ctx.adapter.listDailySummaries(id, { limit }),
        ctx.adapter.listHourlySummaries(id, { limit: 48 }),
        ctx.adapter.getChecksInHour(id, currentHourStart, now),
      ])

      // Filter hourly summaries to only today's completed hours
      const todayCompletedHourlies = recentHourlies.filter(
        (h) => h.hour.getTime() >= todayStart.getTime() && h.hour.getTime() < currentHourStart.getTime(),
      )

      // Build partial current hour if any checks exist
      if (currentHourChecks.length > 0) {
        const partialHour = buildHourlySummary(id, currentHourStart, currentHourChecks)
        todayCompletedHourlies.push({
          ...partialHour,
          _id: new ObjectId(),
          createdAt: now,
        } as typeof todayCompletedHourlies[0])
      }

      // Build today's partial daily summary from its hourly components
      if (todayCompletedHourlies.length > 0) {
        const partialDay = buildDailySummary(id, todayStart, todayCompletedHourlies)

        // Replace or prepend
        if (
          dailies.length > 0 &&
          dailies[0].date.getTime() === todayStart.getTime()
        ) {
          dailies[0] = { ...partialDay, _id: dailies[0]._id, createdAt: dailies[0].createdAt }
        } else {
          dailies.unshift({
            ...partialDay,
            _id: new ObjectId(),
            createdAt: now,
          } as typeof dailies[0])
        }
      }

      // Fallback for the 00:00–03:00 UTC window: the daily rollup runs at
      // 03:00 UTC for the prior UTC day, so yesterday can be "complete but
      // not yet stored". Synthesise it from yesterday's hourly summaries.
      const hasYesterday = dailies.some(
        (d) => d.date.getTime() === yesterdayStart.getTime(),
      )
      if (!hasYesterday) {
        const yesterdayHourlies = recentHourlies.filter(
          (h) => h.hour.getTime() >= yesterdayStart.getTime() && h.hour.getTime() < todayStart.getTime(),
        )
        if (yesterdayHourlies.length > 0) {
          const partialDay = buildDailySummary(id, yesterdayStart, yesterdayHourlies)
          const synthEntry = {
            ...partialDay,
            _id: new ObjectId(),
            createdAt: now,
          } as typeof dailies[0]
          // Insert in date-desc order: after any entries newer than yesterday.
          const insertAt = dailies.findIndex((d) => d.date.getTime() < yesterdayStart.getTime())
          if (insertAt === -1) dailies.push(synthEntry)
          else dailies.splice(insertAt, 0, synthEntry)
        }
      }

      return reply.send({ data: dailies })
    })

    // ── GET /endpoints/:id/uptime ────────────────────────────────────────────
    fastify.get('/endpoints/:id/uptime', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!ObjectId.isValid(id)) {
        return reply.code(400).send(formatError('INVALID_ID', 'Endpoint ID is not a valid ObjectId'))
      }

      const stats = await ctx.adapter.getUptimeStats(id)
      return reply.send({ data: stats })
    })
  }
}
