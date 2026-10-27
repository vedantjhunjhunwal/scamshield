import { describe, expect, it } from "vitest";
import { HashRing } from "../src/hashring.js";

const keys = Array.from({ length: 50_000 }, (_, i) => `key-${i}`);

describe("HashRing", () => {
  it("spreads keys evenly across nodes", () => {
    const ring = new HashRing(["a", "b", "c", "d", "e"]);
    const counts = new Map<string, number>();
    for (const k of keys) {
      const owner = ring.preferenceList(k, 1)[0]!;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    const mean = keys.length / 5;
    for (const c of counts.values()) expect(Math.abs(c - mean) / mean).toBeLessThan(0.2);
  });

  it("returns N distinct replicas", () => {
    const ring = new HashRing(["a", "b", "c", "d", "e"]);
    for (const k of keys.slice(0, 1000)) {
      const list = ring.preferenceList(k, 3);
      expect(new Set(list).size).toBe(3);
    }
  });

  it("is deterministic across instances (every gateway routes identically)", () => {
    const a = new HashRing(["x", "y", "z"]);
    const b = new HashRing(["z", "x", "y"]);
    for (const k of keys.slice(0, 1000)) expect(a.preferenceList(k, 2)).toEqual(b.preferenceList(k, 2));
  });

  it("moves only ~1/N of keys when a node joins", () => {
    const ring = new HashRing(["a", "b", "c", "d"]);
    const before = keys.map((k) => ring.preferenceList(k, 1)[0]);
    ring.add("e");
    const moved = keys.filter((k, i) => ring.preferenceList(k, 1)[0] !== before[i]).length / keys.length;
    expect(moved).toBeGreaterThan(0.12);
    expect(moved).toBeLessThan(0.28); // ideal is 1/5 = 0.2; modulo hashing would move ~0.8
    // Every moved key moved *to* the new node.
    for (const [i, k] of keys.entries()) {
      const owner = ring.preferenceList(k, 1)[0];
      if (owner !== before[i]) expect(owner).toBe("e");
    }
  });

  it("skips down nodes and falls through to the next healthy one", () => {
    const ring = new HashRing(["a", "b", "c", "d"]);
    for (const k of keys.slice(0, 500)) {
      const full = ring.preferenceList(k, 4);
      const withoutFirst = ring.preferenceList(k, 3, (n) => n !== full[0]);
      expect(withoutFirst).toEqual(full.slice(1));
    }
  });

  it("returns fewer than N when not enough nodes are up", () => {
    const ring = new HashRing(["a", "b", "c"]);
    expect(ring.preferenceList("k", 3, (n) => n === "a")).toEqual(["a"]);
    expect(new HashRing().preferenceList("k", 3)).toEqual([]);
  });

  it("removes nodes", () => {
    const ring = new HashRing(["a", "b"]);
    ring.remove("a");
    ring.remove("missing");
    expect(ring.nodes()).toEqual(["b"]);
    expect(ring.preferenceList("k", 2)).toEqual(["b"]);
  });
});
