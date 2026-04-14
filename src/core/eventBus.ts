import { EventEmitter } from 'node:events'
import type { EventMap } from './eventTypes.js'

/**
 * Typed wrapper around Node's EventEmitter.
 * Provides compile-time safety for all event names and their payload shapes.
 * Priority levels and circular history buffer are added in the event bus module.
 */
class TypedEventBus extends EventEmitter {
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    return super.emit(event as string, payload)
  }

  on<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): this {
    return super.on(event as string, listener)
  }

  once<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): this {
    return super.once(event as string, listener)
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): this {
    return super.off(event as string, listener)
  }
}

/** Singleton event bus. Import this wherever events need to be emitted or subscribed to. */
export const eventBus = new TypedEventBus()

// Max listeners is configured via initEventBus(config) during boot.
// Default Node value (10) is raised here to avoid spurious warnings during dev.
eventBus.setMaxListeners(50)
