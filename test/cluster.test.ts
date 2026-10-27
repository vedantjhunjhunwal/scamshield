import { afterEach, describe, expect, it } from "vitest";
import { gcounter, hll } from "../src/crdt.js";
import { HashRing } from "../src/hashring.js";
import { parseIndicator } from "../src/normalize.js";
import { get, post, TestCluster } from "./harness.js";

let cluster: TestCluster;
afterEach(() => cluster?.stop());

const report = (gw: string, indicator: string, reporterId: string) => post(`${gw}/v1/report`, { indicator, reporterId });
const check = (gw: string, indicator: string) => get(`${gw}/v1/check?indicator=${encodeURIComponent(indicator)}`);
const replicasOf = (c: TestCluster, indicator: string) => new HashRing(c.ids).preferenceList(parseIndicator(indicator).key, 3);

describe("cluster: reads and writes", () => {
  it("returns a write on the very next read (read-your-writes via R + W > N)", async () => {
    cluster = await new TestCluster(5).start();
    const [gw] = cluster.gatewayUrls as [string];
    expect((await check(gw, "kyc-update.example")).body.status).toBe("unknown");
    const r = await report(gw, "https://www.kyc-update.example/verify", "user-1");
    expect(r.status).toBe(202);
    expect(r.body.acks).toBeGreaterThanOrEqual(2);
    expect((await check(gw, "kyc-update.example")).body).toMatchObject({ status: "reported", totalReports: 1, distinctReporters: 1 });
  });

  it("escalates verdicts by distinct reporters, not raw report volume", async () => {
    cluster = await new TestCluster(3).start();
    const [gw] = cluster.gatewayUrls as [string];
    for (let i = 0; i < 30; i++) await report(gw, "9876543210", "same-spammer");
    expect((await check(gw, "+91 98765 43210")).body).toMatchObject({ status: "reported", totalReports: 30, distinctReporters: 1 });

    for (let i = 0; i < 5; i++) await report(gw, "9876543210", `victim-${i}`);
    expect((await check(gw, "9876543210")).body.status).toBe("suspicious");
    for (let i = 5; i < 25; i++) await report(gw, "9876543210", `victim-${i}`);
    expect((await check(gw, "09876543210")).body.status).toBe("scam");
  });

  it("stores each key on exactly N of the cluster's nodes (sharding)", async () => {
    cluster = await new TestCluster(5).start();
    const [gw] = cluster.gatewayUrls as [string];
    const domains = Array.from({ length: 40 }, (_, i) => `scam-${i}.example`);
    await Promise.all(domains.map((d) => report(gw, d, "u")));
    for (const d of domains) {
      const key = parseIndicator(d).key;
      expect(await cluster.converged(key, replicasOf(cluster, d))).toBe(true);
      const holders = cluster.ids.filter((id) => cluster.shards.get(id)!.stateOf(key));
      expect(holders.sort()).toEqual(replicasOf(cluster, d).sort());
    }
  });
});

describe("cluster: concurrency", () => {
  it("loses no updates under 2,000 concurrent reports through 3 gateways", async () => {
    cluster = await new TestCluster(3).start(3);
    const indicator = "lottery-winner.example";
    const reporters = 400;
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) => report(cluster.gatewayUrls[i % 3]!, indicator, `reporter-${i % reporters}`)),
    );

    const key = parseIndicator(indicator).key;
    expect(await cluster.converged(key, cluster.ids)).toBe(true);
    for (const id of cluster.ids) {
      const s = cluster.shards.get(id)!.stateOf(key)!;
      expect(gcounter.value(s.reports)).toBe(2000);
      expect(Math.abs(hll.estimate(s.reporters) - reporters) / reporters).toBeLessThan(0.05);
    }
    const body = (await check(cluster.gatewayUrls[0]!, indicator)).body;
    expect(body).toMatchObject({ status: "scam", totalReports: 2000 });
  });

  it("de-duplicates a retried request on the coordinator", async () => {
    cluster = await new TestCluster(3).start();
    const ind = parseIndicator("retry.example");
    const [coordinator] = replicasOf(cluster, "retry.example") as [string];
    const body = { requestId: "fixed-id", key: ind.key, kind: ind.kind, reporter: "r", replicas: cluster.ids };
    await post(`${cluster.urls[coordinator]}/internal/report`, body);
    const second = await post(`${cluster.urls[coordinator]}/internal/report`, body);
    expect(gcounter.value(second.body.state.reports)).toBe(1);
  });
});

describe("cluster: failures", () => {
  it("keeps accepting writes with one replica down, then heals it on restart", async () => {
    cluster = await new TestCluster(3).start();
    const [gw] = cluster.gatewayUrls as [string];
    const indicator = "refund-desk.example";
    await report(gw, indicator, "before-crash");

    await cluster.kill("s2");
    for (let i = 0; i < 50; i++) expect((await report(gw, indicator, `during-${i}`)).status).toBe(202);
    expect((await check(gw, indicator)).body.totalReports).toBe(51);

    await cluster.restart("s2");
    const key = parseIndicator(indicator).key;
    expect(await cluster.converged(key, cluster.ids)).toBe(true);
    expect(gcounter.value(cluster.shards.get("s2")!.stateOf(key)!.reports)).toBe(51);
  });

  it("rejects writes and reads it cannot make durable when quorum is lost", async () => {
    cluster = await new TestCluster(3).start();
    const [gw] = cluster.gatewayUrls as [string];
    await cluster.kill("s1");
    await cluster.kill("s2");
    expect((await report(gw, "x.example", "u")).status).toBe(503);
    expect((await check(gw, "x.example")).status).toBe(503);
  });

  it("repairs a stale replica on read", async () => {
    cluster = await new TestCluster(3).start(1, { readQuorum: 3 });
    const [gw] = cluster.gatewayUrls as [string];
    const indicator = "parcel-fee.example";
    await cluster.kill("s3");
    for (let i = 0; i < 5; i++) await report(gw, indicator, `u${i}`);
    // Bring s3 back *without* recovery and stop the others' anti-entropy from racing the read.
    for (const id of ["s1", "s2"]) (cluster.shards.get(id) as any).pending.clear();
    await cluster.restart("s3", false);
    const key = parseIndicator(indicator).key;
    expect(cluster.shards.get("s3")!.stateOf(key)).toBeUndefined();

    expect((await check(gw, indicator)).body.totalReports).toBe(5);
    expect(await cluster.converged(key, cluster.ids, 2000)).toBe(true);
    const metrics = await (await fetch(`${gw}/metrics`)).text();
    expect(metrics).toMatch(/gateway_read_repairs_total \d+/);
  });

  it("survives a full-cluster restart from the write-ahead logs", async () => {
    cluster = await new TestCluster(3).start();
    const [gw] = cluster.gatewayUrls as [string];
    for (let i = 0; i < 10; i++) await report(gw, "otp-help.example", `u${i}`);
    for (const id of cluster.ids) await cluster.kill(id);
    for (const id of cluster.ids) await cluster.restart(id, false);
    expect((await check(gw, "otp-help.example")).body).toMatchObject({ totalReports: 10, status: "suspicious" });
  });
});

describe("gateway: input handling and abuse controls", () => {
  it("rate-limits a single reporter", async () => {
    cluster = await new TestCluster(3).start(1, { reportBurst: 3, reportsPerMinute: 1 });
    const [gw] = cluster.gatewayUrls as [string];
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await report(gw, "spam.example", "eager")).status);
    expect(codes).toEqual([202, 202, 202, 429, 429]);
    expect((await report(gw, "spam.example", "someone-else")).status).toBe(202);
  });

  it.each([
    [{ indicator: "javascript:alert(1)", reporterId: "u" }],
    [{ indicator: "ok.example" }],
    [{ indicator: "ok.example", reporterId: "" }],
    [{ indicator: "ok.example", reporterId: "u", kind: "email" }],
    [{}],
  ])("rejects bad report %j", async (body) => {
    cluster = await new TestCluster(3).start();
    expect((await post(`${cluster.gatewayUrls[0]}/v1/report`, body)).status).toBe(400);
  });

  it("rejects a bad check", async () => {
    cluster = await new TestCluster(3).start();
    expect((await get(`${cluster.gatewayUrls[0]}/v1/check?indicator=localhost`)).status).toBe(400);
    expect((await get(`${cluster.gatewayUrls[0]}/v1/check`)).status).toBe(400);
  });

  it("refuses configurations without overlapping quorums", async () => {
    const { Gateway } = await import("../src/gateway.js");
    expect(() => new Gateway({ shards: {}, replication: 3, writeQuorum: 1, readQuorum: 2 })).toThrow(/readQuorum/);
  });

  it("exposes health and Prometheus metrics on gateway and shards", async () => {
    cluster = await new TestCluster(3).start();
    const [gw] = cluster.gatewayUrls as [string];
    await report(gw, "a.example", "u");
    expect((await get(`${gw}/healthz`)).body.shardsUp).toHaveLength(3);
    expect(await (await fetch(`${gw}/metrics`)).text()).toContain('gateway_requests_total{op="report",outcome="ok"} 1');
    const shardMetrics = await (await fetch(`${cluster.urls.s1}/metrics`)).text();
    expect(shardMetrics).toContain("shard_keys 1");
    expect(shardMetrics).toContain("shard_wal_flushes");
  });
});
