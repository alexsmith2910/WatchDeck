import { MongoClient, ObjectId, type Db } from 'mongodb'
import { eventBus } from '../core/eventBus.js'
import type { WatchDeckConfig } from '../config/types.js'
import { StorageAdapter, type HealthCheckResult } from './adapter.js'
import { runMigrations } from './migrations.js'
import type {
  CheckDoc,
  CheckWritePayload,
  DailySummaryDoc,
  DbPage,
  DbPaginationOpts,
  EndpointDoc,
  HourlySummaryDoc,
  IncidentDoc,
  MaintenanceWindow,
  NotificationChannelDoc,
  NotificationLogDoc,
  SettingsDoc,
  SystemEventDoc,
} from './types.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * MongoDB implementation of StorageAdapter.
 *
 * Boot strategy  : 3 connection attempts with 5-second gaps. Throws on total failure.
 * Runtime reconnect: exponential backoff starting at 30s, doubling up to a 5-minute cap.
 *                    Controlled by config.rateLimits.dbReconnectAttempts (0 = unlimited).
 *
 * Events emitted (via eventBus):
 *   db:connected, db:disconnected, db:reconnecting, db:reconnected, db:error, db:fatal
 */
export class MongoDBAdapter extends StorageAdapter {
  private client: MongoClient | null = null
  private db: Db | null = null
  private _connected = false
  /** Set before an intentional close to prevent the topology handler from starting a reconnect loop. */
  private _intentionalDisconnect = false
  private disconnectedAt: number | null = null

  constructor(
    private readonly uri: string,
    private readonly dbPrefix: string,
    private readonly config: WatchDeckConfig,
  ) {
    super()
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle
  // ---------------------------------------------------------------------------

  isConnected(): boolean {
    return this._connected
  }

  /**
   * Boot connection — 3 attempts with 5-second gaps.
   * Throws if all attempts fail so the process can exit.
   */
  async connect(): Promise<void> {
    const BOOT_ATTEMPTS = 3
    const BOOT_GAP_MS = 5_000
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
      try {
        await this.openConnection()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        eventBus.emit('db:error', {
          timestamp: new Date(),
          error: lastError,
          context: `boot attempt ${attempt}/${BOOT_ATTEMPTS}`,
        })
        if (attempt < BOOT_ATTEMPTS) {
          await sleep(BOOT_GAP_MS)
        }
      }
    }

    throw lastError ?? new Error('MongoDB connection failed after 3 attempts')
  }

  async disconnect(): Promise<void> {
    this._intentionalDisconnect = true
    this._connected = false
    await this.closeClient()
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.db || !this._connected) {
      return { status: 'down', latencyMs: 0 }
    }
    try {
      const start = Date.now()
      await this.db.command({ ping: 1 })
      const latencyMs = Date.now() - start
      return {
        status: latencyMs > 2_000 ? 'degraded' : 'healthy',
        latencyMs,
      }
    } catch {
      return { status: 'down', latencyMs: 0 }
    }
  }

  async migrate(): Promise<void> {
    if (!this.db) throw new Error('Cannot run migrations: not connected to MongoDB')
    await runMigrations(
      this.db,
      this.dbPrefix,
      this.config.retention.detailedDays,
    )
  }

  // ---------------------------------------------------------------------------
  // Internal connection logic
  // ---------------------------------------------------------------------------

  /**
   * Open a single connection attempt.
   * Replaces any existing client, registers the topology disconnect handler,
   * and emits db:connected on success.
   */
  private async openConnection(): Promise<void> {
    const start = Date.now()

    const client = new MongoClient(this.uri, {
      maxPoolSize: this.config.rateLimits.dbPoolSize,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    })

    await client.connect()

    // Verify with a ping before declaring success.
    const db = client.db()
    await db.command({ ping: 1 })
    const latencyMs = Date.now() - start

    // Clean up the previous client BEFORE marking as connected.
    await this.closeClient()

    this.client = client
    this.db = db
    this._connected = true
    this.disconnectedAt = null

    this.registerTopologyHandler(client)

    eventBus.emit('db:connected', { timestamp: new Date(), latencyMs })
  }

  /**
   * Listen for unexpected topology closure and start the reconnect loop.
   * Removing all listeners first prevents duplicate handlers when called
   * during a reconnect cycle.
   */
  private registerTopologyHandler(client: MongoClient): void {
    client.once('topologyClosed', () => {
      // Guard: intentional close or we're already handling a disconnect.
      if (this._intentionalDisconnect || !this._connected) return

      this._connected = false
      this.disconnectedAt = Date.now()

      eventBus.emit('db:disconnected', {
        timestamp: new Date(),
        error: 'MongoDB topology closed unexpectedly',
      })

      void this.reconnectLoop()
    })
  }

  /**
   * Runtime reconnection with exponential backoff (30s → 5min cap).
   * Stops when:
   *  - A connection attempt succeeds (emits db:reconnected)
   *  - Max attempts are exhausted (emits db:fatal)
   *  - disconnect() was called (intentionalDisconnect flag)
   */
  private async reconnectLoop(): Promise<void> {
    const { dbReconnectAttempts } = this.config.rateLimits
    const unlimited = dbReconnectAttempts === 0
    const outageStart = this.disconnectedAt ?? Date.now()

    let attempt = 0
    let delay = 30_000
    const MAX_DELAY = 300_000 // 5 minutes

    while (!this._intentionalDisconnect && (unlimited || attempt < dbReconnectAttempts)) {
      attempt++

      eventBus.emit('db:reconnecting', {
        timestamp: new Date(),
        attempt,
        maxAttempts: dbReconnectAttempts,
        nextRetryInSeconds: delay / 1000,
      })

      await sleep(delay)
      delay = Math.min(delay * 2, MAX_DELAY)

      if (this._intentionalDisconnect) break

      try {
        await this.openConnection()
        const outageDurationSeconds = Math.round((Date.now() - outageStart) / 1000)
        eventBus.emit('db:reconnected', {
          timestamp: new Date(),
          outageDurationSeconds,
          // Buffer pipeline will update bufferedResults via its own subscriber.
          bufferedResults: 0,
        })
        return
      } catch (err) {
        eventBus.emit('db:error', {
          timestamp: new Date(),
          error: err instanceof Error ? err : new Error(String(err)),
          context: `reconnect attempt ${attempt}`,
        })
      }
    }

    if (!this._intentionalDisconnect) {
      const outageDurationSeconds = Math.round((Date.now() - outageStart) / 1000)
      eventBus.emit('db:fatal', {
        timestamp: new Date(),
        totalAttempts: attempt,
        totalOutageDuration: outageDurationSeconds,
      })
    }
  }

  /**
   * Close and discard the current MongoClient.
   * Removes all listeners first so topology events from the closing client
   * don't trigger another reconnect cycle.
   */
  private async closeClient(): Promise<void> {
    if (this.client) {
      this.client.removeAllListeners()
      try {
        await this.client.close()
      } catch {
        // Ignore errors during close — the client may already be broken.
      }
      this.client = null
      this.db = null
    }
  }

  // ---------------------------------------------------------------------------
  // Buffer pipeline
  // ---------------------------------------------------------------------------

  async saveCheck(payload: CheckWritePayload): Promise<void> {
    const db = this.getDb()
    const doc: CheckDoc = {
      _id: new ObjectId(),
      endpointId: new ObjectId(payload.endpointId),
      timestamp: payload.timestamp instanceof Date ? payload.timestamp : new Date(payload.timestamp),
      responseTime: payload.responseTime,
      status: payload.status,
      duringMaintenance: false,
      createdAt: new Date(),
    }
    if (payload.statusCode !== null) doc.statusCode = payload.statusCode
    if (payload.errorMessage !== null) doc.errorMessage = payload.errorMessage
    await db.collection<CheckDoc>(`${this.dbPrefix}checks`).insertOne(doc)
  }

  async saveManyChecks(payloads: CheckWritePayload[]): Promise<void> {
    if (payloads.length === 0) return
    const db = this.getDb()
    const docs: CheckDoc[] = payloads.map((p) => {
      const doc: CheckDoc = {
        _id: new ObjectId(),
        endpointId: new ObjectId(p.endpointId),
        timestamp: p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp),
        responseTime: p.responseTime,
        status: p.status,
        duringMaintenance: false,
        createdAt: new Date(),
      }
      if (p.statusCode !== null) doc.statusCode = p.statusCode
      if (p.errorMessage !== null) doc.errorMessage = p.errorMessage
      return doc
    })
    await db.collection<CheckDoc>(`${this.dbPrefix}checks`).insertMany(docs)
  }

  // ---------------------------------------------------------------------------
  // System events
  // ---------------------------------------------------------------------------

  async saveSystemEvent(event: Omit<SystemEventDoc, '_id'>): Promise<void> {
    const db = this.getDb()
    await db
      .collection<SystemEventDoc>(`${this.dbPrefix}system_events`)
      .insertOne({ _id: new ObjectId(), ...event })
  }

  async getSystemEvents(limit = 50): Promise<SystemEventDoc[]> {
    if (!this.db) return []
    return this.db
      .collection<SystemEventDoc>(`${this.dbPrefix}system_events`)
      .find()
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray()
  }

  // ---------------------------------------------------------------------------
  // Check engine
  // ---------------------------------------------------------------------------

  async listEnabledEndpoints(): Promise<EndpointDoc[]> {
    if (!this.db) return []
    return this.db
      .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
      .find({ status: { $in: ['active', 'paused'] } })
      .toArray()
  }

  async updateEndpointAfterCheck(
    endpointId: string,
    status: 'healthy' | 'degraded' | 'down',
    timestamp: Date,
    consecutiveFailures: number,
    responseTime: number,
    statusCode: number | null,
    errorMessage: string | null,
  ): Promise<void> {
    const db = this.getDb()
    await db.collection<EndpointDoc>(`${this.dbPrefix}endpoints`).updateOne(
      { _id: new ObjectId(endpointId) },
      {
        $set: {
          lastCheckAt: timestamp,
          lastStatus: status,
          lastResponseTime: responseTime,
          lastStatusCode: statusCode,
          lastErrorMessage: errorMessage,
          consecutiveFailures,
          updatedAt: new Date(),
        },
      },
    )
  }

  // ---------------------------------------------------------------------------
  // Endpoints API
  // ---------------------------------------------------------------------------

  async createEndpoint(
    data: Omit<EndpointDoc, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<EndpointDoc> {
    const db = this.getDb()
    const now = new Date()
    const doc: EndpointDoc = { ...data, _id: new ObjectId(), createdAt: now, updatedAt: now }
    await db.collection<EndpointDoc>(`${this.dbPrefix}endpoints`).insertOne(doc)
    return doc
  }

  async getEndpointById(id: string): Promise<EndpointDoc | null> {
    if (!this.db) return null
    try {
      return await this.db
        .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
        .findOne({ _id: new ObjectId(id) })
    } catch {
      return null
    }
  }

  async listEndpoints(
    opts: DbPaginationOpts & { status?: 'active' | 'paused' | 'archived'; type?: 'http' | 'port' },
  ): Promise<DbPage<EndpointDoc>> {
    const filter: Record<string, unknown> = {}
    if (opts.status) {
      filter.status = opts.status
    } else {
      filter.status = { $in: ['active', 'paused'] }
    }
    if (opts.type) filter.type = opts.type
    return this.paginate<EndpointDoc>('endpoints', filter, opts, { _id: 1 })
  }

  async updateEndpoint(
    id: string,
    changes: Partial<EndpointDoc>,
  ): Promise<EndpointDoc | null> {
    const db = this.getDb()
    const { _id: _dropped, createdAt: _c, ...safe } = changes as Record<string, unknown>
    const result = await db
      .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { ...safe, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
    return result ?? null
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const db = this.getDb()
    const r = await db
      .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
      .deleteOne({ _id: new ObjectId(id) })
    return r.deletedCount > 0
  }

  async getLatestCheck(endpointId: string): Promise<CheckDoc | null> {
    if (!this.db) return null
    try {
      return await this.db
        .collection<CheckDoc>(`${this.dbPrefix}checks`)
        .findOne(
          { endpointId: new ObjectId(endpointId) },
          { sort: { timestamp: -1 } },
        )
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Checks API
  // ---------------------------------------------------------------------------

  async listChecks(
    endpointId: string,
    opts: DbPaginationOpts & { from?: Date; to?: Date; status?: 'healthy' | 'degraded' | 'down' },
  ): Promise<DbPage<CheckDoc>> {
    const filter: Record<string, unknown> = { endpointId: new ObjectId(endpointId) }
    if (opts.from || opts.to) {
      const ts: Record<string, Date> = {}
      if (opts.from) ts.$gte = opts.from
      if (opts.to) ts.$lte = opts.to
      filter.timestamp = ts
    }
    if (opts.status) filter.status = opts.status
    return this.paginate<CheckDoc>('checks', filter, opts, { _id: -1 })
  }

  async listHourlySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<HourlySummaryDoc[]> {
    if (!this.db) return []
    const limit = Math.min(opts.limit ?? 48, 200)
    return this.db
      .collection<HourlySummaryDoc>(`${this.dbPrefix}hourly_summaries`)
      .find({ endpointId: new ObjectId(endpointId) })
      .sort({ hour: -1 })
      .limit(limit)
      .toArray()
  }

  async listDailySummaries(
    endpointId: string,
    opts: DbPaginationOpts,
  ): Promise<DailySummaryDoc[]> {
    if (!this.db) return []
    const limit = Math.min(opts.limit ?? 90, 365)
    return this.db
      .collection<DailySummaryDoc>(`${this.dbPrefix}daily_summaries`)
      .find({ endpointId: new ObjectId(endpointId) })
      .sort({ date: -1 })
      .limit(limit)
      .toArray()
  }

  async getUptimeStats(
    endpointId: string,
  ): Promise<{ '24h': number | null; '7d': number | null; '30d': number | null; '90d': number | null }> {
    if (!this.db) return { '24h': null, '7d': null, '30d': null, '90d': null }

    const oid = new ObjectId(endpointId)
    const now = new Date()
    const coll = this.db.collection<CheckDoc>(`${this.dbPrefix}checks`)

    // Find the oldest check to know how far back data actually exists.
    const oldest = await coll
      .findOne({ endpointId: oid }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } })
    if (!oldest) return { '24h': null, '7d': null, '30d': null, '90d': null }

    const dataAgeMs = now.getTime() - oldest.timestamp.getTime()

    const calcUptime = async (sinceMs: number): Promise<number | null> => {
      // Only report for windows where we have data covering at least 50% of the period.
      if (dataAgeMs < sinceMs * 0.5) return null
      const since = new Date(now.getTime() - sinceMs)
      const [total, healthy] = await Promise.all([
        coll.countDocuments({ endpointId: oid, timestamp: { $gte: since } }),
        coll.countDocuments({ endpointId: oid, timestamp: { $gte: since }, status: 'healthy' }),
      ])
      if (total === 0) return null
      return Math.round((healthy / total) * 10000) / 100
    }

    const [h24, d7, d30, d90] = await Promise.all([
      calcUptime(86_400_000),
      calcUptime(7 * 86_400_000),
      calcUptime(30 * 86_400_000),
      calcUptime(90 * 86_400_000),
    ])
    return { '24h': h24, '7d': d7, '30d': d30, '90d': d90 }
  }

  // ---------------------------------------------------------------------------
  // Incidents API
  // ---------------------------------------------------------------------------

  async listIncidents(
    opts: DbPaginationOpts & {
      status?: 'active' | 'resolved'
      endpointId?: string
      from?: Date
      to?: Date
    },
  ): Promise<DbPage<IncidentDoc>> {
    const filter: Record<string, unknown> = {}
    if (opts.status) filter.status = opts.status
    if (opts.endpointId) filter.endpointId = new ObjectId(opts.endpointId)
    if (opts.from || opts.to) {
      const ts: Record<string, Date> = {}
      if (opts.from) ts.$gte = opts.from
      if (opts.to) ts.$lte = opts.to
      filter.startedAt = ts
    }
    return this.paginate<IncidentDoc>('incidents', filter, opts, { _id: -1 })
  }

  async getIncidentById(id: string): Promise<IncidentDoc | null> {
    if (!this.db) return null
    try {
      return await this.db
        .collection<IncidentDoc>(`${this.dbPrefix}incidents`)
        .findOne({ _id: new ObjectId(id) })
    } catch {
      return null
    }
  }

  async listActiveIncidents(): Promise<IncidentDoc[]> {
    if (!this.db) return []
    return this.db
      .collection<IncidentDoc>(`${this.dbPrefix}incidents`)
      .find({ status: 'active' })
      .sort({ startedAt: -1 })
      .toArray()
  }

  async createIncident(
    data: Omit<IncidentDoc, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IncidentDoc> {
    const db = this.getDb()
    const now = new Date()
    const doc: IncidentDoc = { ...data, _id: new ObjectId(), createdAt: now, updatedAt: now }
    await db.collection<IncidentDoc>(`${this.dbPrefix}incidents`).insertOne(doc)
    return doc
  }

  async resolveIncident(
    id: string,
    resolvedAt: Date,
    durationSeconds: number,
  ): Promise<IncidentDoc | null> {
    const db = this.getDb()
    const result = await db
      .collection<IncidentDoc>(`${this.dbPrefix}incidents`)
      .findOneAndUpdate(
        { _id: new ObjectId(id), status: 'active' },
        {
          $set: {
            status: 'resolved',
            resolvedAt,
            durationSeconds,
            updatedAt: new Date(),
          },
          $push: {
            timeline: { at: resolvedAt, event: 'resolved', detail: `Resolved after ${durationSeconds}s` },
          },
        },
        { returnDocument: 'after' },
      )
    return result ?? null
  }

  async addIncidentTimelineEvent(
    incidentId: string,
    event: { at: Date; event: string; detail?: string },
  ): Promise<void> {
    const db = this.getDb()
    await db.collection<IncidentDoc>(`${this.dbPrefix}incidents`).updateOne(
      { _id: new ObjectId(incidentId) },
      { $push: { timeline: event }, $set: { updatedAt: new Date() } },
    )
  }

  async setEndpointCurrentIncident(
    endpointId: string,
    incidentId: string | null,
  ): Promise<void> {
    const db = this.getDb()
    await db.collection<EndpointDoc>(`${this.dbPrefix}endpoints`).updateOne(
      { _id: new ObjectId(endpointId) },
      {
        $set: {
          currentIncidentId: incidentId ? new ObjectId(incidentId) : undefined,
          updatedAt: new Date(),
        },
      },
    )
  }

  // ---------------------------------------------------------------------------
  // Notification channels API
  // ---------------------------------------------------------------------------

  async listNotificationChannels(): Promise<NotificationChannelDoc[]> {
    if (!this.db) return []
    return this.db
      .collection<NotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .find()
      .sort({ createdAt: 1 })
      .toArray()
  }

  async createNotificationChannel(
    data: Omit<NotificationChannelDoc, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationChannelDoc> {
    const db = this.getDb()
    const now = new Date()
    const doc: NotificationChannelDoc = { ...data, _id: new ObjectId(), createdAt: now, updatedAt: now }
    await db
      .collection<NotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .insertOne(doc)
    return doc
  }

  async updateNotificationChannel(
    id: string,
    changes: Partial<NotificationChannelDoc>,
  ): Promise<NotificationChannelDoc | null> {
    const db = this.getDb()
    const { _id: _d, createdAt: _c, ...safe } = changes as Record<string, unknown>
    const result = await db
      .collection<NotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { ...safe, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
    return result ?? null
  }

  async deleteNotificationChannel(id: string): Promise<boolean> {
    const db = this.getDb()
    const r = await db
      .collection<NotificationChannelDoc>(`${this.dbPrefix}notification_channels`)
      .deleteOne({ _id: new ObjectId(id) })
    return r.deletedCount > 0
  }

  async listNotificationLog(opts: DbPaginationOpts): Promise<DbPage<NotificationLogDoc>> {
    return this.paginate<NotificationLogDoc>('notification_log', {}, opts, { _id: -1 })
  }

  // ---------------------------------------------------------------------------
  // Maintenance API
  // ---------------------------------------------------------------------------

  async addMaintenanceWindows(
    endpointIds: string[],
    windowData: Omit<MaintenanceWindow, '_id'>,
  ): Promise<MaintenanceWindow[]> {
    const db = this.getDb()
    const windows: MaintenanceWindow[] = endpointIds.map((id) => ({
      ...windowData,
      _id: new ObjectId(),
    }))

    await Promise.all(
      endpointIds.map((id, i) =>
        db
          .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
          .updateOne(
            { _id: new ObjectId(id) },
            { $push: { maintenanceWindows: windows[i]! }, $set: { updatedAt: new Date() } },
          ),
      ),
    )
    return windows
  }

  async removeMaintenanceWindow(windowId: string): Promise<boolean> {
    const db = this.getDb()
    const oid = new ObjectId(windowId)
    const r = await db
      .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
      .updateOne(
        { 'maintenanceWindows._id': oid },
        { $pull: { maintenanceWindows: { _id: oid } }, $set: { updatedAt: new Date() } },
      )
    return r.modifiedCount > 0
  }

  async listMaintenanceWindows(): Promise<
    Array<{ endpoint: EndpointDoc; window: MaintenanceWindow }>
  > {
    if (!this.db) return []
    const now = new Date()
    const endpoints = await this.db
      .collection<EndpointDoc>(`${this.dbPrefix}endpoints`)
      .find({ 'maintenanceWindows.0': { $exists: true } })
      .toArray()

    const result: Array<{ endpoint: EndpointDoc; window: MaintenanceWindow }> = []
    for (const ep of endpoints) {
      for (const w of ep.maintenanceWindows) {
        // active: now is within the window; scheduled: window hasn't started yet
        if (w.endTime >= now) {
          result.push({ endpoint: ep, window: w })
        }
      }
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // Aggregation write API
  // ---------------------------------------------------------------------------

  async getChecksInHour(endpointId: string, hourStart: Date, hourEnd: Date): Promise<CheckDoc[]> {
    if (!this.db) return []
    return this.db
      .collection<CheckDoc>(`${this.dbPrefix}checks`)
      .find({
        endpointId: new ObjectId(endpointId),
        timestamp: { $gte: hourStart, $lt: hourEnd },
      })
      .sort({ timestamp: 1 })
      .toArray()
  }

  async upsertHourlySummary(
    summary: Omit<HourlySummaryDoc, '_id' | 'createdAt'>,
  ): Promise<void> {
    const db = this.getDb()
    await db
      .collection<HourlySummaryDoc>(`${this.dbPrefix}hourly_summaries`)
      .updateOne(
        { endpointId: summary.endpointId, hour: summary.hour },
        { $set: { ...summary, createdAt: new Date() } },
        { upsert: true },
      )
  }

  async upsertDailySummary(
    summary: Omit<DailySummaryDoc, '_id' | 'createdAt'>,
  ): Promise<void> {
    const db = this.getDb()
    await db
      .collection<DailySummaryDoc>(`${this.dbPrefix}daily_summaries`)
      .updateOne(
        { endpointId: summary.endpointId, date: summary.date },
        { $set: { ...summary, createdAt: new Date() } },
        { upsert: true },
      )
  }

  async deleteHourlySummariesBefore(before: Date): Promise<number> {
    const db = this.getDb()
    const result = await db
      .collection<HourlySummaryDoc>(`${this.dbPrefix}hourly_summaries`)
      .deleteMany({ hour: { $lt: before } })
    return result.deletedCount
  }

  async deleteDailySummariesBefore(before: Date): Promise<number> {
    const db = this.getDb()
    const result = await db
      .collection<DailySummaryDoc>(`${this.dbPrefix}daily_summaries`)
      .deleteMany({ date: { $lt: before } })
    return result.deletedCount
  }

  async getEndpointIdsWithChecks(from: Date, to: Date): Promise<string[]> {
    if (!this.db) return []
    const results = await this.db
      .collection<CheckDoc>(`${this.dbPrefix}checks`)
      .distinct('endpointId', { timestamp: { $gte: from, $lt: to } })
    return results.map((id: ObjectId) => id.toHexString())
  }

  // ---------------------------------------------------------------------------
  // Settings API
  // ---------------------------------------------------------------------------

  async getSettings(): Promise<SettingsDoc> {
    const db = this.getDb()
    const existing = await db
      .collection<SettingsDoc>(`${this.dbPrefix}settings`)
      .findOne({ _id: 'global' })
    if (existing) return existing
    // Upsert empty doc on first access
    const doc: SettingsDoc = { _id: 'global' }
    await db
      .collection<SettingsDoc>(`${this.dbPrefix}settings`)
      .updateOne({ _id: 'global' }, { $setOnInsert: doc }, { upsert: true })
    return doc
  }

  async updateSettings(changes: Record<string, unknown>): Promise<SettingsDoc> {
    const db = this.getDb()
    const { _id: _d, ...safe } = changes
    const result = await db
      .collection<SettingsDoc>(`${this.dbPrefix}settings`)
      .findOneAndUpdate(
        { _id: 'global' },
        { $set: safe },
        { upsert: true, returnDocument: 'after' },
      )
    return result ?? { _id: 'global', ...safe }
  }

  // ---------------------------------------------------------------------------
  // Package-internal accessor for MongoDBAdapter subclasses / same-module code
  // ---------------------------------------------------------------------------

  /**
   * Exposes the raw Db for use within the storage layer only.
   * Throws if called before connect() succeeds.
   */
  protected getDb(): Db {
    if (!this.db) throw new Error('MongoDBAdapter.getDb() called before connect()')
    return this.db
  }

  // ---------------------------------------------------------------------------
  // Shared pagination helper
  // ---------------------------------------------------------------------------

  /**
   * Cursor-based pagination over any collection.
   * sort direction determines cursor direction: _id:1 uses $gt, _id:-1 uses $lt.
   */
  private async paginate<T extends { _id: ObjectId }>(
    collSuffix: string,
    filter: Record<string, unknown>,
    opts: DbPaginationOpts,
    sort: Record<string, 1 | -1>,
  ): Promise<DbPage<T>> {
    if (!this.db) return { items: [], total: 0, hasMore: false, nextCursor: null, prevCursor: null }

    const limit = Math.min(opts.limit ?? 20, 100)
    const coll = this.db.collection<T>(`${this.dbPrefix}${collSuffix}`)
    const sortDir = Object.values(sort)[0] ?? 1

    const q: Record<string, unknown> = { ...filter }
    if (opts.cursor) {
      try {
        q._id = sortDir === 1
          ? { $gt: new ObjectId(opts.cursor) }
          : { $lt: new ObjectId(opts.cursor) }
      } catch {
        // Invalid cursor — ignore and start from beginning
      }
    }

    const [rawItems, total] = await Promise.all([
      coll.find(q as Parameters<typeof coll.find>[0]).sort(sort).limit(limit + 1).toArray(),
      coll.countDocuments(filter as Parameters<typeof coll.countDocuments>[0]),
    ])

    const items = rawItems as unknown as T[]
    const hasMore = items.length > limit
    if (hasMore) items.pop()

    return {
      items,
      total,
      hasMore,
      nextCursor: hasMore ? items.at(-1)!._id.toHexString() : null,
      prevCursor: items.length > 0 ? items[0]!._id.toHexString() : null,
    }
  }
}
