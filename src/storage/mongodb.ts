import { MongoClient, ObjectId, type Db } from 'mongodb'
import { eventBus } from '../core/eventBus.js'
import type { WatchDeckConfig } from '../config/types.js'
import { StorageAdapter, type HealthCheckResult } from './adapter.js'
import { runMigrations } from './migrations.js'
import type { CheckDoc, CheckWritePayload, EndpointDoc, SystemEventDoc } from './types.js'

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
  ): Promise<void> {
    const db = this.getDb()
    await db.collection<EndpointDoc>(`${this.dbPrefix}endpoints`).updateOne(
      { _id: new ObjectId(endpointId) },
      {
        $set: {
          lastCheckAt: timestamp,
          lastStatus: status,
          consecutiveFailures,
          updatedAt: new Date(),
        },
      },
    )
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
}
