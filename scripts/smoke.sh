#!/usr/bin/env bash
# End-to-end check of the Docker Compose stack: API, aggregated metrics,
# Prometheus scraping + alert rules, Grafana dashboard provisioning, durability.
set -Eeuo pipefail

STEP="startup"
LAST=""
# On failure, surface the step and last response as a GitHub annotation.
trap 'echo "::error title=smoke test failed::step: $STEP | last output: ${LAST:0:300}"' ERR
step() { STEP="$1"; echo "== $1"; }
capture() { LAST=$("$@" 2>&1) || { echo "$LAST"; return 1; }; echo "$LAST"; }

retry() { for _ in $(seq 1 60); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 2; done; echo "timed out: $*"; return 1; }

retry curl -fsS localhost:8080/healthz

step "report + check"
for i in 1 2 3 4 5; do
  curl -fsS -X POST localhost:8080/v1/report -H 'content-type: application/json' \
    -d "{\"indicator\": \"+91 98765 4321$i\", \"reporterId\": \"smoke-$i\"}" >/dev/null
  curl -fsS -X POST localhost:8080/v1/report -H 'content-type: application/json' \
    -d "{\"indicator\": \"https://kyc-update.example/x\", \"reporterId\": \"smoke-$i\"}" >/dev/null
done
capture curl -fsS 'localhost:8080/v1/check?indicator=kyc-update.example'
echo "$LAST" | jq -e '.status == "suspicious" and .totalReports == 5' >/dev/null

step "aggregated gateway metrics"
capture docker compose exec -T gateway wget -qO- http://127.0.0.1:9100/metrics >/dev/null
echo "$LAST" | grep -E '^gateway_requests_total\{op="report",outcome="ok"\} 10$'

step "Prometheus targets and rules"
retry bash -c "curl -fsS 127.0.0.1:9090/api/v1/targets | jq -e '[.data.activeTargets[] | select(.health == \"up\")] | length == 4'"
curl -fsS 127.0.0.1:9090/api/v1/rules | jq -e '[.data.groups[].rules[]] | length == 7' >/dev/null

step "Grafana dashboard"
retry curl -fsS 127.0.0.1:3000/api/health
curl -fsS -u "admin:$GRAFANA_ADMIN_PASSWORD" '127.0.0.1:3000/api/search?type=dash-db&query=ScamShield' | jq -e 'length == 1' >/dev/null

step "durability across a shard restart"
docker compose restart s1
retry curl -fsS 'localhost:8080/v1/check?indicator=kyc-update.example'
capture curl -fsS 'localhost:8080/v1/check?indicator=kyc-update.example' >/dev/null
echo "$LAST" | jq -e '.totalReports == 5' >/dev/null

echo "smoke test passed"
