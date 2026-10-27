import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import { decodeState, encodeState, mergeState, statesEqual, type EncodedState, type IndicatorKind, type IndicatorState } from "./crdt.js";
import { HashRing } from "./hashring.js";
import { InvalidIndicator, keyedHash, MIN_SECRET_LENGTH, parseIndicator } from "./normalize.js";
import { quorum, rpc } from "./rpc.js";
import type { ReportResponse } from "./shard.js";
import { verdictOf, type Verdict } from "./verdict.js";

export interface GatewayOptions {
  /** Shard id -> base URL. */
  shards: Record<string, string>;
  /** HMAC secret for indicator and reporter keys. Every gateway must share it; shards never see it. */
  keySecret: string;
  replication?: number;
  writeQuorum?: number;
  readQuorum?: number;
  healthIntervalMs?: number;
  /** Consecutive failed probes before a shard is routed around (one slow probe is not an outage). */
  downAfter?: number;
  rpcTimeoutMs?: number;
  cacheTtlMs?: number;
  /**
   * Where metrics are registered. Pass prom-client's global registry when running
   * under node:cluster so the primary can aggregate every worker's metrics.
   */
  registry?: Registry;
  /** Reports a single reporter may burst, and how many it regains per minute. */
  reportBurst?: number;
  reportsPerMinute?: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

const MAX_TRACKED = 200_000;

/**
 * Stateless front door. Any number of gateway processes can run behind a load
 * balancer: all durable state lives on the shards, and the gateway only needs the
 * shard list to route each key to its replicas.
 */
export class Gateway {
  readonly app: FastifyInstance;
  private readonly ring: HashRing;
  private readonly shards: Map<string, string>;
  private readonly up = new Map<string, boolean>();
  private readonly probeFailures = new Map<string, number>();
  private readonly cache = new Map<string, { verdict: Verdict; expires: number }>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly opts: Required<Omit<GatewayOptions, "shards" | "keySecret" | "registry">>;
  private readonly keySecret: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly registry: Registry;
  private readonly m;

  constructor(options: GatewayOptions) {
    this.opts = {
      replication: options.replication ?? 3,
      writeQuorum: options.writeQuorum ?? 2,
      readQuorum: options.readQuorum ?? 2,
      healthIntervalMs: options.healthIntervalMs ?? 500,
      downAfter: options.downAfter ?? 2,
      rpcTimeoutMs: options.rpcTimeoutMs ?? 1000,
      cacheTtlMs: options.cacheTtlMs ?? 1000,
      reportBurst: options.reportBurst ?? 10,
      reportsPerMinute: options.reportsPerMinute ?? 10,
    };
    // R + W > N guarantees every quorum read overlaps the latest quorum write.
    if (this.opts.readQuorum + this.opts.writeQuorum <= this.opts.replication) {
      throw new Error("readQuorum + writeQuorum must exceed replication for read-your-writes");
    }
    if (options.keySecret.length < MIN_SECRET_LENGTH) throw new Error(`keySecret must be at least ${MIN_SECRET_LENGTH} characters`);
    this.keySecret = options.keySecret;
    this.shards = new Map(Object.entries(options.shards));
    this.ring = new HashRing(this.shards.keys());
    for (const id of this.shards.keys()) this.up.set(id, true);

    this.registry = options.registry ?? new Registry();
    if (!options.registry) collectDefaultMetrics({ register: this.registry, prefix: "gateway_" });
    const r = [this.registry];
    this.m = {
      requests: new Counter({ name: "gateway_requests_total", help: "API requests", labelNames: ["op", "outcome"] as const, registers: r }),
      readRepairs: new Counter({ name: "gateway_read_repairs_total", help: "Stale replicas repaired on read", registers: r }),
      latency: new Histogram({
        name: "gateway_request_duration_seconds",
        help: "API latency",
        labelNames: ["op"] as const,
        buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
        registers: r,
      }),
    };

    this.app = Fastify({ logger: false });
    this.app.get<{ Querystring: { indicator?: string; kind?: IndicatorKind } }>("/v1/check", async (req, reply) => {
      const end = this.m.latency.startTimer({ op: "check" });
      try {
        const ind = this.parse(req.query.indicator, req.query.kind);
        if (!ind) return reply.code(400).send({ error: "invalid_indicator" });
        const verdict = await this.check(ind.key);
        if (!verdict) return reply.code(503).send({ error: "read_quorum_unavailable" });
        return { indicator: ind.canonical, kind: ind.kind, ...verdict };
      } finally {
        end();
      }
    });

    this.app.post<{ Body: { indicator?: string; kind?: IndicatorKind; reporterId?: string } }>("/v1/report", async (req, reply) => {
      const end = this.m.latency.startTimer({ op: "report" });
      try {
        const { indicator, kind, reporterId } = req.body ?? {};
        const ind = this.parse(indicator, kind);
        if (!ind || typeof reporterId !== "string" || reporterId.length === 0 || reporterId.length > 128) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        // Reporter ids are keyed-hashed before leaving the gateway.
        const reporter = keyedHash(this.keySecret, "reporter", reporterId);
        if (!this.take(reporter)) {
          this.m.requests.inc({ op: "report", outcome: "rate_limited" });
          return reply.code(429).send({ error: "rate_limited" });
        }
        const result = await this.report(ind.key, ind.kind, reporter);
        if (!result) return reply.code(503).send({ error: "write_quorum_unavailable" });
        return reply.code(202).send({ indicator: ind.canonical, kind: ind.kind, acks: result.acks, ...verdictOf(decodeState(result.state)) });
      } finally {
        end();
      }
    });

    this.app.get("/healthz", async () => ({ status: "ok", shardsUp: [...this.up].filter(([, v]) => v).map(([k]) => k) }));
    this.app.get("/metrics", async (_req, reply) => {
      reply.header("content-type", this.registry.contentType);
      return this.registry.metrics();
    });
  }

  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    const address = await this.app.listen({ port, host });
    this.timer = setInterval(() => void this.probe(), this.opts.healthIntervalMs);
    return address;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.app.close();
  }

  /**
   * Health-checks every shard once. A shard is marked down after `downAfter`
   * consecutive failures (or `force`, used when the caller knows it is gone) and
   * back up on its first success.
   */
  async probe(force = false): Promise<void> {
    await Promise.all(
      [...this.shards].map(async ([id, url]) => {
        try {
          await rpc(`${url}/healthz`, { timeoutMs: this.opts.healthIntervalMs });
          this.probeFailures.set(id, 0);
          this.up.set(id, true);
        } catch {
          const failures = (this.probeFailures.get(id) ?? 0) + 1;
          this.probeFailures.set(id, failures);
          if (force || failures >= this.opts.downAfter) this.up.set(id, false);
        }
      }),
    );
  }

  private parse(raw: unknown, kind: unknown) {
    if (typeof raw !== "string" || raw.length > 2048) return undefined;
    if (kind !== undefined && kind !== "url" && kind !== "phone") return undefined;
    try {
      return parseIndicator(raw, this.keySecret, kind);
    } catch (err) {
      if (err instanceof InvalidIndicator) return undefined;
      throw err;
    }
  }

  private replicasFor(key: string): string[] {
    return this.ring.preferenceList(key, this.opts.replication, (id) => this.up.get(id) === true);
  }

  private async report(key: string, kind: IndicatorKind, reporter: string): Promise<ReportResponse | undefined> {
    const replicas = this.replicasFor(key);
    if (replicas.length < this.opts.writeQuorum) {
      this.m.requests.inc({ op: "report", outcome: "no_quorum" });
      return undefined;
    }
    this.cache.delete(key);
    const requestId = randomUUID();
    // Try each replica as coordinator in turn. A retry with the same requestId on the
    // same coordinator is de-duplicated; failover to a *different* coordinator is
    // at-least-once and can double count a report whose first attempt was applied.
    for (const coordinator of replicas) {
      try {
        const res = await rpc<ReportResponse>(`${this.shards.get(coordinator)}/internal/report`, {
          body: { requestId, key, kind, reporter, replicas },
          timeoutMs: this.opts.rpcTimeoutMs * 2,
        });
        if (!res || res.acks < this.opts.writeQuorum) break;
        this.m.requests.inc({ op: "report", outcome: "ok" });
        return res;
      } catch {
        this.up.set(coordinator, false);
      }
    }
    this.m.requests.inc({ op: "report", outcome: "no_quorum" });
    return undefined;
  }

  private async check(key: string): Promise<Verdict | undefined> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      this.m.requests.inc({ op: "check", outcome: "cache_hit" });
      return cached.verdict;
    }

    const replicas = this.replicasFor(key);
    const read = (id: string) =>
      rpc<EncodedState>(`${this.shards.get(id)}/internal/state/${key}`, { timeoutMs: this.opts.rpcTimeoutMs }).then((s) => ({
        id,
        state: s && decodeState(s),
      }));
    // Ask exactly R replicas; only fall back to the rest if some of them fail.
    const R = this.opts.readQuorum;
    const first = await quorum(replicas.slice(0, R).map(read), R);
    let ok = first.ok;
    if (ok.length < R && replicas.length > R) ok = [...ok, ...(await quorum(replicas.slice(R).map(read), R - ok.length)).ok];
    if (ok.length < R) {
      this.m.requests.inc({ op: "check", outcome: "no_quorum" });
      return undefined;
    }

    const found = ok.map((o) => o.value.state).filter((s): s is IndicatorState => s !== undefined);
    const merged = found.length ? found.reduce(mergeState) : undefined;
    if (merged) this.readRepair(key, merged, ok.map((o) => o.value));

    const verdict = verdictOf(merged);
    if (this.cache.size >= MAX_TRACKED) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { verdict, expires: Date.now() + this.opts.cacheTtlMs });
    this.m.requests.inc({ op: "check", outcome: "ok" });
    return verdict;
  }

  /** Pushes the merged state to replicas that returned something older (fire-and-forget). */
  private readRepair(key: string, merged: IndicatorState, seen: Array<{ id: string; state: IndicatorState | undefined }>): void {
    const encoded = encodeState(merged);
    for (const { id, state } of seen) {
      if (state && statesEqual(state, merged)) continue;
      this.m.readRepairs.inc();
      rpc(`${this.shards.get(id)}/internal/merge`, { body: { entries: [{ key, state: encoded }] }, timeoutMs: this.opts.rpcTimeoutMs }).catch(() => {});
    }
  }

  /** Token bucket per hashed reporter id. */
  private take(reporter: string): boolean {
    const now = Date.now();
    const perMs = this.opts.reportsPerMinute / 60_000;
    const b = this.buckets.get(reporter) ?? { tokens: this.opts.reportBurst, updated: now };
    b.tokens = Math.min(this.opts.reportBurst, b.tokens + (now - b.updated) * perMs);
    b.updated = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    this.buckets.delete(reporter);
    this.buckets.set(reporter, b);
    if (this.buckets.size > MAX_TRACKED) this.buckets.delete(this.buckets.keys().next().value!);
    return true;
  }
}
