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
): CollectionDef[] {
  const detailedTtlSeconds = detailedRetentionDays * 24 * 60 * 60

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
          key: { incidentId: 1 },
          options: { name: 'incidentId' },
        },
        {
          key: { sentAt: 1 },
          options: { name: 'sentAt' },
        },
      ],
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

async function ensureIndexes(db: Db, collectionName: string, indexes: IndexDef[]): Promise<void> {
  if (indexes.length === 0) return

  const collection = db.collection(collectionName)
  const existingIndexes = await collection.listIndexes().toArray()
  const existingNames = new Set(existingIndexes.map((i) => i.name as string))

  for (const { key, options } of indexes) {
    if (!existingNames.has(options.name)) {
      await collection.createIndex(key, options)
    }
  }
}

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

/**
 * Idempotent migration runner.
 *
 * For each of the 9 collections:
 *   - Creates the collection if it does not exist
 *   - Creates any missing indexes (identified by name)
 *   - Never drops or alters existing collections or data
 *
 * @param db                  Connected MongoDB Db instance
 * @param prefix              Collection name prefix (e.g. "mx_")
 * @param detailedRetentionDays  From config.retention.detailedDays — sets TTL on mx_checks
 */
export async function runMigrations(
  db: Db,
  prefix: string,
  detailedRetentionDays: number,
): Promise<void> {
  const collections = buildCollections(prefix, detailedRetentionDays)

  for (const col of collections) {
    await ensureCollection(db, col.name)
    await ensureIndexes(db, col.name, col.indexes)
  }
}
