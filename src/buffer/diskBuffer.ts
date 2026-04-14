import { appendFile, readFile, writeFile, access, mkdir } from 'node:fs/promises'
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
   */
  async truncateBatch(count: number): Promise<void> {
    const lines = await this.readLines()
    const remaining = lines.slice(count)
    await this.ensureDir()
    await writeFile(
      this.filePath,
      remaining.length > 0 ? remaining.join('\n') + '\n' : '',
      'utf8',
    )
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
}
