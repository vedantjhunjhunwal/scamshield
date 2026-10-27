import { createHash } from "node:crypto";

export function hash32(value: string): number {
  return createHash("md5").update(value).digest().readUInt32BE(0);
}

interface Point {
  hash: number;
  node: string;
}

/**
 * Consistent-hash ring with virtual nodes. Adding or removing a node only moves
 * the keys adjacent to that node's points (~1/N of the keyspace), so the cluster
 * can grow without reshuffling everything.
 */
export class HashRing {
  private points: Point[] = [];
  private readonly members = new Set<string>();
  private readonly vnodes: number;

  constructor(nodes: Iterable<string> = [], vnodes = 128) {
    this.vnodes = vnodes;
    for (const node of nodes) this.add(node);
  }

  add(node: string): void {
    if (this.members.has(node)) return;
    this.members.add(node);
    for (let i = 0; i < this.vnodes; i++) this.points.push({ hash: hash32(`${node}#${i}`), node });
    this.points.sort((a, b) => a.hash - b.hash);
  }

  remove(node: string): void {
    if (!this.members.delete(node)) return;
    this.points = this.points.filter((p) => p.node !== node);
  }

  nodes(): string[] {
    return [...this.members];
  }

  /**
   * The first `n` distinct nodes clockwise from the key's position, skipping nodes
   * that `isUp` reports as down (a sloppy quorum: writes fall through to the next
   * healthy node and anti-entropy hands them back later).
   */
  preferenceList(key: string, n: number, isUp: (node: string) => boolean = () => true): string[] {
    if (this.points.length === 0) return [];
    const target = hash32(key);
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid]!.hash < target) lo = mid + 1;
      else hi = mid;
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.points.length && out.length < n; i++) {
      const { node } = this.points[(lo + i) % this.points.length]!;
      if (seen.has(node)) continue;
      seen.add(node);
      if (isUp(node)) out.push(node);
    }
    return out;
  }
}
