import { appendFile, readFile, writeFile, access, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { eventBus } from '../core/eventBus.js'

/**
 * Append-only JSONL disk buffer at a configurable file path.
 *
 * Each record is stored as one JSON line. Corrupted lines are skipped with a
 * system:warning event so a single bad line never halts the replay.
 *
 * Operations are intentionally simple (read-all → slice → write-back for truncate)
 * because the buffer is a fallback for DB outages and should stay small under
 * normal conditions.
 */
export class DiskBuffer {
  constructor(private readonly filePath: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
  }

  private async readLines(): Promise<string[]> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      return content.split('\n').filter((l) => l.trim() !== '')
    } catch {
      return []
    }
  }

  /**
   * Append items to the buffer as JSON lines.
   * Creates the directory and file if they do not exist.
   */
  async append(items: unknown[]): Promise<void> {
    if (items.length === 0) return
    await this.ensureDir()
    const chunk = items.map((i) => JSON.stringify(i)).join('\n') + '\n'
    await appendFile(this.filePath, chunk, 'utf8')
  }

  /**
   * Read up to maxCount items from the front of the buffer.
   * Corrupted lines are skipped; a system:warning is emitted for each one.
   */
  async readBatch(maxCount: number): Promise<unknown[]> {
    const lines = await this.readLines()
    const batch: unknown[] = []
    for (const line of lines.slice(0, maxCount)) {
      try {
        batch.push(JSON.parse(line) as unknown)
      } catch {
        eventBus.emit('system:warning', {
          timestamp: new Date(),
          module: 'disk-buffer',
          message: `Skipping corrupted buffer line: ${line.slice(0, 100)}`,
        })
      }
    }
    return batch
  }

  /**
   * Remove the first count lines from the buffer file.
   * Used after a successful replay batch to acknowledge written records.
   *
   * Writes to a `.tmp` sibling and atomically renames on success so a crash
   * mid-write cannot leave the buffer in a half-truncated state, and any
   * concurrent append that lands between our read and write is overwritten
   * only via rename — the tmp file is always consistent.
   */
  async truncateBatch(count: number): Promise<void> {
    const lines = await this.readLines()
    const remaining = lines.slice(count)
    await this.ensureDir()
    const tmpPath = `${this.filePath}.tmp`
    await writeFile(
      tmpPath,
      remaining.length > 0 ? remaining.join('\n') + '\n' : '',
      'utf8',
    )
    await rename(tmpPath, this.filePath)
  }

  async isEmpty(): Promise<boolean> {
    try {
      await access(this.filePath)
      const lines = await this.readLines()
      return lines.length === 0
    } catch {
      return true
    }
  }

  async lineCount(): Promise<number> {
    const lines = await this.readLines()
    return lines.length
  }

  /** Size of the buffer file in bytes (0 if it does not exist). */
  async sizeBytes(): Promise<number> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      return Buffer.byteLength(content, 'utf8')
    } catch {
      return 0
    }
  }
}
