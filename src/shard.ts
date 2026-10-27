import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";
import {
  decodeState,
  emptyState,
  encodeState,
  gcounter,
  hll,
  mergeState,
  statesEqual,
  type EncodedState,
  type IndicatorKind,
  type IndicatorState,
} from "./crdt.js";
import { HashRing } from "./hashring.js";
import { quorum, rpc } from "./rpc.js";
import { Wal } from "./wal.js";

export interface ShardOptions {
  id: string;
  dataDir: string;
  /** Every shard in the cluster (including this one), by id. */
  nodes: string[];
  replication?: number;
  writeQuorum?: number;
  antiEntropyMs?: number;
  compactEvery?: number;
  rpcTimeoutMs?: number;
}

export interface ReportRequest {
  requestId: string;
  key: string;
  kind: IndicatorKind;
  reporter: string;
  replicas: string[];
}

export interface ReportResponse {
  acks: number;
  state: EncodedState;
}

interface Entry {
  key: string;
  state: EncodedState;
}

const DEDUPE_WINDOW = 100_000;

/**
 * A storage node. Holds the CRDT state for the keys it replicates, coordinates
 * writes for keys where it is first in the preference list, and repairs replicas
 * that missed writes through a background anti-entropy loop.
 */
export class Shard {
  readonly app: FastifyInstance;
  readonly id: string;
  private readonly states = new Map<string, IndicatorState>();
  /** Local version per key, bumped on every change, so acks for stale sends don't clear newer work. */
  private readonly versions = new Map<string, number>();
  /** key -> replicas that have not yet acknowledged this key's latest state. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly recent = new Map<string, ReportResponse>();
  private readonly wal: Wal<Entry>;
  private readonly ring: HashRing;
  private peers = new Map<string, string>();
  private appendsSinceCompact = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly opts: Required<Omit<ShardOptions, "id" | "dataDir" | "nodes">>;
  private readonly registry = new Registry();
  private readonly coordinated: Counter;
  private readonly merged: Counter;

  constructor(options: ShardOptions) {
    this.id = options.id;
    this.opts = {
      replication: options.replication ?? 3,
      writeQuorum: options.writeQuorum ?? 2,
      antiEntropyMs: options.antiEntropyMs ?? 250,
      compactEvery: options.compactEvery ?? 50_000,
      rpcTimeoutMs: options.rpcTimeoutMs ?? 1000,
    };
    this.ring = new HashRing(options.nodes);
    this.wal = new Wal<Entry>(join(options.dataDir, `${options.id}.wal`));
    for (const { key, state } of this.wal.replay()) this.apply(key, decodeState(state));

    collectDefaultMetrics({ register: this.registry, prefix: "shard_" });
    this.coordinated = new Counter({ name: "shard_reports_coordinated_total", help: "Reports this shard coordinated", registers: [this.registry] });
    this.merged = new Counter({ name: "shard_merges_applied_total", help: "Replica states merged in", registers: [this.registry] });
    const keys = new Gauge({ name: "shard_keys", help: "Indicators stored", registers: [this.registry] });
    const pendingGauge = new Gauge({ name: "shard_pending_replications", help: "Replica updates awaiting acknowledgement", registers: [this.registry] });
    const flushes = new Gauge({ name: "shard_wal_flushes", help: "fsync'd WAL group commits", registers: [this.registry] });

    this.app = Fastify({ logger: false });
    this.app.post<{ Body: ReportRequest }>("/internal/report", async (req) => this.coordinate(req.body));
    this.app.post<{ Body: { entries: Entry[] } }>("/internal/merge", async (req) => {
      await Promise.all(req.body.entries.map((e) => this.mergeIn(e.key, decodeState(e.state))));
      return { ok: true };
    });
    this.app.get<{ Params: { key: string } }>("/internal/state/:key", async (req, reply) => {
      const s = this.states.get(req.params.key);
      return s ? encodeState(s) : reply.code(404).send({ error: "not_found" });
    });
    this.app.get<{ Querystring: { for: string } }>("/internal/dump", async (req) => this.dumpFor(req.query.for));
    this.app.get("/healthz", async () => ({ id: this.id, keys: this.states.size, pending: this.pending.size }));
    this.app.get("/metrics", async (_req, reply) => {
      keys.set(this.states.size);
      pendingGauge.set(this.pending.size);
      flushes.set(this.wal.flushes);
      reply.header("content-type", this.registry.contentType);
      return this.registry.metrics();
    });
  }

  setPeers(peers: Record<string, string>): void {
    this.peers = new Map(Object.entries(peers));
  }

  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    const address = await this.app.listen({ port, host });
    this.timer = setInterval(() => void this.antiEntropy(), this.opts.antiEntropyMs);
    return address;
  }

  /** Pulls every key this shard should replicate from its peers (after a restart). */
  async recover(): Promise<number> {
    let merged = 0;
    await Promise.allSettled(
      [...this.peers].filter(([id]) => id !== this.id).map(async ([, url]) => {
        const entries = (await rpc<Entry[]>(`${url}/internal/dump?for=${encodeURIComponent(this.id)}`, { timeoutMs: 10_000 })) ?? [];
        await Promise.all(entries.map((e) => this.mergeIn(e.key, decodeState(e.state))));
        merged += entries.length;
      }),
    );
    return merged;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.app.close();
    this.wal.close();
  }

  stateOf(key: string): IndicatorState | undefined {
    return this.states.get(key);
  }

  private apply(key: string, incoming: IndicatorState): boolean {
    const current = this.states.get(key);
    const next = current ? mergeState(current, incoming) : incoming;
    if (current && statesEqual(current, next)) return false;
    this.states.set(key, next);
    this.bump(key);
    return true;
  }

  private bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  private acked(key: string, replica: string, version: number): void {
    if (this.versions.get(key) !== version) return; // A newer state is still owed to this replica.
    const set = this.pending.get(key);
    set?.delete(replica);
    if (set?.size === 0) this.pending.delete(key);
  }

  private async persist(key: string): Promise<void> {
    await this.wal.append({ key, state: encodeState(this.states.get(key)!) });
    if (++this.appendsSinceCompact >= this.opts.compactEvery) {
      this.appendsSinceCompact = 0;
      this.wal.compact([...this.states].map(([k, s]) => ({ key: k, state: encodeState(s) })));
    }
  }

  private async mergeIn(key: string, incoming: IndicatorState): Promise<void> {
    this.merged.inc();
    if (this.apply(key, incoming)) await this.persist(key);
  }

  private async coordinate(req: ReportRequest): Promise<ReportResponse> {
    const seen = this.recent.get(req.requestId);
    if (seen) return seen; // Gateway retry: the increment already happened.

    // Read-modify-write runs synchronously before the first await, so concurrent
    // reports on this node cannot lose updates; across nodes the CRDT merge does that job.
    const now = Date.now();
    const current = this.states.get(req.key) ?? emptyState(req.kind);
    this.states.set(req.key, {
      kind: current.kind,
      reports: gcounter.increment(current.reports, this.id),
      reporters: hll.add(current.reporters, req.reporter),
      firstSeen: Math.min(current.firstSeen, now),
      lastSeen: Math.max(current.lastSeen, now),
    });
    this.bump(req.key);
    this.coordinated.inc();
    await this.persist(req.key);

    const others = req.replicas.filter((r) => r !== this.id);
    const acks = 1 + (await this.replicate(req.key, others, this.opts.writeQuorum - 1));
    const response: ReportResponse = { acks, state: encodeState(this.states.get(req.key)!) };
    this.recent.set(req.requestId, response);
    if (this.recent.size > DEDUPE_WINDOW) this.recent.delete(this.recent.keys().next().value!);
    return response;
  }

  /** Sends the key's state to replicas; returns once `needed` acked. Laggards are retried by anti-entropy. */
  private async replicate(key: string, replicas: string[], needed: number): Promise<number> {
    const state = encodeState(this.states.get(key)!);
    const version = this.versions.get(key)!;
    const waiting = this.pending.get(key) ?? new Set<string>();
    for (const r of replicas) waiting.add(r);
    if (waiting.size) this.pending.set(key, waiting);

    const calls = replicas.map(async (r) => {
      const url = this.peers.get(r);
      if (!url) throw new Error(`unknown peer ${r}`);
      await rpc(`${url}/internal/merge`, { body: { entries: [{ key, state }] }, timeoutMs: this.opts.rpcTimeoutMs });
      this.acked(key, r, version);
    });
    const { ok } = await quorum(calls, needed);
    return ok.length;
  }

  private async antiEntropy(): Promise<void> {
    const byPeer = new Map<string, string[]>();
    for (const [key, replicas] of this.pending) for (const r of replicas) byPeer.set(r, [...(byPeer.get(r) ?? []), key]);

    await Promise.allSettled(
      [...byPeer].map(async ([peer, keys]) => {
        const url = this.peers.get(peer);
        if (!url) return;
        const sent = keys.map((key) => ({ key, version: this.versions.get(key)!, state: encodeState(this.states.get(key)!) }));
        await rpc(`${url}/internal/merge`, {
          body: { entries: sent.map(({ key, state }) => ({ key, state })) },
          timeoutMs: this.opts.rpcTimeoutMs * 5,
        });
        for (const { key, version } of sent) this.acked(key, peer, version);
      }),
    );
  }

  private dumpFor(node: string): Entry[] {
    const out: Entry[] = [];
    for (const [key, state] of this.states) {
      if (this.ring.preferenceList(key, this.opts.replication).includes(node)) out.push({ key, state: encodeState(state) });
    }
    return out;
  }
}
