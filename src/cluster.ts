import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { Gateway } from "./gateway.js";
import { Shard } from "./shard.js";

/**
 * Local cluster launcher.
 *   node dist/cluster.js shard <id> <port>     one storage node
 *   node dist/cluster.js gateway <port>        gateway, forked across CPU cores
 * Topology comes from env: SHARDS="s1=http://127.0.0.1:7001,s2=...".
 */
const shards = Object.fromEntries(
  (process.env.SHARDS ?? "s1=http://127.0.0.1:7001,s2=http://127.0.0.1:7002,s3=http://127.0.0.1:7003")
    .split(",")
    .map((pair) => pair.split("=") as [string, string]),
);
const host = process.env.HOST ?? "127.0.0.1";
const [role, ...args] = process.argv.slice(2);

if (role === "shard") {
  const [id, port] = args as [string, string];
  const shard = new Shard({ id, dataDir: process.env.DATA_DIR ?? "data", nodes: Object.keys(shards) });
  shard.setPeers(shards);
  await shard.start(Number(port), host);
  const recovered = await shard.recover();
  console.log(`shard ${id} listening on ${port} (recovered ${recovered} entries from peers)`);
  process.on("SIGTERM", () => void shard.stop().then(() => process.exit(0)));
} else if (role === "gateway") {
  const port = Number(args[0] ?? 8080);
  const workers = Number(process.env.GATEWAY_WORKERS ?? availableParallelism());
  if (cluster.isPrimary && workers > 1) {
    // Workers share the listening socket; the primary spreads connections across them.
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on("exit", (w, code) => {
      if (code !== 0) cluster.fork();
    });
    console.log(`gateway listening on ${port} with ${workers} workers`);
  } else {
    const gateway = new Gateway({ shards });
    await gateway.start(port, host);
    await gateway.probe();
    process.on("SIGTERM", () => void gateway.stop().then(() => process.exit(0)));
  }
} else {
  console.error("usage: cluster.js shard <id> <port> | gateway <port>");
  process.exit(1);
}
