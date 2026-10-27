// Starts a local 3-shard cluster + gateway from dist/, then load-tests writes and reads.
// Usage: npm run build && npm run bench
import autocannon from "autocannon";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";

const DURATION = Number(process.env.BENCH_SECONDS ?? 15);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 100);
const POOL = 100_000; // distinct indicators
const GATEWAY_WORKERS = process.env.GATEWAY_WORKERS ?? "2";
const SHARDS = "s1=http://127.0.0.1:7001,s2=http://127.0.0.1:7002,s3=http://127.0.0.1:7003";
const GATEWAY = "http://127.0.0.1:8080";

const dataDir = mkdtempSync(join(tmpdir(), "scamshield-bench-"));
const env = { ...process.env, SHARDS, DATA_DIR: dataDir, GATEWAY_WORKERS };
const procs = [
  ...["s1", "s2", "s3"].map((id, i) => spawn("node", ["--no-warnings", "dist/cluster.js", "shard", id, String(7001 + i)], { env, stdio: "ignore" })),
  spawn("node", ["--no-warnings", "dist/cluster.js", "gateway", "8080"], { env, stdio: "ignore" }),
];
const cleanup = () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
};
process.on("exit", cleanup);

async function waitUp(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

const rand = (n) => Math.floor(Math.random() * n);
const indicator = () => `scam-${rand(POOL)}.example`;

function run(title, opts) {
  return new Promise((resolve, reject) => {
    autocannon({ url: GATEWAY, connections: CONNECTIONS, duration: DURATION, ...opts }, (err, r) => {
      if (err) return reject(err);
      resolve({
        scenario: title,
        requestsPerSec: Math.round(r.requests.average),
        p50ms: r.latency.p50,
        p99ms: r.latency.p99,
        total: r.requests.total,
        non2xx: r.non2xx,
        errors: r.errors + r.timeouts,
        statusCodes: Object.fromEntries(Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [k, v.count])),
      });
    });
  });
}

await Promise.all([7001, 7002, 7003].map((p) => waitUp(`http://127.0.0.1:${p}/healthz`)));
await waitUp(`${GATEWAY}/healthz`);
await new Promise((r) => setTimeout(r, 1000)); // let every gateway worker finish its first health probe

const results = [];
results.push(
  await run("report (quorum write, W=2 of N=3)", {
    requests: [
      {
        method: "POST",
        path: "/v1/report",
        headers: { "content-type": "application/json" },
        setupRequest: (req) => ({ ...req, body: JSON.stringify({ indicator: indicator(), reporterId: `r-${rand(1e9)}` }) }),
      },
    ],
  }),
);
results.push(
  await run("check (quorum read, R=2 of N=3)", {
    requests: [{ setupRequest: (req) => ({ ...req, path: `/v1/check?indicator=${indicator()}` }) }],
  }),
);

const host = { cpus: availableParallelism(), model: cpus()[0]?.model, node: process.version, gatewayWorkers: Number(GATEWAY_WORKERS), connections: CONNECTIONS, seconds: DURATION };
console.log(JSON.stringify(host));
console.table(results);
writeFileSync("bench-results.json", JSON.stringify({ host, results }, null, 2) + "\n");
cleanup();
process.exit(0);
