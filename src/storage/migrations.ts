import type { CreateIndexesOptions, Db, IndexSpecification } from 'mongodb'

interface IndexDef {
  key: IndexSpecification
  options: CreateIndexesOptions & { name: string }
}

interface CollectionDef {
  name: string
  indexes: IndexDef[]
}

// ---------------------------------------------------------------------------
// Collection + index definitions (all prefixed at runtime)
// ---------------------------------------------------------------------------

function buildCollections(
  prefix: string,
  detailedRetentionDays: number,
  notificationLogRetentionDays: number,
): CollectionDef[] {
  const detailedTtlSeconds = detailedRetentionDays * 24 * 60 * 60
  const notificationLogTtlSeconds = notificationLogRetentionDays * 24 * 60 * 60

  return [
    {
      name: `${prefix}endpoints`,
      indexes: [
        {
          key: { enabled: 1, lastCheckAt: 1 },
          options: { name: 'enabled_lastCheckAt' },
        },
        {
          key: { type: 1 },
          options: { name: 'type' },
        },
      ],
    },
    {
      name: `${prefix}checks`,
      indexes: [
        {
          key: { endpointId: 1, timestamp: -1 },
          options: { name: 'endpointId_timestamp' },
        },
        {
          // TTL index — documents expire after retention.detailedDays
          key: { timestamp: 1 },
          options: { name: 'timestamp_ttl', expireAfterSeconds: detailedTtlSeconds },
        },
        {
          key: { status: 1, timestamp: -1 },
          options: { name: 'status_timestamp' },
        },
      ],
    },
    {
      name: `${prefix}hourly_summaries`,
      indexes: [
        {
          key: { endpointId: 1, hour: -1 },
          options: { name: 'endpointId_hour' },
        },
        {
          key: { hour: 1 },
          options: { name: 'hour' },
        },
      ],
    },
    {
      name: `${prefix}daily_summaries`,
      indexes: [
        {
          key: { endpointId: 1, date: -1 },
          options: { name: 'endpointId_date' },
        },
        {
          key: { date: 1 },
          options: { name: 'date' },
        },
      ],
    },
    {
      name: `${prefix}incidents`,
      indexes: [
        {
          key: { endpointId: 1, status: 1 },
          options: { name: 'endpointId_status' },
        },
        {
          key: { status: 1, startedAt: -1 },
          options: { name: 'status_startedAt' },
        },
        {
          key: { startedAt: -1 },
          options: { name: 'startedAt' },
        },
      ],
    },
    {
      name: `${prefix}notification_channels`,
      indexes: [
        {
          key: { type: 1 },
          options: { name: 'type' },
        },
        {
          key: { enabled: 1, type: 1 },
          options: { name: 'enabled_type' },
        },
      ],
    },
    {
      name: `${prefix}notification_log`,
      indexes: [
        {
          key: { endpointId: 1, sentAt: -1 },
          options: { name: 'endpointId_sentAt' },
        },
        {
          key: { channelId: 1, sentAt: -1 },
          options: { name: 'channelId_sentAt' },
        },
        {
          key: { incidentId: 1 },
          options: { name: 'incidentId' },
        },
        {
          key: { deliveryStatus: 1, sentAt: -1 },
          options: { name: 'status_sentAt' },
        },
        {
          // TTL index — notification log rows expire after retention.notificationLogDays
          key: { sentAt: 1 },
          options: { name: 'sentAt_ttl', expireAfterSeconds: notificationLogTtlSeconds },
        },
      ],
    },
    {
      name: `${prefix}notification_mutes`,
      indexes: [
        {
          key: { scope: 1, targetId: 1 },
          options: { name: 'scope_targetId' },
        },
        {
          // TTL — mutes drop themselves at expiresAt.
          key: { expiresAt: 1 },
          options: { name: 'expiresAt_ttl', expireAfterSeconds: 0 },
        },
      ],
    },
    {
      // Single global document (_id: "global"). No custom indexes needed.
      name: `${prefix}notification_preferences`,
      indexes: [],
    },
    {
      // Single global document (_id: "global"). No custom indexes needed.
      name: `${prefix}settings`,
      indexes: [],
    },
    {
      name: `${prefix}system_events`,
      indexes: [
        {
          key: { type: 1, startedAt: -1 },
          options: { name: 'type_startedAt' },
        },
      ],
    },
    {
      // Single global document (_id: "snapshot"). No custom indexes needed.
      name: `${prefix}health_state`,
      indexes: [],
    },
    {
      name: `${prefix}internal_incidents`,
      indexes: [
        {
          key: { status: 1, startedAt: -1 },
          options: { name: 'status_startedAt' },
        },
        {
          // TTL — drop resolved incidents after the date stored in expiresAt.
          // Active incidents have no expiresAt and are never auto-removed.
          key: { expiresAt: 1 },
          options: { name: 'expiresAt_ttl', expireAfterSeconds: 0 },
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Idempotent helpers
// ---------------------------------------------------------------------------

async function ensureCollection(db: Db, name: string): Promise<void> {
  const existing = await db
    .listCollections({ name }, { nameOnly: true })
    .toArray()

  if (existing.length === 0) {
    await db.createCollection(name)
  }
}

function keySignature(key: unknown): string {
  // listIndexes returns `key` as a plain object; IndexSpecification inputs can
  // also be arrays of tuples. Normalize to a stable JSON string.
  if (Array.isArray(key)) return JSON.stringify(key)
  if (key && typeof key === 'object') {
    return JSON.stringify(Object.entries(key as Record<string, unknown>))
  }
  return JSON.stringify(key)
}

async function ensureIndexes(db: Db, collectionName: string, indexes: IndexDef[]): Promise<void> {
  if (indexes.length === 0) return

  const collection = db.collection(collectionName)
  const existingIndexes = await collection.listIndexes().toArray()
  const existingByName = new Map(existingIndexes.map((i) => [i.name as string, i]))
  const existingByKey = new Map(
    existingIndexes
      .filter((i) => (i.name as string) !== '_id_')
      .map((i) => [keySignature(i.key), i]),
  )

  for (const { key, options } of indexes) {
    const desiredSig = keySignature(key)
    const byName = existingByName.get(options.name)
    const byKey = existingByKey.get(desiredSig)

    // An index with the same name already exists → trust it and move on.
    // (If its options drifted, that's a manual fix; we never silently
    // drop an index the caller pinned by name.)
    if (byName) continue

    // An index on the same key exists under a different name. This happens
    // when an older migration created the index without TTL/partial options
    // and we've since tightened the spec. Drop it so the create below can
    // replace it with the intended name and options.
    if (byKey) {
      await collection.dropIndex(byKey.name as string)
    }

    await collection.createIndex(key, options)
  }
}

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

/**
 * Idempotent migration runner.
 *
 * For each configured collection:
 *   - Creates the collection if it does not exist
 *   - Creates any missing indexes (identified by name)
 *   - Never drops or alters existing collections or data
 *
 * @param db                           Connected MongoDB Db instance
 * @param prefix                       Collection name prefix (e.g. "mx_")
 * @param detailedRetentionDays        From config.retention.detailedDays — sets TTL on mx_checks
 * @param notificationLogRetentionDays From config.retention.notificationLogDays — sets TTL on mx_notification_log
 */
export async function runMigrations(
  db: Db,
  prefix: string,
  detailedRetentionDays: number,
  notificationLogRetentionDays: number,
): Promise<{ collectionCount: number }> {
  const collections = buildCollections(
    prefix,
    detailedRetentionDays,
    notificationLogRetentionDays,
  )

  for (const col of collections) {
    await ensureCollection(db, col.name)
    await ensureIndexes(db, col.name, col.indexes)
  }

  return { collectionCount: collections.length }
}
