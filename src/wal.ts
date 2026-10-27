import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only write-ahead log with group commit: every append made in the same
 * event-loop turn is written and fsync'd together, so N concurrent writers pay
 * for one disk flush instead of N. Each append's promise resolves only once its
 * record is durable.
 */
export class Wal<T> {
  private pending: string[] = [];
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private scheduled = false;
  private fd: number;
  private closed = false;
  flushes = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }

  append(record: T): Promise<void> {
    this.pending.push(JSON.stringify(record));
    const done = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
    return done;
  }

  private flush(): void {
    const batch = this.pending;
    const waiters = this.waiters;
    this.pending = [];
    this.waiters = [];
    this.scheduled = false;
    try {
      appendFileSync(this.fd, batch.join("\n") + "\n");
      fsyncSync(this.fd);
      this.flushes++;
      for (const w of waiters) w.resolve();
    } catch (err) {
      for (const w of waiters) w.reject(err);
    }
  }

  /** Reads every complete record; a torn final line from a crash mid-write is skipped. */
  replay(): T[] {
    const out: T[] = [];
    for (const file of [`${this.path}.snapshot`, this.path]) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          // Torn write: the record was never acknowledged, so dropping it is safe.
        }
      }
    }
    return out;
  }

  /** Replaces log + old snapshot with a compact snapshot of the current state. */
  compact(records: T[]): void {
    const tmp = `${this.path}.snapshot.tmp`;
    writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
    renameSync(tmp, `${this.path}.snapshot`);
    closeSync(this.fd);
    writeFileSync(this.path, "");
    this.fd = openSync(this.path, "a");
  }

  /** Idempotent: closing twice must not close an fd number the OS has since reused. */
  close(): void {
    if (this.closed) return;
    if (this.pending.length) this.flush();
    this.closed = true;
    closeSync(this.fd);
  }
}
