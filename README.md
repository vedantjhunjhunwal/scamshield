# ScamShield

[![CI](https://github.com/vedantjhunjhunwal/scamshield/actions/workflows/ci.yml/badge.svg)](https://github.com/vedantjhunjhunwal/scamshield/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6.svg)](tsconfig.json)

ScamShield is a distributed, crowdsourced reputation service for scam links and fraud phone numbers.

- **Source code:** https://github.com/vedantjhunjhunwal/scamshield
- **Bug reports:** https://github.com/vedantjhunjhunwal/scamshield/issues
- **Architecture:** [How it works](#how-it-works)
- **Operations:** [Observability](#observability) · [Deployment](#deployment)
- **Benchmarks:** [Performance](#performance)

People forward a suspicious SMS link or the number that called them; anyone can then check
that link or number before paying, clicking or sharing an OTP. ScamShield is built so the
check stays fast and correct while the system grows by adding nodes.

It provides:

- a horizontally sharded store: indicators are placed on nodes by a consistent-hash ring with
  virtual nodes, so adding a node moves only about 1/N of the keys
- quorum replication (N = 3, W = 2, R = 2): a write is acknowledged by two replicas, and every
  read overlaps the latest write because R + W > N
- conflict-free merging: report counts are grow-only counters and distinct reporters are
  HyperLogLog sketches, so concurrent reports on different nodes merge without locks and
  replicas converge whatever the delivery order
- crash safety: a write-ahead log with group commit (one `fsync` per batch of concurrent
  writes), snapshot compaction, peer recovery on restart, background anti-entropy and read
  repair
- abuse resistance: verdicts depend on *distinct* reporters rather than report volume, each
  reporter is rate-limited, and reporter ids are hashed before leaving the gateway
- privacy by default: shards store an HMAC-SHA256 key of the canonical link or number, never the
  raw value, and without the gateway's secret those keys cannot be reversed by hashing every
  possible phone number
- observability: Prometheus metrics aggregated across gateway workers, seven alert rules with unit
  tests, and a provisioned Grafana dashboard
- delivery: GitHub Actions tests every change end to end, publishes the image to GHCR from `main`,
  and a Terraform-backed workflow rolls a chosen image out to AWS

## How it works

```
             clients
                │
        ┌───────▼────────┐   stateless; forks one worker per CPU core,
        │    gateway     │   rate-limits reporters, routes by key,
        └──┬─────┬────┬──┘   enforces quorums, repairs stale replicas
           │     │    │
     ┌─────▼┐ ┌──▼───┐ ┌▼─────┐
     │  s1  │ │  s2  │ │  s3  │ … sN   each key lives on 3 nodes chosen by
     │ WAL  │ │ WAL  │ │ WAL  │        the hash ring; nodes push missed
     └──────┘ └──────┘ └──────┘        updates to each other (anti-entropy)
```

1. **Normalise and key.** `+91 98765 43210`, `09876543210` and `9876543210` map to one E.164
   number; `https://www.Prize.example/claim?id=7` maps to `prize.example`, and look-alike Unicode
   domains are converted to punycode. The gateway then derives the storage key with
   HMAC-SHA256 under `INDICATOR_KEY_SECRET` (see [Security](#security)).
2. **Route.** The gateway hashes the indicator and takes the first three healthy nodes
   clockwise on the ring. A node is routed around after consecutive failed health probes.
3. **Write.** The first replica coordinates: it increments its own counter slot, adds the
   reporter to the HyperLogLog, makes the change durable in its WAL and pushes the merged state
   to the other replicas, then replies once two copies hold it. A retried request is
   de-duplicated by request id.
4. **Read.** The gateway reads two replicas, merges what they return and pushes the merged
   state back to any replica that was behind.
5. **Verdict.** `unknown` → `reported` → `suspicious` (5+ distinct reporters) → `scam` (20+).

## Installation

ScamShield requires Node.js 22.13 or later.

```bash
git clone https://github.com/vedantjhunjhunwal/scamshield
cd scamshield
npm ci
npm run build
```

Run a local cluster of three shards and a gateway:

```bash
export SHARDS="s1=http://127.0.0.1:7001,s2=http://127.0.0.1:7002,s3=http://127.0.0.1:7003"
export INDICATOR_KEY_SECRET="$(openssl rand -hex 32)"
node dist/cluster.js shard s1 7001 &
node dist/cluster.js shard s2 7002 &
node dist/cluster.js shard s3 7003 &
node dist/cluster.js gateway 8080
```

Or with Docker Compose, which also starts Prometheus (127.0.0.1:9090) and Grafana (127.0.0.1:3000):

```bash
cp .env.example .env   # then fill in INDICATOR_KEY_SECRET (32+ chars) and GRAFANA_ADMIN_PASSWORD
docker compose up --build
```

## Usage

```bash
# Report a link
curl -X POST localhost:8080/v1/report \
  -H 'content-type: application/json' \
  -d '{"indicator": "https://kyc-update.example/verify", "reporterId": "user-123"}'

# Check a number
curl 'localhost:8080/v1/check?indicator=%2B91%2098765%2043210'
```

```json
{
  "indicator": "+919876543210",
  "kind": "phone",
  "status": "suspicious",
  "distinctReporters": 7,
  "totalReports": 9,
  "firstSeen": "2026-10-27T18:02:11.000Z",
  "lastSeen": "2026-10-27T18:40:53.000Z"
}
```

| Endpoint | Description |
| --- | --- |
| `POST /v1/report` | Report an indicator. `202` once a write quorum holds it, `429` when rate-limited, `503` without quorum |
| `GET /v1/check?indicator=` | Verdict from a read quorum. `503` without quorum |
| `GET /healthz` | Gateway health and the shards it currently routes to |
| `GET /metrics` | Prometheus metrics (gateway and shards) |

## Security

- **Keyed indicator hashes.** Indian mobile numbers span only about 10^10 values, so a plain
  SHA-256 of a number can be reversed by hashing them all. Keys are HMAC-SHA256 under
  `INDICATOR_KEY_SECRET`, which only gateways hold; shard data alone reveals nothing. Reporter
  ids are keyed the same way, in a separate domain.
- **Fail closed.** Gateways refuse to start without a secret of at least 32 characters, before
  forking any workers.
- **Abuse controls.** Verdicts count distinct reporters, and each reporter is rate-limited.
- **Deployment.** Only the API port is public. There is no SSH (access is through AWS SSM),
  IMDSv2 is enforced, the disk is encrypted, and secrets are generated by Terraform into SSM
  SecureString parameters rather than living in the repository, CI or user data.

## Observability

Prometheus scrapes every shard and the gateway. Gateway workers each keep their own counters, so
the gateway's primary process aggregates them and serves the sum on `:9100/metrics`.

[`observability/alerts.yml`](observability/alerts.yml) defines seven alerts:

| Alert | Fires when |
| --- | --- |
| `ShardDown` | a shard has been unreachable for 1 minute |
| `GatewayDown` | the gateway has been unreachable for 1 minute |
| `QuorumFailures` | over 1% of requests fail for lack of quorum for 5 minutes |
| `CheckLatencyHigh` | p95 check latency is above 100 ms for 10 minutes |
| `ReportLatencyHigh` | p95 report latency is above 250 ms for 10 minutes |
| `ReplicationBacklog` | a shard holds over 1,000 unacknowledged replica updates for 10 minutes |
| `ReportAbuseSpike` | rate-limited reports stay above 5/s for 5 minutes |

The rules have unit tests ([`alerts.test.yml`](observability/alerts.test.yml)) run by `promtool`
in CI. The Grafana dashboard ([`scamshield.json`](observability/grafana/dashboards/scamshield.json))
is provisioned automatically and shows throughput by outcome, p50/p95/p99 latency, quorum
failure ratio, rate-limited reports, read repairs, replication backlog, WAL group commits and
memory.

## Deployment

```
pull request ──► CI: unit + cluster tests · promtool rule tests · terraform validate
                     · docker compose end-to-end smoke test
merge to main ─► CI publishes ghcr.io/vedantjhunjhunwal/scamshield:<sha> and :latest
Deploy (manual) ► Terraform (infra/terraform) applies the chosen tag to AWS, then smoke-tests /healthz
```

[`infra/terraform`](infra/terraform) provisions one EC2 instance in `ap-south-1`. It has an IAM
role for SSM, a security group exposing only port 8080, and generated secrets in SSM. Its boot
script runs the stack with [`deploy/compose.prod.yml`](deploy/compose.prod.yml).

One-time setup for the Deploy workflow:

1. Create an S3 bucket for Terraform state and add its name as the `TF_STATE_BUCKET` secret.
2. Create an IAM role that GitHub OIDC can assume from this repository and add its ARN as `AWS_DEPLOY_ROLE_ARN`.
3. Make the GHCR package public, or add registry credentials to the boot script.
4. Run **Actions → Deploy** with an image tag.

To reach Grafana, run the command in the `grafana_tunnel` Terraform output, then open `localhost:3000`.

## Performance

`npm run build && npm run bench` starts three shards and a two-worker gateway on one machine and
drives them with 100 concurrent connections for 15 s per scenario, across 100,000 distinct
indicators and random reporters:

| Scenario | Throughput | p50 | p99 | Errors |
| --- | --- | --- | --- | --- |
| Report (quorum write, W = 2 of N = 3) | 1,353 req/s | 60 ms | 252 ms | 0 |
| Check (quorum read, R = 2 of N = 3) | 3,597 req/s | 24 ms | 76 ms | 0 |

Measured on a single 4-vCPU Intel Xeon host (Node.js 22.22) with every process and the load
generator sharing the same CPUs, so this is a single-host baseline rather than a multi-node
result. Raw output is in [`bench-results.json`](bench-results.json). Gateways are stateless and
shards own disjoint key ranges, so capacity is designed to grow by adding processes and nodes;
multi-host scaling has not been benchmarked yet.

## Testing

```bash
npm test          # 74 tests
npm run coverage  # with coverage
```

The suite runs real multi-node clusters in-process on ephemeral ports and checks, among other things:

- 2,000 concurrent reports through three gateways lose no updates, and all replicas converge
- writes continue with one node down, and the node catches up after restart
- a stale replica is repaired on read
- data survives a full-cluster restart from the write-ahead logs
- requests are refused (`503`) when a quorum is unavailable
- CRDT merges are commutative, associative and idempotent (property tests on random states)
- the hash ring stays balanced and moves only about 1/N of keys when a node joins
- shards never receive raw phone numbers, links or reporter ids
- gateways refuse weak or missing key secrets

Every pull request also runs `promtool` unit tests for the alert rules, `terraform fmt` and
`validate`, and an end-to-end test ([`scripts/smoke.sh`](scripts/smoke.sh)). The end-to-end test
starts the full Compose stack, reports and checks indicators, confirms Prometheus is scraping
every target with all rules loaded, confirms Grafana has loaded the dashboard, and restarts a
shard to confirm no data is lost.

## Limitations

ScamShield is a working prototype, not a production deployment. Known limitations:

- Cluster membership is static configuration, not discovered through gossip.
- If a coordinator fails mid-write, the gateway's failover to another coordinator is
  at-least-once, so one report can be counted twice.
- Rate limits apply per gateway worker, not cluster-wide.
- The Terraform deployment runs all shards on one EC2 instance. It survives process failures
  but not the loss of that host; production would place shards in separate availability zones.
- Changing `INDICATOR_KEY_SECRET` changes every key, so key rotation would need a re-keying migration.
- Verdict thresholds are fixed numbers, not a trained model.

## License

[MIT](LICENSE) © Vedant Jhunjhunwala
