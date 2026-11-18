---
type: architecture
title: Rebuild shared harness metrics from source data
description: Export all harnesses as harness_* metrics with a harness label, and rebuild history from source data into fresh Prometheus storage.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [metrics, prometheus, migration]
---

# 0002. Rebuild shared harness metrics from source data

## Context and Problem Statement

The dashboard showed only OpenCode, using `opencode_*` metrics without a harness label. Pi support needs one dashboard with the same metrics for OpenCode v1, OpenCode v2, and Pi, and a filter by harness. Existing Prometheus samples cannot be relabeled after the fact.

## Decision Drivers

- The same metrics for every harness, with a Harness filter
- Consistent terminology: OpenCode and Pi are "harnesses"
- Totals that can be trusted, without mixing labeled and unlabeled history
- The source databases and session files still contain the history

## Considered Options

- Keep the `opencode_*` names and add a `harness` label to new samples
- Add new `harness_*` metrics and keep the old `opencode_*` series next to them
- Add new `harness_*` metrics and rebuild all history from the source data into fresh Prometheus storage

## Decision Outcome

Chosen option: new `harness_*` metrics, rebuilt from source data. Prometheus is derived storage, so the source data, not old samples, defines the history. The dashboard queries only `harness_*` metrics. Harness values are `opencode_v1`, `opencode_v2`, and `pi`.

## Consequences

- Good, because every panel and filter works the same way for every harness.
- Good, because the rebuild fixes earlier accounting problems, such as sessions counted again when they were updated.
- Bad, because history that exists only in the old Prometheus volume is lost unless that volume is kept.
- Neutral, because the old `prometheus_data` and `metrics_state` volumes are kept, unattached, for rollback until removed by hand.

## More Information

Metric names stay `harness_*` even though the project is named Harness Meter, so stored history keeps working. Accounting rules for the rebuilt metrics are in [0003](0003-use-a-durable-event-ledger-and-outbox.md), [0004](0004-count-all-recorded-pi-usage.md), [0005](0005-read-opencode-v1-tables-after-upgrade.md), and [0006](0006-count-completed-usage-regardless-of-cost.md).
