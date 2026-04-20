/**
 * Probe registration — wires every subsystem probe into the shared
 * `probeRegistry` singleton with the cadence from spec §4.4. Called once
 * during startup, after all dependencies have been constructed.
 *
 * Each probe is created by a factory in `./probes/*` so the closure captures
 * the live instances (adapter, scheduler, pipeline, etc.) without depending
 * on module-level globals.
 */

import { probeRegistry } from './probeRegistry.js'
import { metaFor, SUBSYSTEM_METADATA } from './subsystems.js'
import { createDbProbe } from './probes/db.js'
import { createSchedulerProbe } from './probes/scheduler.js'
import { createCheckersProbe } from './probes/checkers.js'
import { createBufferProbe } from './probes/buffer.js'
import { createSseProbe } from './probes/sse.js'
import { createEventBusProbe } from './probes/eventbus.js'
import { createAggregatorProbe } from './probes/aggregator.js'
import { createIncidentsProbe } from './probes/incidents.js'
import { createAuthProbe } from './probes/auth.js'
import { createNotificationsProbe } from './probes/notifications.js'
import type { StorageAdapter } from '../../storage/adapter.js'
import type { CheckScheduler } from '../scheduler.js'
import type { BufferPipeline } from '../../buffer/pipeline.js'
import type { MemoryBuffer } from '../../buffer/memoryBuffer.js'
import type { DiskBuffer } from '../../buffer/diskBuffer.js'
import type { AggregationScheduler } from '../../aggregation/scheduler.js'
import type { CheckWritePayload } from '../../storage/types.js'
import type { WatchDeckConfig } from '../../config/types.js'

export interface ProbeWiringDeps {
  adapter: StorageAdapter
  scheduler: CheckScheduler
  pipeline: BufferPipeline
  memBuffer: MemoryBuffer<CheckWritePayload>
  diskBuffer: DiskBuffer
  aggregation: AggregationScheduler
  config: WatchDeckConfig
  /** Effective port the API server is listening on (overrides config.port). */
  port: number
}

export function registerCoreProbes(deps: ProbeWiringDeps): void {
  // ── Core tier ────────────────────────────────────────────────────────────
  probeRegistry.register('db', createDbProbe(deps.adapter), metaFor('db')!.cadenceMs)
  probeRegistry.register(
    'scheduler',
    createSchedulerProbe(deps.scheduler),
    metaFor('scheduler')!.cadenceMs,
  )
  probeRegistry.register(
    'buffer',
    createBufferProbe({
      pipeline: deps.pipeline,
      memBuffer: deps.memBuffer,
      diskBuffer: deps.diskBuffer,
    }),
    metaFor('buffer')!.cadenceMs,
  )
  probeRegistry.register(
    'checkers',
    createCheckersProbe({
      scheduler: deps.scheduler,
      pingUrl: () => `http://127.0.0.1:${deps.port}${deps.config.apiBasePath}/health/ping`,
    }),
    metaFor('checkers')!.cadenceMs,
  )

  // ── Non-core tier ────────────────────────────────────────────────────────
  probeRegistry.register('sse', createSseProbe(), metaFor('sse')!.cadenceMs)
  probeRegistry.register('eventbus', createEventBusProbe(), metaFor('eventbus')!.cadenceMs)
  probeRegistry.register(
    'aggregator',
    createAggregatorProbe(deps.aggregation),
    metaFor('aggregator')!.cadenceMs,
  )
  probeRegistry.register('incidents', createIncidentsProbe(), metaFor('incidents')!.cadenceMs)
  probeRegistry.register('auth', createAuthProbe(deps.config), metaFor('auth')!.cadenceMs)
  probeRegistry.register(
    'notifications',
    createNotificationsProbe(deps.adapter),
    metaFor('notifications')!.cadenceMs,
  )
}

/** Convenience: list of subsystem ids the registry currently knows about. */
export function knownSubsystemIds(): string[] {
  return SUBSYSTEM_METADATA.map((m) => m.id)
}
