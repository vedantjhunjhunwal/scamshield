import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Wal } from "../src/wal.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wal-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Wal", () => {
  it("group-commits concurrent appends into a single fsync", async () => {
    const wal = new Wal<{ n: number }>(join(dir, "a.wal"));
    await Promise.all(Array.from({ length: 1000 }, (_, n) => wal.append({ n })));
    expect(wal.flushes).toBe(1);
    expect(wal.replay()).toHaveLength(1000);
    wal.close();
  });

  it("replays records in append order across restarts", async () => {
    const path = join(dir, "b.wal");
    const first = new Wal<{ n: number }>(path);
    await first.append({ n: 1 });
    await first.append({ n: 2 });
    first.close();
    const second = new Wal<{ n: number }>(path);
    await second.append({ n: 3 });
    expect(second.replay().map((r) => r.n)).toEqual([1, 2, 3]);
    second.close();
  });

  it("skips a torn final record left by a crash mid-write", async () => {
    const path = join(dir, "c.wal");
    const wal = new Wal<{ n: number }>(path);
    await wal.append({ n: 1 });
    wal.close();
    appendFileSync(path, '{"n": 2'); // partial write, no newline
    expect(new Wal<{ n: number }>(path).replay()).toEqual([{ n: 1 }]);
  });

  it("compacts into a snapshot and keeps appending after it", async () => {
    const path = join(dir, "d.wal");
    const wal = new Wal<{ n: number }>(path);
    for (let n = 0; n < 50; n++) await wal.append({ n });
    wal.compact([{ n: 49 }]);
    await wal.append({ n: 50 });
    expect(wal.replay()).toEqual([{ n: 49 }, { n: 50 }]);
    wal.close();
  });
});
