import { describe, expect, it } from "vitest";
import {
  decodeState,
  emptyState,
  encodeState,
  gcounter,
  hll,
  mergeState,
  statesEqual,
  type IndicatorState,
} from "../src/crdt.js";

// Small seeded PRNG so property tests are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomState(rand: () => number): IndicatorState {
  let s = emptyState("url");
  const nodes = ["n1", "n2", "n3", "n4"];
  for (let i = 0, n = Math.floor(rand() * 30); i < n; i++) {
    const node = nodes[Math.floor(rand() * nodes.length)]!;
    s = {
      ...s,
      reports: gcounter.increment(s.reports, node),
      reporters: hll.add(s.reporters, `r${Math.floor(rand() * 50)}`),
      firstSeen: Math.min(s.firstSeen, Math.floor(rand() * 1e6)),
      lastSeen: Math.max(s.lastSeen, Math.floor(rand() * 1e6)),
    };
  }
  return s;
}

describe("CRDT merge laws (200 random cases each)", () => {
  const rand = rng(42);
  const cases = Array.from({ length: 200 }, () => [randomState(rand), randomState(rand), randomState(rand)] as const);

  it("is commutative: a ⊔ b = b ⊔ a", () => {
    for (const [a, b] of cases) expect(statesEqual(mergeState(a, b), mergeState(b, a))).toBe(true);
  });

  it("is associative: (a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)", () => {
    for (const [a, b, c] of cases) expect(statesEqual(mergeState(mergeState(a, b), c), mergeState(a, mergeState(b, c)))).toBe(true);
  });

  it("is idempotent: a ⊔ a = a", () => {
    for (const [a] of cases) expect(statesEqual(mergeState(a, a), a)).toBe(true);
  });

  it("converges regardless of delivery order and duplication", () => {
    const [a, b, c] = cases[0]!;
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, a, c, a, b],
      [c, c, a, b, b],
    ];
    const results = orders.map((o) => o.reduce(mergeState));
    for (const r of results) expect(statesEqual(r, results[0]!)).toBe(true);
  });
});

describe("GCounter", () => {
  it("sums slots and merges by per-slot max (no lost or double-counted increments)", () => {
    let a = gcounter.increment({}, "n1", 3);
    let b = gcounter.increment({}, "n2", 2);
    a = gcounter.increment(a, "n1");
    b = gcounter.merge(b, a);
    expect(gcounter.value(gcounter.merge(a, b))).toBe(6);
  });
});

describe("HyperLogLog", () => {
  const fill = (n: number, prefix = "u") => {
    let r = hll.empty();
    for (let i = 0; i < n; i++) r = hll.add(r, `${prefix}${i}`);
    return r;
  };

  it("is exact-ish for the small counts that drive verdicts", () => {
    for (const n of [0, 1, 5, 20, 50]) expect(Math.abs(hll.estimate(fill(n)) - n)).toBeLessThanOrEqual(Math.max(1, n * 0.02));
  });

  it.each([1_000, 10_000, 100_000])("estimates %i distinct values within 3 standard errors (~10%%)", (n) => {
    expect(Math.abs(hll.estimate(fill(n)) - n) / n).toBeLessThan(0.1);
  });

  it("ignores duplicates", () => {
    let r = hll.empty();
    for (let i = 0; i < 1000; i++) r = hll.add(r, "same-reporter");
    expect(hll.estimate(r)).toBe(1);
  });

  it("estimates the union when merged", () => {
    const merged = hll.merge(fill(5000, "a"), fill(5000, "b"));
    expect(Math.abs(hll.estimate(merged) - 10_000) / 10_000).toBeLessThan(0.1);
  });

  it("uses fixed memory independent of cardinality", () => {
    expect(fill(10).byteLength).toBe(fill(50_000).byteLength);
  });
});

describe("encoding", () => {
  it("round-trips through JSON", () => {
    const s = randomState(rng(7));
    const back = decodeState(JSON.parse(JSON.stringify(encodeState(s))));
    expect(statesEqual(back, s)).toBe(true);
  });
});
