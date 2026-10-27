#!/usr/bin/env bash
# End-to-end check of the Docker Compose stack: API, aggregated metrics,
# Prometheus scraping + alert rules, Grafana dashboard provisioning, durability.
set -euo pipefail

retry() { for _ in $(seq 1 60); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 2; done; echo "timed out: $*"; return 1; }

retry curl -fsS localhost:8080/healthz

echo "== report + check"
for i in 1 2 3 4 5; do
  curl -fsS -X POST localhost:8080/v1/report -H 'content-type: application/json' \
    -d "{\"indicator\": \"+91 98765 4321$i\", \"reporterId\": \"smoke-$i\"}" >/dev/null
  curl -fsS -X POST localhost:8080/v1/report -H 'content-type: application/json' \
    -d "{\"indicator\": \"https://kyc-update.example/x\", \"reporterId\": \"smoke-$i\"}" >/dev/null
done
verdict=$(curl -fsS 'localhost:8080/v1/check?indicator=kyc-update.example')
echo "$verdict"
echo "$verdict" | jq -e '.status == "suspicious" and .totalReports == 5' >/dev/null

echo "== aggregated gateway metrics"
docker compose exec -T gateway wget -qO- localhost:9100/metrics | grep -E '^gateway_requests_total\{op="report",outcome="ok"\} 10$'

echo "== Prometheus targets and rules"
retry bash -c "curl -fsS 127.0.0.1:9090/api/v1/targets | jq -e '[.data.activeTargets[] | select(.health == \"up\")] | length == 4'"
curl -fsS 127.0.0.1:9090/api/v1/rules | jq -e '[.data.groups[].rules[]] | length == 7' >/dev/null

echo "== Grafana dashboard"
retry curl -fsS 127.0.0.1:3000/api/health
curl -fsS -u "admin:$GRAFANA_ADMIN_PASSWORD" '127.0.0.1:3000/api/search?type=dash-db&query=ScamShield' | jq -e 'length == 1' >/dev/null

echo "== durability across a shard restart"
docker compose restart s1
retry curl -fsS 'localhost:8080/v1/check?indicator=kyc-update.example'
curl -fsS 'localhost:8080/v1/check?indicator=kyc-update.example' | jq -e '.totalReports == 5' >/dev/null

echo "smoke test passed"
