# Harness Meter

A read-only metrics collector and dashboard for coding harnesses. It currently supports [OpenCode](https://github.com/anomalyco/opencode) v1 and v2 SQLite databases and [Pi](https://pi.dev) session JSONL files. The exporter normalizes their usage into one Prometheus data model; Grafana provides a combined view with Harness, Provider, and Model filters.

## What the dashboard shows

- Session count, tokens, recorded cost, average daily cost, and cache hit rate: `cache_read / (input + cache_read + cache_write)`. Cache writes are prompt tokens that missed the cache, so they count as misses
- Token distribution and token/cost trends by provider and model
- Token and cost comparisons by harness
- A multi-select **Harness** filter (`opencode_v1`, `opencode_v2`, `pi`), followed by Provider and Model filters; each defaults to **All**

The dashboard is provisioned at `grafana/dashboards/harness.json`, shows the last 90 days by default, refreshes every minute, and keeps its existing Grafana UID so an existing provisioned dashboard updates in place. Filter options come from data in the selected time range, so widen the range to see older harnesses (for example, OpenCode v1 history).

## Metrics and accounting

The exporter writes these shared metric families:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `harness_usage_tokens` | `harness`, `provider`, `model`, `type` | Recorded tokens; `type` is `input`, `output`, `cache_read`, or `cache_write`. |
| `harness_usage_cost_usd` | `harness`, `provider`, `model` | Cost reported by the source, in USD. This is not necessarily the invoiced amount. |
| `harness_session_count` | `harness`, `provider`, `model` | One sample for each session with eligible usage, attributed to its first observed usage. |

Every eligible usage observation writes the four token types, including zero-valued types, so Harness/Provider/Model filters also discover cost-only usage. Zero-cost token usage is included. Missing provider/model attribution is labeled `unknown`; it is not guessed from a session's selected model. Zero-valued token samples do not change totals.

### OpenCode

- v1 stores messages in `session`/`message`; v2 in `session_v2`/`session_message`. The exporter detects which are present.
- Upgrading to v2 copies v1 history into the v2 tables with the same message IDs but keeps the v1 tables, which v2 no longer writes. The copy is not necessarily complete: in one real upgraded database, 139 completed v1 messages ($23.52) existed only in the v1 tables. The exporter therefore reads both. Messages in the v1 tables are labeled `opencode_v1`. Messages that exist only in the v2 tables are labeled `opencode_v2`, so migrated copies are not counted twice.
- A message that was incomplete in v1 and completed after the upgrade is exported from v2 as `opencode_v2`.
- Completed assistant messages with positive cost or token usage are counted. User, synthetic, idle, empty, and incomplete streaming messages are excluded.
- A session that started in v1 and continued in v2 is counted once, under `opencode_v1`. Its later messages count as `opencode_v2` usage.
- Separate database copies, such as an archived v1 database and a current v2 database, can be listed together. All v1 tables are read before any v2 table, and message identities are deduplicated across files. Configure every database before the initial import.

### Pi

The exporter reads session files under `~/.pi/agent/sessions/` by default (mounted read-only by Compose). It imports usage from assistant messages, tool results with nested model usage, standalone `usage` entries (such as cache warming), and usage attached to compaction and branch-summary entries. It includes all recorded branches, not just the current context.

Pi's `reasoning` is already included in `output`, and `cacheWrite1h` is already included in `cacheWrite`; neither is added a second time. Auxiliary Pi usage without model attribution remains visible under `unknown`. Pi's broader auxiliary usage can make its totals differ in coverage from OpenCode's assistant-message metrics.

Forks and clones copy earlier entries. Inherited usage is deduplicated across copies; a fork contributes a new session count when it records new usage. A session is counted once, at its first observed eligible usage. Pi's cross-file dashboard totals can therefore differ from the sum of Pi's individual per-file statistics.

### Delivery and source changes

The local SQLite state stores event identities, metrics-field fingerprints, Pi file cursors, and a durable metric outbox; transcript content is neither written to Prometheus nor included in fingerprints. Repeated polls and retries do not duplicate events. Sent metric points older than 730 days are pruned from the outbox by default to match Prometheus retention; event identities and session keys remain so rescans and forks can still be deduplicated. Points with the same labels and millisecond timestamp are aggregated before delivery. If a late event arrives after that point has already been sent, its sample is placed at the next free millisecond for that series to avoid a conflicting Prometheus timestamp.

Pi files are read incrementally, up to 64 MiB per file per cycle. Incomplete final lines are held until completed; file identity tracks moves, while truncations, replacements, header changes, and detected rewrites trigger a rescan with event deduplication. If an already-seen event's contents change, the exporter logs a conflict and retains the first imported payload rather than silently double-counting it. Deleted source events cannot retract historical Prometheus samples; use a clean rebuild to reconcile source rewrites or deletions.

## Quick start

Prerequisites: Docker and Docker Compose.

```bash
docker compose up -d --build
```

This starts:

- **Grafana 13.3.1**: http://localhost:3100. No login is required.
- **Prometheus 3.16.0**: http://localhost:9090

The exporter polls sources every 60 seconds and pushes metrics to Prometheus through its remote-write receiver. Initial import reads available source history, then incremental polling continues.

This is a local, single-user stack. Grafana has anonymous access with the Admin role, and its login form is disabled. Prometheus has no authentication. Both ports are therefore bound to `127.0.0.1` only. Do not expose them on other interfaces without first re-enabling Grafana authentication (remove the `GF_AUTH_*` settings) and protecting Prometheus.

Compose mounts these sources read-only:

| Source | Default host path | Container path |
| --- | --- | --- |
| OpenCode | `~/.local/share/opencode/opencode.db` (plus `-wal` and `-shm`) | `/data/opencode/` |
| Pi | `~/.pi/agent/sessions/` | `/data/pi-sessions/` |

Only the OpenCode database files are mounted, not the whole OpenCode data directory, which also contains `auth.json` credentials. All three SQLite files must exist; start OpenCode once before starting the stack. Set `OPENCODE_HOST_DIR` (the directory containing `opencode.db`) or `PI_SESSIONS_HOST_DIR` in the shell or a `.env` file to use other locations.

Missing sources are reported by Compose as an error instead of being created as empty root-owned directories. To run with only one harness, remove the other source's mounts in a Compose override and set its variable to empty. For example, for Pi only:

```yaml
# compose.override.yaml
services:
  metrics-exporter:
    volumes: !override
      - type: bind
        source: ${HOME}/.pi/agent/sessions
        target: /data/pi-sessions
        read_only: true
      - harness_metrics_state:/state
    environment:
      OPENCODE_DB: ""
```

If a configured source becomes unavailable at runtime, the exporter logs it and continues with the others.

## Configuration

The Compose defaults are in `docker-compose.yml`. Useful exporter environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_DB` | `/data/opencode/opencode.db` | Comma-separated container paths to OpenCode databases (v1, v2, or upgraded). Empty disables OpenCode. |
| `PI_SESSIONS_DIR` | `/data/pi-sessions` | Container path to the Pi session directory, scanned recursively. Empty disables Pi. |
| `STATE_DB` | `/state/metrics-state.db` | Durable event ledger, source cursors, watermarks, and outbox. |
| `PROMETHEUS_URL` | `http://prometheus:9090` | Prometheus remote-write receiver base URL. |
| `POLL_INTERVAL_MS` | `60000` | Delay between completed polling cycles; cycles do not overlap. |
| `BATCH_SIZE` | `500` | Maximum number of time series per remote-write request. |
| `METRIC_POINT_RETENTION_DAYS` | `730` | Age after which successfully delivered outbox points are pruned. Keep aligned with Prometheus retention. |

To also import an archived OpenCode database, mount it read-only and add it to `OPENCODE_DB`:

```yaml
# compose.override.yaml
services:
  metrics-exporter:
    volumes:
      - /path/to/archive/opencode.db:/data/archive/opencode.db:ro
    environment:
      OPENCODE_DB: /data/opencode/opencode.db,/data/archive/opencode.db
```

Prometheus has two-year retention and a 300-day out-of-order window (`prometheus.yml`); these are separate limits. If Prometheus permanently rejects samples (HTTP 4xx other than 429), for example because they are older than the out-of-order window, the exporter logs a warning and continues instead of retrying forever. Prometheus still stores the valid samples in that request. Network errors, 429, and 5xx responses are retried.

## Clean history rebuild and upgrade

The new dashboard reads only `harness_*` metrics. A clean rebuild from available source data is the preferred migration; legacy `opencode_*` metrics are neither translated nor queried by the unified dashboard.

The Compose file uses fresh `harness_prometheus_data` and `harness_metrics_state` volumes, while reusing `grafana_data`. On an existing deployment, run:

```bash
docker compose up -d --build
```

Compose creates the new Prometheus and exporter-state volumes automatically. The old `prometheus_data` and `metrics_state` volumes are left unattached as a rollback/archive copy; they are not automatically deleted. Verify the unified dashboard and historical totals before manually removing any old volumes. Compose names volumes after the project, which defaults to the name of the directory containing `docker-compose.yml`. If you clone or move the repository into a directory with a different name, set `COMPOSE_PROJECT_NAME` to the previous name (for example, in a `.env` file) to keep using the existing Grafana and Prometheus volumes. Otherwise Compose creates new, empty volumes. Do **not** use `docker compose down -v` for this migration—it also deletes Grafana data.

Before cutover, check that the source databases and Pi session files still contain the historical usage you want. Deleted or pruned source data cannot be recovered by re-importing. For live SQLite databases, the database, WAL, and SHM must be available together. If the old Prometheus store contains history absent from the source files, preserve that old volume; the clean rebuild cannot recreate those missing records.

To re-import after changing the configured source set, use fresh `harness_metrics_state` and `harness_prometheus_data` volumes. Keep the existing Grafana volume. Check Prometheus logs and the exporter logs for out-of-order or rejected samples before discarding the old volumes.

## Development

```bash
cd metrics
bun install --frozen-lockfile
bun test
bun run typecheck
```

Use Bun 1.4.4, matching the Docker image. Tests use isolated SQLite fixtures and temporary Pi JSONL sessions; the exporter integration tests use a local HTTP receiver. They do not modify real harness data or contact Prometheus.

## Decision records

Architecture decisions, such as how sources are read, how usage is counted and how the local stack is secured, are recorded as [MADR](https://adr.github.io/madr/) records in [`docs/decisions/`](docs/decisions/index.md). Read the relevant records before changing related code.

## Troubleshooting

- **No metrics appear:** Check `docker compose ps -a` and `docker compose logs --tail=100 metrics-exporter`. The first cycle logs the number of events imported per harness. Verify that each configured in-container path is mounted and readable.
- **`bind source path does not exist`:** A default source path is missing on the host. Create it (for example, start OpenCode once), point `OPENCODE_HOST_DIR`/`PI_SESSIONS_HOST_DIR` elsewhere, or disable that source as described above.
- **Remote-write failures:** On network errors, 429, or 5xx, the exporter keeps pending points and retries them before importing more source data. Check Prometheus logs and the remote-write URL.
- **Historical rows are rejected:** The exporter logs `not retried: Prometheus rejected these samples permanently`. Check the Prometheus out-of-order window and the source's timestamp range, then rebuild into fresh Prometheus and exporter-state volumes if needed.
- **A harness is missing from the filter:** The filter lists harnesses with data in the selected time range. Widen the range.
- **Pi history appears missing:** Check the recursive mount of `~/.pi/agent/sessions`, supported JSONL headers, exporter warnings for malformed lines, and whether the session files still exist.
- **Exporter exits with code 133:** Check `docker compose logs --tail=100 metrics-exporter`. If the log contains `embedder failed to suspend thread`, rebuild with `docker compose up -d --build`; the image pins Bun 1.4.4 to avoid the reproduced Bun 1.3.14 runtime crash. Do not delete volumes or reset exporter state for this error.
- **Dashboard does not open on port 3100:** Use `docker compose up -d` to start the full stack, including Grafana.

## Cleanup

To stop services without deleting data:

```bash
docker compose down
```

To remove every volume, including Prometheus history and Grafana settings:

```bash
docker compose down -v
```
