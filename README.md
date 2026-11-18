# OpenCode Metrics Dashboard

A complete metrics collection and visualization stack for [OpenCode](https://github.com/anomalyco/opencode), consisting of:

- **Metrics Exporter**: A Bun/TypeScript service that polls the OpenCode SQLite database every 60 seconds and exports metrics to Prometheus via the remote write protocol
- **Prometheus**: Time-series database configured with 2-year retention and support for out-of-order samples (covers full OpenCode history)
- **Grafana**: Auto-refreshing visualization dashboard (every 60 seconds) with provider and model filters, displaying token usage, costs, and session analytics

## Prerequisites

- Docker and Docker Compose
- OpenCode v1 or v2 with an active `opencode.db` database at `~/.local/share/opencode/opencode.db` (v2.3.0 has been checked locally)
- The database's `-wal` and `-shm` files must exist for the default Docker Compose mounts; start OpenCode before starting this stack

## Quick Start

```bash
docker compose up -d
```

This starts three services:

- **Grafana**: http://localhost:3100 (default login: `admin` / `admin`)
- **Prometheus**: http://localhost:9090

The metrics exporter automatically detects your OpenCode database schema and pushes metrics to Prometheus, waiting 60 seconds between export cycles. The Grafana dashboard auto-refreshes every 60 seconds to display live data.

## OpenCode v1 and v2 compatibility

No OpenCode plugin or API server is required. The exporter reads SQLite in read-only mode:

| Version | Session table | Message table | Assistant/model fields |
| --- | --- | --- | --- |
| v1 | `session` | `message` | `data.role`, `data.modelID`, `data.providerID` |
| v2 | `session_v2` | `session_message` | `type` column, `data.model.id`, `data.model.providerID` |

- When both schemas exist after an upgrade, only v2 is exported.
- Completed assistant messages with positive cost **or** input, output, or cache token usage are exported. Zero-cost subscription/free-model usage is included; streaming messages, empty messages, and user/synthetic/idle messages are excluded.
- Session metrics require at least one eligible assistant message. Session model/provider labels fall back to the earliest eligible assistant message. On older v1 schemas without session cost/model columns, these values are derived from messages.
- Existing metric names, token types, and labels are unchanged, so the provisioned Grafana dashboard requires no migration. Initial backfill reads all available eligible history without a fixed date cutoff, subject to Prometheus retention.
- v1 and v2 use separate exporter checkpoints. The first v2 cycle backfills v2 history even if v1 checkpoints already exist; subsequent cycles resume from the v2 checkpoints.

To rebuild an existing deployment:

```bash
docker compose up -d --build
```

Keep the `metrics_state` volume to preserve checkpoints. Existing v1 checkpoints are not reset: previously skipped zero-cost usage older than a checkpoint is not automatically backfilled. If you need a completely fresh historical import, use fresh exporter state **and** Prometheus storage; resetting only checkpoints replays data into the existing time-series database. The exporter does not reconcile or delete samples already exported before an OpenCode migration.

## Dashboard

The Grafana dashboard provides real-time insights into your OpenCode usage with automatic 60-second synchronization:

![OpenCode Metrics Dashboard](./docs/dashboard_example.png)

**Features:**
- **Totals**: Session count, total tokens, and cache hit rate
- **Cost Metrics**: Total spend and daily average cost
- **Token Usage**: Time-series graphs of token consumption by provider and model
- **Token Distribution**: Pie charts showing breakdown by token type and model
- **Dynamic Filters**: Provider and model dropdowns for focused analysis

## Architecture

```
OpenCode DB (read-only)
    ↓
Metrics Exporter (polls every 60s)
    ↓
Prometheus (remote write receiver)
    ↓
Grafana (auto-refreshes every 60s)
```

## Configuration

Edit `docker-compose.yml` to adjust:

- `POLL_INTERVAL_MS`: Delay between completed export cycles (default: 60000ms); cycles never overlap
- `OPENCODE_DB`: Database path inside the exporter container (default: `/data/opencode.db`); adjust the bind mounts as well if your host database lives elsewhere
- `BATCH_SIZE`: Number of metrics per remote write batch (default: 500)
- `GF_SECURITY_ADMIN_PASSWORD`: Grafana admin password (default: `admin`)
- Retention times: Update Prometheus command flags or Grafana time ranges as needed

## Volumes

- `prometheus_data`: Prometheus time-series storage
- `grafana_data`: Grafana dashboards, settings, and plugins
- `metrics_state`: Exporter watermark state (prevents duplicate exports)

## Development

```bash
cd metrics
bun install --frozen-lockfile
bun test
bun run typecheck
```

Use Bun 1.4.4, matching the Docker image. The typecheck command uses native `bun check`; no separate TypeScript compiler installation or download is required.

Tests use isolated SQLite fixtures for both schemas and a local HTTP receiver to verify compressed remote writes, retries, and checkpoint advancement. They do not modify your OpenCode database or contact Prometheus.

## Technical Decisions

- **Schema detection rather than a version setting:** Inspect table names on each export cycle, prefer v2 when legacy tables remain, and normalize both layouts into the same metric rows. No OpenCode SDK dependency is needed.
- **Usage is not conditional on spend:** Completed calls with token usage are meaningful even when the reported cost is zero. Waiting for completion avoids exporting intermediate streaming usage.
- **Independent v2 checkpoints:** A legacy timestamp must not suppress the initial v2 backfill. Existing v1 state is retained.
- **Pinned runtime and reproducible installs:** Pin both the Bun runtime and `bun-types` declarations to 1.4.4 so typechecking matches the deployed APIs, and use a committed lockfile with `--frozen-lockfile`. Bun 1.3.14 reproducibly crashes during an idle wait on the tested ARM64/Linux 7.0 Docker host (`embedder failed to suspend thread`, exit 133); 1.4.4 passes the same check. No dependencies were added to `package.json` for the migration.

## Troubleshooting

- **Exporter keeps restarting with exit 133:** Check `docker compose logs --tail=100 metrics-exporter`. If the log contains `embedder failed to suspend thread`, rebuild with `docker compose up -d --build`; the Dockerfile pins Bun 1.4.4 to avoid the reproduced Bun 1.3.14 runtime crash. Do not delete data volumes or reset checkpoints for this error.
- **Dashboard does not open on port 3100:** Check `docker compose ps -a`. Running `docker compose up -d --build metrics-exporter` starts only the exporter and its Prometheus dependency, not Grafana. Use `docker compose up -d` to start the full stack.

## Cleanup

To stop all services:

```bash
docker compose down
```

To remove volumes and data:

```bash
docker compose down -v
```
