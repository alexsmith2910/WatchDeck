/**
 * Fixed-capacity in-memory FIFO buffer.
 *
 * When full, push() returns false and the caller is responsible for spilling to disk.
 * flush() atomically returns all items and resets the buffer.
 */
export class MemoryBuffer<T> {
  private readonly items: T[] = []

  constructor(private readonly capacity: number) {}

  /**
   * Add an item.
   * Returns true if accepted, false if the buffer is already at capacity.
   */
  push(item: T): boolean {
    if (this.items.length >= this.capacity) return false
    this.items.push(item)
    return true
  }

  /**
   * Return all buffered items and reset the buffer to empty.
   */
  flush(): T[] {
    return this.items.splice(0)
  }

  isFull(): boolean {
    return this.items.length >= this.capacity
  }

  isEmpty(): boolean {
    return this.items.length === 0
  }

  get size(): number {
    return this.items.length
  }
}
