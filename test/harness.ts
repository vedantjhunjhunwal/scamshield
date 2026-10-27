import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statesEqual } from "../src/crdt.js";
import { Gateway, type GatewayOptions } from "../src/gateway.js";
import { Shard } from "../src/shard.js";

export const TEST_SECRET = "test-secret-0123456789abcdef0123456789";

/** Spins up a real multi-node cluster in-process on ephemeral ports. */
export class TestCluster {
  readonly dir = mkdtempSync(join(tmpdir(), "scamshield-"));
  readonly ids: string[];
  readonly shards = new Map<string, Shard>();
  readonly urls: Record<string, string> = {};
  readonly gateways: Gateway[] = [];
  readonly gatewayUrls: string[] = [];

  constructor(size: number) {
    this.ids = Array.from({ length: size }, (_, i) => `s${i + 1}`);
  }

  async start(gateways = 1, gatewayOptions: Partial<GatewayOptions> = {}): Promise<this> {
    for (const id of this.ids) {
      const shard = this.makeShard(id);
      this.urls[id] = await shard.start();
      this.shards.set(id, shard);
    }
    for (const s of this.shards.values()) s.setPeers(this.urls);
    for (let i = 0; i < gateways; i++) {
      const gw = new Gateway({ shards: this.urls, keySecret: TEST_SECRET, reportBurst: 1e9, reportsPerMinute: 1e9, cacheTtlMs: 0, ...gatewayOptions });
      this.gatewayUrls.push(await gw.start());
      this.gateways.push(gw);
    }
    return this;
  }

  private makeShard(id: string): Shard {
    return new Shard({ id, dataDir: this.dir, nodes: this.ids, antiEntropyMs: 50, rpcTimeoutMs: 300 });
  }

  /** Simulates a crash: the node stops serving; its WAL stays on disk. */
  async kill(id: string): Promise<void> {
    await this.shards.get(id)!.stop();
    await Promise.all(this.gateways.map((g) => g.probe(true)));
  }

  /** Restarts a node on its old port from its WAL, then pulls missed writes from peers. */
  async restart(id: string, recover = true): Promise<void> {
    const shard = this.makeShard(id);
    shard.setPeers(this.urls);
    await shard.start(Number(new URL(this.urls[id]!).port));
    this.shards.set(id, shard);
    if (recover) await shard.recover();
    await Promise.all(this.gateways.map((g) => g.probe()));
  }

  /** Polls until every replica of `key` holds an identical state. */
  async converged(key: string, replicas: string[], timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const states = replicas.map((id) => this.shards.get(id)!.stateOf(key));
      if (states.every((s) => s !== undefined) && states.every((s) => statesEqual(s!, states[0]!))) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.gateways.map((g) => g.stop()));
    await Promise.allSettled([...this.shards.values()].map((s) => s.stop()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function get(url: string) {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
