import type { CheckWritePayload, SystemEventDoc } from './types.js'

/**
 * Abstract storage adapter.
 *
 * All application code references StorageAdapter — never MongoDBAdapter
 * or any other concrete implementation directly.  This keeps database
 * dependencies isolated and makes future adapter swaps (Postgres, SQLite)
 * a drop-in replacement.
 *
 * Connection lifecycle methods are defined here.
 * CRUD methods are added as abstract stubs when each step needs them.
 */

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'down'
  latencyMs: number
}

export abstract class StorageAdapter {
  /**
   * Establish the initial database connection.
   * Implementations should retry with the boot strategy (3 attempts, 5s gaps)
   * and throw on total failure so the process can exit cleanly.
   */
  abstract connect(): Promise<void>

  /**
   * Gracefully close all connections.
   * Called during shutdown or before process exit.
   */
  abstract disconnect(): Promise<void>

  /**
   * Ping the database and return connection health + round-trip latency.
   * Safe to call at any time — returns { status: 'down' } if not connected.
   */
  abstract healthCheck(): Promise<HealthCheckResult>

  /**
   * Returns true if the adapter currently has an active connection.
   */
  abstract isConnected(): boolean

  /**
   * Run idempotent collection and index migrations.
   * Creates missing collections and indexes; never drops or alters existing data.
   * Should be called once after a successful connect().
   */
  abstract migrate(): Promise<void>

  // ---------------------------------------------------------------------------
  // Buffer pipeline
  // ---------------------------------------------------------------------------

  /**
   * Persist a single check result.
   * Called by the buffer pipeline during live (DB-connected) operation.
   */
  abstract saveCheck(payload: CheckWritePayload): Promise<void>

  /**
   * Persist multiple check results in one operation.
   * Called during buffer replay (reconnect and startup).
   */
  abstract saveManyChecks(payloads: CheckWritePayload[]): Promise<void>

  // ---------------------------------------------------------------------------
  // System events
  // ---------------------------------------------------------------------------

  /**
   * Persist a system event record (e.g. a DB outage summary).
   */
  abstract saveSystemEvent(event: Omit<SystemEventDoc, '_id'>): Promise<void>

  /**
   * Retrieve recent system event records, newest first.
   */
  abstract getSystemEvents(limit?: number): Promise<SystemEventDoc[]>
}
