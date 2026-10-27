import { createHash } from "node:crypto";

/**
 * State-based CRDTs. Every merge is commutative, associative and idempotent, so
 * replicas can apply concurrent reports in any order, receive duplicates, and
 * still converge to the same state without locks or coordination.
 */

/** Grow-only counter: one slot per node, merged by taking the per-slot maximum. */
export type GCounter = Record<string, number>;

export const gcounter = {
  increment(c: GCounter, node: string, by = 1): GCounter {
    return { ...c, [node]: (c[node] ?? 0) + by };
  },
  value(c: GCounter): number {
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
  merge(a: GCounter, b: GCounter): GCounter {
    const out: GCounter = { ...a };
    for (const [node, n] of Object.entries(b)) out[node] = Math.max(out[node] ?? 0, n);
    return out;
  },
};

/**
 * HyperLogLog distinct counter. 2^P one-byte registers estimate how many *distinct*
 * reporters flagged an indicator in fixed memory, which makes one account
 * spamming reports far less effective than many independent reports.
 */
export const HLL_P = 10;
const M = 1 << HLL_P;
const ALPHA = 0.7213 / (1 + 1.079 / M);

function hash64(value: string): bigint {
  return createHash("sha256").update(value).digest().readBigUInt64BE(0);
}

export const hll = {
  empty(): Uint8Array {
    return new Uint8Array(M);
  },
  add(registers: Uint8Array, value: string): Uint8Array {
    const h = hash64(value);
    const idx = Number(h >> BigInt(64 - HLL_P));
    const rest = (h << BigInt(HLL_P)) & 0xffff_ffff_ffff_ffffn;
    // Rank = position of the leftmost 1-bit in the remaining 64-P bits.
    let rank = 1;
    for (let bit = 63n; bit >= BigInt(HLL_P) && ((rest >> bit) & 1n) === 0n; bit--) rank++;
    if (rank <= registers[idx]!) return registers;
    const out = registers.slice();
    out[idx] = rank;
    return out;
  },
  estimate(registers: Uint8Array): number {
    let sum = 0;
    let zeros = 0;
    for (const r of registers) {
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const raw = (ALPHA * M * M) / sum;
    // Linear counting is far more accurate for small cardinalities.
    if (raw <= 2.5 * M && zeros > 0) return Math.round(M * Math.log(M / zeros));
    return Math.round(raw);
  },
  merge(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(M);
    for (let i = 0; i < M; i++) out[i] = Math.max(a[i]!, b[i]!);
    return out;
  },
};

export type IndicatorKind = "url" | "phone";

export interface IndicatorState {
  kind: IndicatorKind;
  reports: GCounter;
  reporters: Uint8Array;
  firstSeen: number;
  lastSeen: number;
}

export function emptyState(kind: IndicatorKind): IndicatorState {
  return { kind, reports: {}, reporters: hll.empty(), firstSeen: Number.MAX_SAFE_INTEGER, lastSeen: 0 };
}

export function mergeState(a: IndicatorState, b: IndicatorState): IndicatorState {
  return {
    kind: a.kind,
    reports: gcounter.merge(a.reports, b.reports),
    reporters: hll.merge(a.reporters, b.reporters),
    firstSeen: Math.min(a.firstSeen, b.firstSeen),
    lastSeen: Math.max(a.lastSeen, b.lastSeen),
  };
}

export function statesEqual(a: IndicatorState, b: IndicatorState): boolean {
  return JSON.stringify(encodeState(a)) === JSON.stringify(encodeState(b));
}

/** Wire/disk format: registers as base64 so states travel as plain JSON. */
export interface EncodedState {
  kind: IndicatorKind;
  reports: GCounter;
  reporters: string;
  firstSeen: number;
  lastSeen: number;
}

export function encodeState(s: IndicatorState): EncodedState {
  const reports = Object.fromEntries(Object.entries(s.reports).sort(([a], [b]) => a.localeCompare(b)));
  return { ...s, reports, reporters: Buffer.from(s.reporters).toString("base64") };
}

export function decodeState(e: EncodedState): IndicatorState {
  return { ...e, reporters: new Uint8Array(Buffer.from(e.reporters, "base64")) };
}
